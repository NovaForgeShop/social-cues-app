import { Hono } from 'hono';
import { redis } from '@devvit/web/server';
import type { OnCommentCreateRequest, OnCommentReportRequest, TriggerResponse } from '@devvit/web/shared';
import {
  isRegisteredCommandThread,
  lastSignalKey,
  signalCountKey,
} from '../core/thread-registry';
import type { SignalKind } from '../core/thread-registry';

export const triggers = new Hono();

async function recordSignal(kind: SignalKind, postId: string, commentId: string) {
  if (!postId || !commentId) return;
  if (!(await isRegisteredCommandThread(postId))) return;
  await redis.incrBy(signalCountKey(postId, kind), 1);
  await redis.set(lastSignalKey(postId), JSON.stringify({ kind, commentId, at: new Date().toISOString() }));
}

triggers.post('/on-comment-create', async (c) => {
  const input = await c.req.json<OnCommentCreateRequest>();
  if (input.comment) await recordSignal('comment', input.comment.postId, input.comment.id);
  return c.json<TriggerResponse>({}, 200);
});

triggers.post('/on-comment-report', async (c) => {
  const input = await c.req.json<OnCommentReportRequest>();
  if (input.comment) await recordSignal('report', input.comment.postId, input.comment.id);
  return c.json<TriggerResponse>({}, 200);
});
