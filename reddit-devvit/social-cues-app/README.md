# Social Cues for Reddit

Social Cues is a moderator-installed Devvit app for running a focused community thread. It gives subreddit moderators a compact inbox for the thread's comments, reports, replies, and moderation state.

## Implemented

- Moderator-only command thread creation
- Thread-bound comment inbox with reported, unanswered, and removed filters
- Explicitly confirmed app-attributed replies
- Approve, remove, spam, lock, and unlock actions for moderators
- A 100-entry Redis audit trail containing action metadata, not comment bodies
- Comment and report signal counters without copying discussion text
- An Ads Manager handoff with no automatic campaign creation or spend

## Guardrails

- Every reply and moderation action requires an explicit confirmation token from the UI.
- The backend checks current subreddit moderator status before any write.
- Comment targets must belong to the active Social Cues thread.
- Replies are limited to ten per moderator per minute.
- Reddit content stays in Reddit; Social Cues stores only action IDs and aggregate signals in Devvit Redis.
- Reddit Ads API access is separate. This build does not create campaigns, set budgets, or spend money.

## Commands

- `npm run dev` starts a Reddit playtest.
- `npm run build` builds the client and server.
- `npm run type-check` checks TypeScript.
- `npm run lint` checks the source.
- `npm run deploy` validates and uploads a private app version.
- `npm run launch` requests public publication and must not be run until listing and verification are ready.
