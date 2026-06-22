# Social Cues Vercel Deployment

## Current Target

Deploy this folder as the Vercel project:

```text
social-cues-app
```

Production domain:

```text
socialcuesapp.com
www.socialcuesapp.com
```

Vercel team:

```text
socialcuesapp
```

## Required Vercel Project Settings

- Framework preset: Other
- Project name: social-cues
- Build command: leave empty
- Output directory: leave empty
- Install command: leave empty
- Root directory: this folder

The project includes:

- `api/server.mjs` as the Vercel serverless entry point
- `vercel.json` routing every path into the Social Cues backend
- `.vercelignore` to keep local secrets, logs, and local JSON state out of deployments

## Production Environment Variables

Set these in Vercel Project Settings > Environment Variables for Production, Preview, and Development unless noted otherwise.

```text
BRAND_DOMAIN=socialcuesapp.com
BRAND_HOME_URL=https://socialcuesapp.com
SUPPORT_EMAIL=mr.barton@socialcuesapp.com
PUBLIC_APP_URL=https://socialcuesapp.com
META_PUBLIC_APP_URL=https://socialcuesapp.com
X_PUBLIC_APP_URL=https://socialcuesapp.com
SUPABASE_URL=<current Supabase project URL>
SUPABASE_SERVICE_ROLE_KEY=<current Supabase service role key>
SUPABASE_SECRET_KEY=<same value or leave unset if service role key is set>
SUPABASE_ENABLED=true
META_APP_ID=<Meta app id>
META_APP_SECRET=<Meta app secret>
META_API_VERSION=v23.0
OAUTH_TOKEN_ENCRYPTION_KEY=<current encryption key>
WEBHOOK_VERIFY_TOKEN=<current webhook verify token, if set>
WEBHOOK_SIGNING_SECRET=<current webhook signing secret, if set>
THREADS_APP_ID=<Threads app id, when ready>
THREADS_APP_SECRET=<Threads app secret, when ready>
X_CLIENT_ID=<X client id>
X_CLIENT_SECRET=<X client secret>
OPENAI_API_KEY=<OpenAI key, when production AI features are enabled>
STRIPE_SECRET_KEY=<Stripe key, when billing is enabled>
STRIPE_WEBHOOK_SECRET=<Stripe webhook secret, when billing is enabled>
PUBLISHING_QUEUE_MODE=social-cues
```

Do not upload the local `.env` file. Copy values into Vercel's encrypted environment variable UI.

## OAuth URLs After Deployment

Update provider dashboards to use:

```text
https://socialcuesapp.com/privacy
https://socialcuesapp.com/terms
https://socialcuesapp.com/api/meta/data-deletion
https://socialcuesapp.com/api/oauth/meta/callback
https://socialcuesapp.com/api/oauth/x/callback
```

Meta App Domains:

```text
socialcuesapp.com
```

Keep the Supabase bridge domain in Meta temporarily only until the deployed Social Cues domain has passed live verification.

## Verification URLs

After deploy, open:

```text
https://socialcuesapp.com/health
https://socialcuesapp.com/app
https://socialcuesapp.com/privacy
https://socialcuesapp.com/terms
https://socialcuesapp.com/api/meta/review-pack
https://socialcuesapp.com/api/oauth/x/status
https://socialcuesapp.com/api/oauth/meta/status
```

Expected:

- `/health` returns JSON with `app: "Social Cues"` and `mode: "vercel"`
- `/app` shows the Social Cues app
- `/privacy` and `/terms` show the Social Cues domain and support email
- Meta and X status routes show configured credentials after env vars are set

## Vercel Pro Surfaces To Turn On After First Deploy

Use these in the Social Cues Vercel project after the first deployment exists.

### Domains

- Add `socialcuesapp.com`
- Add `www.socialcuesapp.com`
- Make `socialcuesapp.com` canonical
- Keep Google Workspace MX records at Squarespace
- Use Vercel DNS instructions only for web records, not email records

### Environment Variables

- Add every Production runtime variable listed above
- Copy the same values to Preview only if preview deployments are allowed to touch the same Supabase project
- Prefer a separate Preview Supabase project later, once users beyond the founder are testing
- Never expose provider secrets as `NEXT_PUBLIC_*`

### Logs

- Use Logs for OAuth callback errors, provider API errors, and serverless exceptions
- First production scans:
  - `/api/oauth/meta/status`
  - `/api/oauth/x/status`
  - `/api/meta/review-pack`
  - `/api/accounts`

### Observability

- Turn on project Observability after first deploy
- Watch serverless error rate, function duration, and 4xx/5xx spikes
- Add alerts for repeated OAuth callback failures and 500 responses

### Speed Insights And Analytics

- Enable Speed Insights for app shell load performance
- Enable Web Analytics once public traffic starts
- Track `/app`, `/privacy`, `/terms`, and provider callback routes separately

### Firewall

- Start in observe/logging posture
- Add rate limits later for OAuth callback, publish, and media generation endpoints
- Do not block Meta, X, Supabase, Google, or Vercel verification traffic during review

### CDN

- Keep app HTML uncached or short cached while the prototype is changing
- Static icons and manifest can be cached longer
- Purge CDN after replacing app icons, policy copy, or callback behavior

### Rollback

- Keep the first known-good production deployment as a rollback point
- Do not update Meta/X callback URLs until the production deployment passes all verification URLs above
