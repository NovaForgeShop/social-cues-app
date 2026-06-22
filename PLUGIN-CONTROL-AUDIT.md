# Social Cues Plugin Control Audit

## Working From This Thread

- Supabase: working. Used to inspect the project, apply migrations, and deploy the `meta-oauth-callback` Edge Function.
- Canva: callable tools are exposed for template/design workflows.
- Google Drive: callable tools are exposed.
- Data widgets: callable tools are exposed for dashboard/report rendering.

## Installed Locally But Blocked Here

- Chrome control
- Browser control

Both are installed in the Codex plugin cache, but the Node-backed browser runtime fails with a Windows permission error before it can attach to Chrome:

```text
CreateProcessAsUserW failed: 5
```

Chrome is running, but Codex cannot currently claim or inspect tabs from this sandbox.

## Likely Fix

1. Re-enable or reinstall the Codex Chrome Extension from the Codex plugin UI.
2. Restart Codex Desktop.
3. Open a fresh thread in the same Social Cues folder.
4. Ask: `check Chrome plugin connection and list open tabs`.

## Current Workaround

Use Supabase Edge Functions for HTTPS callbacks and use the user-visible Meta dashboard manually for app settings until Chrome control works again.
