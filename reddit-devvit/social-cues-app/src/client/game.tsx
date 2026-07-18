import './index.css';

import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { navigateTo } from '@devvit/web/client';
import type {
  ActionResponse,
  ErrorResponse,
  ModerationAction,
  ModerationCapabilities,
  ModeratorThreadComment,
  ThreadComment,
  ThreadState,
} from '../shared/api';

type Filter = 'all' | 'reported' | 'unanswered' | 'removed';
type PendingModeration = { targetId: string; targetLabel: string; action: ModerationAction };

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body = (await response.json()) as T | ErrorResponse;
  if (!response.ok || (typeof body === 'object' && body !== null && 'status' in body && body.status === 'error')) {
    throw new Error((body as ErrorResponse).message || `Request failed: ${response.status}`);
  }
  return body as T;
}

function isModeratorComment(comment: ThreadComment): comment is ModeratorThreadComment {
  return 'reports' in comment;
}

function CommentCard({
  comment,
  canReply,
  moderationCapabilities,
  onReply,
  onModerate,
}: {
  comment: ThreadComment;
  canReply: boolean;
  moderationCapabilities: ModerationCapabilities | null;
  onReply: (comment: ThreadComment) => void;
  onModerate: (comment: ThreadComment, action: ModerationAction) => void;
}) {
  const moderatorComment = isModeratorComment(comment) ? comment : null;
  const reports = moderatorComment?.reports ?? 0;
  return (
    <article className={`comment-card ${reports > 0 ? 'reported' : ''}`}>
      <div className="comment-head">
        <div>
          <strong>u/{comment.authorName}</strong>
          <span>{new Date(comment.createdAt).toLocaleString()}</span>
        </div>
        <div className="status-row">
          {reports > 0 && <span className="pill danger">{reports} report{reports === 1 ? '' : 's'}</span>}
          {comment.removed && <span className="pill danger">removed</span>}
          {moderatorComment?.spam && <span className="pill danger">spam</span>}
          {moderatorComment?.approved && <span className="pill good">approved</span>}
          {comment.locked && <span className="pill neutral">locked</span>}
        </div>
      </div>
      <p className="comment-body">{comment.body}</p>
      {moderatorComment && moderatorComment.reportReasons.length > 0 && (
        <p className="report-copy">Reports: {moderatorComment.reportReasons.join(', ')}</p>
      )}
      <div className="comment-tools">
        <button onClick={() => navigateTo(comment.permalink)}>View</button>
        {canReply && <button onClick={() => onReply(comment)}>Reply</button>}
        {moderatorComment && moderationCapabilities?.approve && !moderatorComment.approved && (
          <button onClick={() => onModerate(comment, 'approve')}>Approve</button>
        )}
        {moderatorComment && moderationCapabilities?.remove && !comment.removed && (
          <button className="danger-button" onClick={() => onModerate(comment, 'remove')}>Remove</button>
        )}
        {moderatorComment && moderationCapabilities?.spam && !moderatorComment.spam && (
          <button className="danger-button" onClick={() => onModerate(comment, 'spam')}>Spam</button>
        )}
        {moderatorComment && moderationCapabilities?.[comment.locked ? 'unlock' : 'lock'] && (
          <button onClick={() => onModerate(comment, comment.locked ? 'unlock' : 'lock')}>
            {comment.locked ? 'Unlock' : 'Lock'}
          </button>
        )}
      </div>
    </article>
  );
}

export const App = () => {
  const [state, setState] = useState<ThreadState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [replyTarget, setReplyTarget] = useState<ThreadComment | null>(null);
  const [replyText, setReplyText] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingModeration, setPendingModeration] = useState<PendingModeration | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setState(await api<ThreadState>('/api/comments'));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Thread could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    api<ThreadState>('/api/comments')
      .then((nextState) => {
        if (active) setState(nextState);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Thread could not be loaded.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const repliedParents = useMemo(() => {
    const audit = state?.isModerator ? state.audit : [];
    return new Set([
      ...(state?.comments || []).filter((item) => item.authorName === 'social-cues-app').map((item) => item.parentId),
      ...audit.filter((event) => event.action === 'reply').map((event) => event.targetId),
    ]);
  }, [state]);

  const comments = useMemo(() => (state?.comments || []).filter((comment) => {
    if (filter === 'reported') return isModeratorComment(comment) && comment.reports > 0;
    if (filter === 'removed') return comment.removed || (isModeratorComment(comment) && comment.spam);
    if (filter === 'unanswered') return comment.authorName !== 'social-cues-app' && !repliedParents.has(comment.id);
    return true;
  }), [state, filter, repliedParents]);

  const postReply = async () => {
    if (!replyTarget || !replyText.trim()) return;
    try {
      const result = await api<ActionResponse>('/api/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: replyTarget.id, text: replyText, confirm: 'REPLY_APPROVED' }),
      });
      setState(result.state);
      setReplyTarget(null);
      setReplyText('');
      setNotice(result.message);
    } catch (replyError) {
      setError(replyError instanceof Error ? replyError.message : 'Reply failed.');
    }
  };

  const performModeration = async (targetId: string, action: ModerationAction) => {
    try {
      const result = await api<ActionResponse>('/api/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, action, confirm: 'MODERATION_APPROVED' }),
      });
      setState(result.state);
      setNotice(result.message);
      setPendingModeration(null);
    } catch (moderationError) {
      setError(moderationError instanceof Error ? moderationError.message : 'Moderation action failed.');
    }
  };

  const moderate = (comment: ThreadComment, action: ModerationAction) => {
    setPendingModeration({ targetId: comment.id, targetLabel: `comment by u/${comment.authorName}`, action });
  };

  const moderateThread = (action: 'lock' | 'unlock') => {
    if (!state?.isModerator || !state.moderationCapabilities[action]) return;
    setPendingModeration({ targetId: state.postId, targetLabel: 'entire command thread', action });
  };

  if (loading && !state) return <main className="loading-screen">Loading community signals...</main>;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark">SC</span><div><strong>Social Cues</strong><span>Community command</span></div></div>
        <div className="header-actions">
          <button onClick={() => void load()} disabled={loading}>Refresh</button>
          {state && <button onClick={() => navigateTo(state.thread.permalink)}>Open thread</button>}
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice success">{notice}</div>}

      {state && <>
        <section className="thread-band">
          <div>
            <span className="eyebrow">r/{state.subredditName}</span>
            <h1>{state.thread.title}</h1>
            <p>{state.isModerator ? `Moderator tools active for u/${state.username}.` : 'Read-only public view. Moderator reports and action history are private.'}</p>
          </div>
          <div className="thread-actions">
            {state.isModerator && state.moderationCapabilities[state.thread.locked ? 'unlock' : 'lock'] && (
              <button onClick={() => moderateThread(state.thread.locked ? 'unlock' : 'lock')}>
                {state.thread.locked ? 'Unlock thread' : 'Lock thread'}
              </button>
            )}
            <button
              className="signal-button"
              onClick={() => state.adsManagerHandoff.eligible && navigateTo(state.adsManagerHandoff.url)}
              disabled={!state.adsManagerHandoff.eligible}
              title={state.adsManagerHandoff.ineligibleReason ?? 'Open Reddit Ads Manager'}
            >
              Open Ads Manager
            </button>
          </div>
        </section>

        <section className="metric-strip">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><strong>{state.summary.loadedComments}</strong><span>Loaded</span></button>
          {state.isModerator && <button className={filter === 'reported' ? 'active' : ''} onClick={() => setFilter('reported')}><strong>{state.summary.reportedLoaded}</strong><span>Reported in window</span></button>}
          <button className={filter === 'unanswered' ? 'active' : ''} onClick={() => setFilter('unanswered')}><strong>{state.summary.unansweredLoaded}</strong><span>Unanswered in window</span></button>
          {state.isModerator && <button className={filter === 'removed' ? 'active' : ''} onClick={() => setFilter('removed')}><strong>{state.summary.removedLoaded}</strong><span>Removed in window</span></button>}
        </section>

        <section className={`coverage-band ${state.commentPage.isPartial ? 'partial' : ''}`}>
          <strong>{state.commentPage.isPartial ? 'Partial comment window' : 'Complete comment window'}</strong>
          <p>
            {state.commentPage.isPartial
              ? `Showing the newest ${state.commentPage.returned} comments. Older comments are not loaded.`
              : `All ${state.commentPage.returned} comments are loaded.`}
          </p>
        </section>

        <section className="signal-summary">
          <div>
            <span className="eyebrow">Registered thread signals</span>
            <h2>Aggregate activity</h2>
          </div>
          <dl>
            <div><dt>Comment events</dt><dd>{state.signalSummary.commentEvents}</dd></div>
            {state.isModerator && <div><dt>Report events</dt><dd>{state.signalSummary.reportEvents}</dd></div>}
            {state.isModerator && <div><dt>Last signal</dt><dd>{state.signalSummary.lastSignal ? `${state.signalSummary.lastSignal.kind} - ${new Date(state.signalSummary.lastSignal.at).toLocaleString()}` : 'None'}</dd></div>}
          </dl>
        </section>

        <section className={`ad-guardrail ${state.adsManagerHandoff.eligible ? '' : 'ineligible'}`}>
          <div>
            <strong>{state.adsManagerHandoff.eligible ? 'Ads Manager handoff available' : 'Ads Manager handoff unavailable'}</strong>
            <p>{state.adsManagerHandoff.ineligibleReason ?? state.adsManagerHandoff.note}</p>
          </div>
          <span className="pill neutral">No automatic spend</span>
        </section>

        <section className={`content-grid ${state.isModerator ? '' : 'public'}`}>
          <div className="comment-list">
            <div className="section-head"><div><h2>Conversation</h2><p>{comments.length} loaded item{comments.length === 1 ? '' : 's'} in this view</p></div></div>
            {comments.length ? comments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                canReply={state.isModerator}
                moderationCapabilities={state.isModerator ? state.moderationCapabilities : null}
                onReply={setReplyTarget}
                onModerate={moderate}
              />
            )) : <div className="empty-state">Nothing needs attention in this view.</div>}
          </div>

          {state.isModerator && <aside className="audit-panel">
            <h2>Moderator action history</h2>
            <p>Only IDs and moderator actions are retained. Comment bodies are not copied into the audit log.</p>
            <div className="audit-list">
              {state.audit.length ? state.audit.map((event, index) => <div key={`${event.at}-${index}`}><strong>{event.action}</strong><span>{event.actor} - {new Date(event.at).toLocaleString()}</span><small>{event.targetId}</small></div>) : <div className="empty-state">No Social Cues actions yet.</div>}
            </div>
          </aside>}
        </section>
      </>}

      {replyTarget && <div className="modal-backdrop" role="presentation">
        <section className="reply-modal" role="dialog" aria-modal="true" aria-labelledby="reply-title">
          <div className="section-head"><div><h2 id="reply-title">Reply to u/{replyTarget.authorName}</h2><p>Posts visibly as the Social Cues app.</p></div><button onClick={() => setReplyTarget(null)}>Close</button></div>
          <blockquote>{replyTarget.body.slice(0, 260)}</blockquote>
          <textarea value={replyText} onChange={(event) => setReplyText(event.target.value)} maxLength={10000} placeholder="Write the approved reply..." />
          <div className="modal-actions"><span>{replyText.length}/10000</span><button className="signal-button" onClick={() => void postReply()} disabled={!replyText.trim()}>Post approved reply</button></div>
        </section>
      </div>}

      {pendingModeration && <div className="modal-backdrop" role="presentation">
        <section className="reply-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="moderation-title">
          <span className="eyebrow">Moderator confirmation</span>
          <h2 id="moderation-title">{pendingModeration.action} {pendingModeration.targetLabel}?</h2>
          <p>This action is limited to the current Social Cues thread and will be written to the moderator action history.</p>
          <div className="modal-actions">
            <button onClick={() => setPendingModeration(null)}>Cancel</button>
            <button className={['remove', 'spam'].includes(pendingModeration.action) ? 'danger-button' : 'signal-button'} onClick={() => void performModeration(pendingModeration.targetId, pendingModeration.action)}>Confirm {pendingModeration.action}</button>
          </div>
        </section>
      </div>}
    </main>
  );
};

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
