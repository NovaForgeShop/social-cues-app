import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type { Comment, ModeratorPermission, Post } from '@devvit/web/server';
import type {
  ActionResponse,
  AdsManagerHandoff,
  AuditEvent,
  CommentPage,
  ErrorResponse,
  ModerationAction,
  ModeratorThreadComment,
  ModeratorThreadState,
  PublicThreadComment,
  PublicThreadState,
  ThreadState,
} from '../../shared/api';
import {
  canPerformModerationAction,
  getModerationCapabilities,
  moderationPermissionError,
} from '../core/moderation';
import {
  COMMAND_THREAD_POST_DATA,
  hasCommandThreadPostData,
  isRegisteredCommandThread,
  lastSignalKey,
  registerCommandThread,
  signalCountKey,
} from '../core/thread-registry';

const COMMENT_LIMIT = 100;
const COMMENT_PROBE_LIMIT = COMMENT_LIMIT + 1;

type ModeratorContext = {
  username: string;
  permissions: ModeratorPermission[];
  isModerator: boolean;
};

type LastSignal = ModeratorThreadState['signalSummary']['lastSignal'];

export const api = new Hono();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown Reddit API error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModerationAction(value: unknown): value is ModerationAction {
  return value === 'approve' || value === 'remove' || value === 'spam' || value === 'lock' || value === 'unlock';
}

function isReplyTargetId(value: string): value is `t1_${string}` | `t3_${string}` {
  return value.startsWith('t1_') || value.startsWith('t3_');
}

function isPostId(value: string): value is `t3_${string}` {
  return value.startsWith('t3_');
}

function isCommentId(value: string): value is `t1_${string}` {
  return value.startsWith('t1_');
}

function parseAuditEvent(value: unknown): AuditEvent | null {
  if (!isRecord(value)) return null;
  const { at, actor, action, targetId, detail } = value;
  if (
    typeof at !== 'string' ||
    typeof actor !== 'string' ||
    typeof action !== 'string' ||
    typeof targetId !== 'string' ||
    typeof detail !== 'string'
  ) return null;
  return { at, actor, action, targetId, detail };
}

function parseLastSignal(value: string | undefined): LastSignal {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    const { kind, at } = parsed;
    if ((kind !== 'comment' && kind !== 'report') || typeof at !== 'string') return null;
    return { kind, at };
  } catch {
    return null;
  }
}

function parseSignalCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function moderatorContext(): Promise<ModeratorContext> {
  const currentUser = await reddit.getCurrentUser();
  const username = currentUser?.username ?? context.username ?? 'anonymous';
  const permissions = currentUser
    ? await currentUser.getModPermissionsForSubreddit(context.subredditName).catch(() => [])
    : [];
  return { username, permissions, isModerator: permissions.length > 0 };
}

async function requireModerator(): Promise<ModeratorContext> {
  const moderator = await moderatorContext();
  if (!moderator.isModerator) throw new Error('A subreddit moderator account is required for this action.');
  return moderator;
}

async function ensureRegisteredCommandThread(postId: string): Promise<void> {
  if (!isPostId(postId)) throw new Error('The Reddit command thread ID is invalid.');
  if (await isRegisteredCommandThread(postId)) return;

  if (hasCommandThreadPostData(context.postData)) {
    await registerCommandThread(postId);
    return;
  }

  // Older playtest installs can lose their Redis registration while the Reddit post survives.
  // Only a moderator may recover a legacy post, and only when the post was created by this app.
  const [moderator, post] = await Promise.all([
    moderatorContext(),
    reddit.getPostById(postId),
  ]);
  if (!moderator.isModerator || post.authorName !== context.appSlug) {
    throw new Error('This post is not a registered Social Cues command thread.');
  }

  await reddit.mergePostData(postId, COMMAND_THREAD_POST_DATA);
  await registerCommandThread(postId);
}

async function requireModerationPermission(action: ModerationAction): Promise<ModeratorContext> {
  const moderator = await requireModerator();
  if (!canPerformModerationAction(action, moderator.permissions)) {
    throw new Error(moderationPermissionError(action));
  }
  return moderator;
}

function auditKey(postId: string): string {
  return `social-cues:audit:${postId}`;
}

async function recordAudit(event: AuditEvent): Promise<void> {
  const postId = context.postId;
  if (!postId) return;
  await redis.zAdd(auditKey(postId), { score: Date.parse(event.at), member: JSON.stringify(event) });
  const count = await redis.zCard(auditKey(postId));
  if (count > 100) await redis.zRemRangeByRank(auditKey(postId), 0, count - 101);
}

async function recentAudit(postId: string): Promise<AuditEvent[]> {
  const rows = await redis.zRange(auditKey(postId), -20, -1);
  return rows.reverse().flatMap((row) => {
    try {
      const event = parseAuditEvent(JSON.parse(row.member));
      return event ? [event] : [];
    } catch {
      return [];
    }
  });
}

function serializePublicComment(comment: Comment): PublicThreadComment {
  const removed = comment.removed || comment.spam;
  return {
    id: comment.id,
    authorName: comment.authorName || '[deleted]',
    body: removed ? '[removed]' : comment.body || '',
    createdAt: comment.createdAt.toISOString(),
    parentId: comment.parentId,
    score: comment.score,
    permalink: comment.permalink,
    locked: comment.locked,
    removed,
  };
}

function serializeModeratorComment(comment: Comment): ModeratorThreadComment {
  return {
    id: comment.id,
    authorName: comment.authorName || '[deleted]',
    body: comment.body || '',
    createdAt: comment.createdAt.toISOString(),
    parentId: comment.parentId,
    score: comment.score,
    permalink: comment.permalink,
    locked: comment.locked,
    removed: comment.removed,
    approved: comment.approved,
    spam: comment.spam,
    reports: comment.numReports,
    reportReasons: [...comment.userReportReasons, ...comment.modReportReasons].slice(0, 8),
  };
}

function adsManagerHandoff(post: Post): AdsManagerHandoff {
  const ineligibleReason = post.removed || post.spam
    ? 'Removed or spam-marked threads are not eligible for an Ads Manager handoff.'
    : post.archived
      ? 'Archived threads are not eligible for an Ads Manager handoff.'
      : null;
  return {
    url: 'https://ads.reddit.com/',
    eligible: ineligibleReason === null,
    ineligibleReason,
    liveAdsApiEnabled: false,
    note: 'This opens Reddit Ads Manager only. Social Cues does not create campaigns, set budgets, or spend money.',
  };
}

function commentPage(returned: number, hasMore: boolean): CommentPage {
  return {
    sort: 'new',
    limit: COMMENT_LIMIT,
    returned,
    hasMore,
    isPartial: hasMore,
  };
}

function repliedParentIds(comments: Comment[], audit: AuditEvent[]): Set<string> {
  const appUsername = context.appSlug;
  return new Set([
    ...comments.filter((item) => item.authorName === appUsername).map((item) => item.parentId),
    ...audit.filter((event) => event.action === 'reply').map((event) => event.targetId),
  ]);
}

function countUnanswered(comments: Comment[], repliedParents: Set<string>): number {
  const appUsername = context.appSlug;
  return comments.filter((item) => item.authorName !== appUsername && !repliedParents.has(item.id)).length;
}

async function publicSignalSummary(postId: string): Promise<PublicThreadState['signalSummary']> {
  const commentEvents = await redis.get(signalCountKey(postId, 'comment'));
  return { commentEvents: parseSignalCount(commentEvents) };
}

async function moderatorSignalSummary(postId: string): Promise<ModeratorThreadState['signalSummary']> {
  const [commentEvents, reportEvents, lastSignal] = await Promise.all([
    redis.get(signalCountKey(postId, 'comment')),
    redis.get(signalCountKey(postId, 'report')),
    redis.get(lastSignalKey(postId)),
  ]);
  return {
    commentEvents: parseSignalCount(commentEvents),
    reportEvents: parseSignalCount(reportEvents),
    lastSignal: parseLastSignal(lastSignal),
  };
}

async function threadState(): Promise<ThreadState> {
  const postId = context.postId;
  if (!postId) throw new Error('Open Social Cues from its Reddit thread before managing replies.');
  await ensureRegisteredCommandThread(postId);

  const listing = reddit.getComments({
    postId,
    sort: 'new',
    limit: COMMENT_PROBE_LIMIT,
    pageSize: COMMENT_LIMIT,
  });
  const [post, fetchedComments, moderator] = await Promise.all([
    reddit.getPostById(postId),
    listing.all(),
    moderatorContext(),
  ]);
  const comments = fetchedComments.slice(0, COMMENT_LIMIT);
  const hasMore = fetchedComments.length > COMMENT_LIMIT || listing.hasMore;
  const page = commentPage(comments.length, hasMore);
  const handoff = adsManagerHandoff(post);

  if (!moderator.isModerator) {
    const signalSummary = await publicSignalSummary(postId);
    const publicComments = comments.map(serializePublicComment);
    return {
      status: 'ok',
      postId,
      subredditName: context.subredditName,
      username: moderator.username,
      isModerator: false,
      thread: {
        title: post.title,
        permalink: post.permalink,
        locked: post.locked,
        removed: post.removed || post.spam,
      },
      comments: publicComments,
      summary: {
        loadedComments: publicComments.length,
        unansweredLoaded: countUnanswered(comments, repliedParentIds(comments, [])),
      },
      signalSummary,
      commentPage: page,
      adsManagerHandoff: handoff,
    };
  }

  const [audit, signalSummary] = await Promise.all([
    recentAudit(postId),
    moderatorSignalSummary(postId),
  ]);
  const moderatorComments = comments.map(serializeModeratorComment);
  return {
    status: 'ok',
    postId,
    subredditName: context.subredditName,
    username: moderator.username,
    isModerator: true,
    moderatorPermissions: moderator.permissions,
    moderationCapabilities: getModerationCapabilities(moderator.permissions),
    thread: {
      title: post.title,
      permalink: post.permalink,
      locked: post.locked,
      approved: post.approved,
      removed: post.removed,
      spam: post.spam,
    },
    comments: moderatorComments,
    summary: {
      loadedComments: moderatorComments.length,
      reportedLoaded: moderatorComments.filter((item) => item.reports > 0).length,
      removedLoaded: moderatorComments.filter((item) => item.removed || item.spam).length,
      unansweredLoaded: countUnanswered(comments, repliedParentIds(comments, audit)),
    },
    signalSummary,
    commentPage: page,
    adsManagerHandoff: handoff,
    audit,
  };
}

async function targetForThread(targetId: string): Promise<Comment | Post> {
  const postId = context.postId;
  if (!postId) throw new Error('Thread context is missing.');
  await ensureRegisteredCommandThread(postId);
  if (targetId === postId) return reddit.getPostById(postId);
  if (!isCommentId(targetId)) throw new Error('The target must be this thread or one of its comments.');
  const comment = await reddit.getCommentById(targetId);
  if (comment.postId !== postId) throw new Error('That comment does not belong to this Social Cues thread.');
  return comment;
}

api.get('/init', async (c) => {
  try {
    return c.json<ThreadState>(await threadState());
  } catch (error) {
    return c.json<ErrorResponse>({ status: 'error', message: errorMessage(error) }, 400);
  }
});

api.get('/comments', async (c) => {
  try {
    return c.json<ThreadState>(await threadState());
  } catch (error) {
    return c.json<ErrorResponse>({ status: 'error', message: errorMessage(error) }, 400);
  }
});

api.post('/reply', async (c) => {
  try {
    const moderator = await requireModerator();
    const input = await c.req.json<unknown>();
    if (!isRecord(input)) throw new Error('Reply request must be a JSON object.');
    const targetId = typeof input.targetId === 'string' ? input.targetId : context.postId || '';
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (input.confirm !== 'REPLY_APPROVED') throw new Error('Explicit reply approval is required.');
    if (!text || text.length > 10000) throw new Error('Reply text must be between 1 and 10,000 characters.');
    if (!isReplyTargetId(targetId)) throw new Error('Reply target is invalid.');
    await targetForThread(targetId);
    const rateKey = `social-cues:reply-rate:${context.postId}:${moderator.username}`;
    const count = await redis.incrBy(rateKey, 1);
    if (count === 1) await redis.expire(rateKey, 60);
    if (count > 10) throw new Error('Reply limit reached. Wait one minute before posting again.');
    const reply = await reddit.submitComment({ id: targetId, text, runAs: 'APP' });
    await recordAudit({
      at: new Date().toISOString(),
      actor: moderator.username,
      action: 'reply',
      targetId,
      detail: `Posted app-attributed reply ${reply.id}`,
    });
    return c.json<ActionResponse>({ status: 'ok', message: 'Reply posted by the Social Cues app.', state: await threadState() });
  } catch (error) {
    return c.json<ErrorResponse>({ status: 'error', message: errorMessage(error) }, 400);
  }
});

api.post('/moderate', async (c) => {
  try {
    const input = await c.req.json<unknown>();
    if (!isRecord(input)) throw new Error('Moderation request must be a JSON object.');
    const targetId = typeof input.targetId === 'string' ? input.targetId : '';
    if (input.confirm !== 'MODERATION_APPROVED') throw new Error('Explicit moderation approval is required.');
    if (!isModerationAction(input.action)) throw new Error('Unsupported moderation action.');
    const action = input.action;
    const moderator = await requireModerationPermission(action);
    const target = await targetForThread(targetId);
    if (action === 'approve') await target.approve();
    if (action === 'remove') await target.remove(false);
    if (action === 'spam') await target.remove(true);
    if (action === 'lock') await target.lock();
    if (action === 'unlock') await target.unlock();
    await recordAudit({
      at: new Date().toISOString(),
      actor: moderator.username,
      action,
      targetId,
      detail: `Moderator approved ${action} for thread-bound target`,
    });
    return c.json<ActionResponse>({ status: 'ok', message: `${action} completed.`, state: await threadState() });
  } catch (error) {
    return c.json<ErrorResponse>({ status: 'error', message: errorMessage(error) }, 400);
  }
});
