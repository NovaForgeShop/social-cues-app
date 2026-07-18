import './index.css';

import { context, requestExpandedMode } from '@devvit/web/client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

export const Splash = () => (
  <main className="splash-shell">
    <div className="brand-mark large">SC</div>
    <span className="eyebrow">Social Cues App</span>
    <h1>Turn conversation into momentum.</h1>
    <p>Review replies, focus moderator attention, and prepare an Ads Manager handoff without giving up approval.</p>
    <button className="signal-button" onClick={(event) => requestExpandedMode(event.nativeEvent, 'game')}>Open community command</button>
    <small>Signed in as u/{context.username ?? 'guest'}</small>
  </main>
);

createRoot(document.getElementById('root')!).render(<StrictMode><Splash /></StrictMode>);
