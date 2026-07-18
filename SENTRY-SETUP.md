# Social Cues Sentry Setup

Social Cues now has opt-in Sentry error capture for the Node/Vercel server and the hosted command center. It sends no default PII and never sends OAuth tokens, cookies, passwords, or raw query strings.

## 1. Create the Sentry project

In Sentry, create a JavaScript/Node project named `Social Cues`. Copy the project DSN. The DSN is a public project identifier, not an API or admin secret.

Add this value in Vercel for the Production and Preview environments:

```txt
SENTRY_DSN=https://...@...ingest.sentry.io/...
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0
```

For local testing, add the same DSN to the project `.env` and set `SENTRY_ENVIRONMENT=development`. Do not commit `.env`.

`SENTRY_RELEASE` is optional. Social Cues uses the Vercel Git commit SHA when available and falls back to the unique Vercel deployment ID for direct CLI deployments. `SENTRY_DIST` also defaults to the deployment ID.

## 2. Connect GitHub

In Sentry, open `Settings > Integrations`, choose `GitHub`, install the Sentry GitHub app, and select `NovaForgeShop/social-cues-app`. In the Social Cues Sentry project, enable `SCM Source Context`. This lets an error point back to the commit and original source file that introduced it and lets a Sentry issue link to a GitHub issue.

Set these non-secret Vercel values:

```txt
SENTRY_GITHUB_REPOSITORY=NovaForgeShop/social-cues-app
SENTRY_SOURCE_CONTEXT_ENABLED=true
```

The current app deploys original `.mjs` and HTML JavaScript without bundling or minification, so generated source-map files are not required. GitHub source context provides direct source mapping. The installed Sentry/Vercel integration will upload source maps automatically if a future Vite, Next, or other bundled build emits them; any Sentry auth token must remain in Vercel build settings and never enter browser code.

## 3. Supabase relationship

Keep Supabase as Social Cues' auth, workspace, and media-storage system. There is no need to duplicate Supabase data into Sentry. With `SENTRY_DSN` present, server errors from Supabase requests, workspace mirroring, auth validation, storage, and provider OAuth routes are captured automatically by the server error boundary.

The app exposes these checks:

```txt
GET /api/observability/status
GET /api/observability/config
GET /health
```

The command center also reports browser errors. Client capture is enabled only when the DSN exists, and tracing defaults to zero to keep the free Sentry plan focused on actionable errors.

## 4. Verify the connection

After adding `SENTRY_DSN`, redeploy Social Cues, open `/api/observability/status`, and confirm `configured: true` and `initialized: true`. Then open the hosted `/app` once and check that the Sentry project receives a test event by using Sentry's built-in test-event action or by temporarily throwing a local-only test error. Remove any temporary test throw immediately.
