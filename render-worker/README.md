# Social Cues Render Worker

This container is the isolated media execution lane. It runs as a Google Cloud
Run Job, claims only `media_render` records from Supabase, converts the private
source into platform dimensions with FFmpeg, uploads private outputs, records
the result, and exits.

Required runtime secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` from Google Secret Manager
- `MEDIA_STORAGE_BUCKET=social-cues-media`

Recommended Cloud Run settings:

- 2 CPU, 4 GiB memory
- 30 minute task timeout
- zero Cloud Run retries; the Supabase job ledger owns retries
- one task per execution
- Cloud Scheduler invokes the Job every minute
- `RENDER_WORKER_BATCH_SIZE=2`
- `RENDER_WORKER_LEASE_SECONDS=1800`

The container never receives customer OAuth tokens. Its service identity has
only the secrets needed to read/write media storage and settle render jobs.

## Deployment

From the repository root, after Google Cloud CLI is installed, authenticated,
and pointed at a billing-enabled project:

```powershell
.\render-worker\deploy-cloud-run.ps1 -ProjectId "YOUR_GOOGLE_CLOUD_PROJECT_ID"
```

The script creates a dedicated service account, private Artifact Registry
repository, two Secret Manager values, the Cloud Run Job, and a one-minute
Cloud Scheduler trigger. It prompts securely for Supabase values when they are
not already present in the current process environment. The worker writes a
`cloud-run-render` receipt to `worker_runs` on every execution.

Keep `MEDIA_RENDER_WORKER_CONFIGURED=false` in Vercel until an authenticated
source upload produces completed private MP4 outputs and the app can open them
through its short-lived download route.
