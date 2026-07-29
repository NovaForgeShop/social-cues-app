import './index.css';

import { requestExpandedMode } from '@devvit/web/client';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ThreadState } from '../shared/api';

type CommentSummary = {
  count: number;
  isPartial: boolean;
  isModerator: boolean;
  subredditName: string;
  username: string;
};

function isThreadState(value: unknown): value is ThreadState {
  return typeof value === 'object'
    && value !== null
    && 'status' in value
    && value.status === 'ok'
    && 'summary' in value
    && 'commentPage' in value
    && 'subredditName' in value;
}

function responseError(value: unknown, status: number): string {
  if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') {
    return value.message;
  }
  return `Comments returned ${status}.`;
}

export const Splash = () => {
  const [summary, setSummary] = useState<CommentSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/comments')
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok || !isThreadState(body)) throw new Error(responseError(body, response.status));
        return body;
      })
      .then((state) => {
        if (!active) return;
        setSummary({
          count: state.summary.loadedComments,
          isPartial: state.commentPage.isPartial,
          isModerator: state.isModerator,
          subredditName: state.subredditName,
          username: state.username,
        });
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Comments are temporarily unavailable.');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="splash-shell">
      <div className="brand-mark large">SC</div>
      <span className="eyebrow">{summary ? `r/${summary.subredditName}` : 'Social Cues App'}</span>
      <h1>Community conversation</h1>
      <button
        className="comment-count-button"
        aria-label={summary ? `Open ${summary.isPartial ? 'at least ' : ''}${summary.count} Reddit comments` : 'Open Reddit comments'}
        onClick={(event) => requestExpandedMode(event.nativeEvent, 'game')}
      >
        <strong>{summary ? `${summary.count}${summary.isPartial ? '+' : ''}` : error ? '--' : '...'}</strong>
        <span>{summary?.count === 1 ? 'comment' : 'comments'}</span>
      </button>
      <p>
        {summary?.isModerator
          ? 'Open the thread to review comments, reports, moderator permissions, and available actions.'
          : 'Open the thread to read the conversation. Moderator-only information stays private.'}
      </p>
      <button className="signal-button" onClick={(event) => requestExpandedMode(event.nativeEvent, 'game')}>
        View comments
      </button>
      {error && <small className="splash-error">{error}</small>}
      {!error && <small>{summary ? `Signed in as u/${summary.username}` : 'Loading Reddit identity...'}</small>}
    </main>
  );
};

createRoot(document.getElementById('root')!).render(<StrictMode><Splash /></StrictMode>);
