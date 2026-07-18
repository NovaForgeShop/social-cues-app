# Social Cues Local Test App

This is the fastest runnable Social Cues alpha package.

## Run

Double-click:

```txt
start-SOCIAL-CUES.cmd
```

Or run:

```txt
npm start
```

Then open:

```txt
http://127.0.0.1:4177
```

## Install Like An App

1. Start Social Cues with `start-SOCIAL-CUES.cmd`.
2. Open `http://127.0.0.1:4177` in Chrome or Edge.
3. Use the browser's install option:
   - Chrome/Edge address bar install icon, or
   - browser menu -> Apps -> Install this site as an app.

The installed app uses the local server and saves the working model to:

```txt
data/model.json
```

## Supabase

Social Cues now has a cloud persistence lane. Local JSON mode stays on by default so the alpha opens immediately. To turn on Supabase, run `supabase-schema.sql` in your Supabase project and add the server-only values from `.env.example`.

For this workspace, the Supabase schema has already been applied. Copy `.env.example` to `.env`, add the Supabase service-role key, then restart the local server.

## Meta

Meta/Facebook/Instagram setup notes are in `META-DEVELOPER-SETUP.md`, `META-CONNECTION-PACK.md`, and `META-18-USE-CASES.md`.
Threads setup notes are in `THREADS-DEVELOPER-SETUP.md`.

Local redirect URI:

```txt
http://127.0.0.1:4177/api/oauth/meta/callback
```

Connection check:

```txt
http://127.0.0.1:4177/api/meta/health
```

## Test

```txt
npm test
```

## What It Does

- Serves the Social Cues run UI as an installable local app.
- Persists a model to `data/model.json`.
- Serves a web app manifest, icon, and service worker.
- Can save through Supabase when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured.
- Exposes local API endpoints:
  - `GET /health`
  - `GET /api/supabase/status`
  - `GET /api/oauth/meta/status`
  - `GET /api/oauth/meta/start`
  - `GET /api/oauth/meta/callback`
  - `GET /api/oauth/threads/status`
  - `GET /api/oauth/threads/start`
  - `GET /api/oauth/threads/callback`
  - `GET /api/meta/use-cases`
  - `GET /api/model`
  - `POST /api/model`
  - `POST /api/generate/platform-variants`
  - `POST /api/publish/social-cues/queue`
  - `POST /api/proof`
  - `GET /api/integrations/readiness`
  - `GET /api/export`

## Current Limits

This is a local test app. OpenAI, native social OAuth apps, and Shopify are scaffolded but not connected to live credentials yet.

Do not put real API secrets in the browser UI. Use a backend `.env` file based on `.env.example`.
