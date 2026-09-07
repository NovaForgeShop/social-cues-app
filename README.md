# Social Cues Local Test App

Social Cues at this commit is a verified local test and rehearsal application. A
deployment artifact also exists, but deployment success does not establish a safe
external user-data alpha.

## Current Safety Boundary

The target external alpha is invite-only and limited to named testers. Until the
R4 hosted-persistence review passes, any external demonstration must be
non-data-bearing: do not accept or retain tester workspace content, credentials,
media, or provider account data.

The minimum-alpha boundary also keeps these capabilities unavailable:

- Stripe remains at `readiness_only`; checkout, Customer Portal, webhook
  processing, charges, and paid entitlement changes stay held.
- Live provider OAuth and publishing stay out of scope.
- Provider readiness fixtures and manual receipts do not prove live account
  ownership, scopes, delivery, approval, or quota.

See `VERCEL-DEPLOYMENT.md` for the complete go/no-go checklist and
`RELEASE-READINESS.md` for the evidence boundary.

## Run Locally

Double-click:

```text
start-SOCIAL-CUES.cmd
```

Or run:

```text
npm start
```

Then open:

```text
http://127.0.0.1:4177
```

`npm start` runs root `server.mjs`. The same root file is the sole Vercel
function declared by `vercel.json`; there is no `api/server.mjs` entrypoint.

## Install Like An App

1. Start Social Cues with `start-SOCIAL-CUES.cmd`.
2. Open `http://127.0.0.1:4177` in Chrome or Edge.
3. Use the browser install option.

The installed local app persists its working model to:

```text
data/model.json
```

Use synthetic test data only. Local filesystem persistence is not evidence of
hosted durability, recovery, or tenant isolation.

## Supabase Boundary

Do not enable Supabase for external tester content from this README. The current
server still contains a shared `app_state` compatibility path, and the standalone
`hosted-workspace-persistence.mjs` adapter is not imported or initialized by
`server.mjs`. Its contract tests do not prove a deployed multi-instance route,
production schema or RLS state, JWT gateway behavior, backup recovery, or retained
data conversion.

R4 therefore remains **HOLD**. Environment-variable presence or a successful
`GET /api/supabase/status` response is not sufficient to lift that hold. See
`SUPABASE-SETUP.md` for the exact persistence gates.

## Test

```text
npm test
```

Focused contract commands are listed in `package.json`. Tests use synthetic and
guarded fixtures; they are not authorization to contact providers or production
databases.

## Implemented Local Surfaces

- Serves the Social Cues UI, manifest, icons, and service worker.
- Persists synthetic local state in `data/model.json`.
- Exposes the minimal public `GET /health` route.
- Includes authenticated workspace, provider-readiness, export, and generation
  routes for local contract testing.
- Includes the secured `/api/cron/workers` route declared in `vercel.json`.

## Safety Rules

- Never put real API or service-role secrets in browser-visible files or UI.
- Do not infer production readiness from local tests, deployed HTML, status
  endpoints, configured environment names, or provider-shaped fixtures.
- Do not activate billing, provider OAuth, publishing, hosted persistence, or
  external user-content collection until their explicit go/no-go gates pass.
- Do not recreate `api/server.mjs`.
