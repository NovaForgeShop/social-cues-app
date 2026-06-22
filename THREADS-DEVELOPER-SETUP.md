# Social Cues Threads Developer Setup

Threads is treated as its own platform adapter in Social Cues.

## Local Social Cues Values

Local app URL:

```text
http://127.0.0.1:4177
```

OAuth redirect URI:

```text
http://127.0.0.1:4177/api/oauth/threads/callback
```

Social Cues status check:

```text
http://127.0.0.1:4177/api/oauth/threads/status
```

## Add To `.env`

```text
THREADS_APP_ID=
THREADS_APP_SECRET=
```

Do not put `THREADS_APP_SECRET` in browser code or chat.

## Current Backend State

Social Cues can start the Threads OAuth redirect and receive the callback. The callback records that Threads returned an authorization code. The next production step is token exchange, encrypted token storage, Threads user id storage, and connecting scheduled Social Cues Queue items to the Threads publishing API.
