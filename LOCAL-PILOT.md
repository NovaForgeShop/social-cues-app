# Synthetic Local Pilot

This rehearsal uses the real root `server.mjs`, local signup/session, ownership
checks and JSON persistence. It does not prove production behavior or real
provider integration. No publishing, billing, database migration or deployment
is part of this pilot. R4 remains HOLD.

## Run the complete rehearsal

From this checkout in PowerShell:

```powershell
node scripts/run-local-pilot.mjs --rehearse
```

Prerequisites are the repository's already cached Node dependencies and cached
Playwright Chromium/WebKit browsers. This delivery uses a task-local
`node_modules` junction to the existing dependency cache. The command does not
install dependencies or download browsers; missing dependencies are a blocker,
not a reason to run an unapproved network install.

The command creates fresh synthetic accounts and separate data directories for
desktop Chromium (1440 x 1000) and mobile WebKit (390 x 844). It completes and
closes both runs. Its JSON summary names the evidence directory and retained
data directories. The browser journey performs:

1. Visible signup with the local tester promo and onboarding.
2. The one documented provider prerequisite below, then visible campaign
   creation, local variant generation, copy editing and review approval.
3. Actual Markdown and CSV downloads containing the approved synthetic copy.
4. A manual posting receipt, an observation of zero, and correction to 12.
5. Explicit receipt selection, evidence preview and one editable self-launch draft.
6. A separate source-note correction and campaign-brief edit, checking the original
   selected evidence snapshot remains unchanged.
7. A real server-process restart, fresh page and session/model hydration.
8. Visible **Saved evidence snapshot** inspection in the Campaign editor, after
   restart without a transient Results preview. It checks original facts after
   source correction, unfinished input preservation, zero inspection requests and
   byte-identical stored JSON. The test reads the file directly because the
   existing `GET /api/model` handler bootstraps/saves workspace state.
9. A visible JSON content backup containing the corrected result and active draft
   with its original source record IDs and factual snapshot. This existing export
   uses a singular `campaign`, not a list of all workspace campaigns.
10. Authenticated synthetic preparation adds a legacy record/operational marker;
    visible private-model export confirms the marker is present in that private
    file. Visible recovery-content export excludes it. Full dumps stay in memory,
    not report artifacts.
11. An authenticated synthetic model save simulates lost content. The visible
    recovery file picker, cancellation, invalid version/structure, preview and
    explicit apply are exercised without mocking application routes.
12. Confirmed restore and another actual process restart preserve multiple
    campaigns, recorded statuses, manual/legacy proof and original frozen facts.
    Current identity/ownership/security/billing/queue remain unchanged. One model
    POST applies recovery; no provider or publishing action occurs.

P8 passes 110 checks across both profiles. Recovery rejection, lost/incomplete
responses and a late workspace switch are covered separately by the intercepted
72-check browser matrix, not claimed as real-server failure evidence.
[CONTENT-RECOVERY.md](C:/Users/barto/Documents/Codex/social-cues-app-content-recovery-p8-20260906-2225/CONTENT-RECOVERY.md)
defines exact supported fields, exclusions and the unresolved concurrent-writer
boundary. P5/P7 retained pilot data are not used for destructive recovery tests.

Results opened from Plan preselects the active campaign only for a new untouched
receipt. Choose a variant and enter the actual URL, time and posting offset.
Observation fields start collapsed behind **Observed result (optional)**; the
operator note stays available. Expand to add a measurement. Editing a measured
result or receiving a measurement validation error opens it automatically.
Collapse retains values. **Clear observation** empties only the measurement
fields; save to update recorded evidence. Zero remains a measured value.
Returning from Plan does not overwrite an in-progress or edited receipt.

Approval and queue state must stay unchanged by export, receipt and evidence-draft
creation operations. The new campaign's variants remain drafts; its initial brief
and variant copy match the preview. Subsequent brief editing uses the existing
editor's whitespace normalization and does not rewrite the stored evidence snapshot.
The test does not click queue confirmation or run the worker. Sample URLs use
`example.test`; they are not visited. Fixed September 1/2, 2026 timestamps and
explicit UTC offsets are synthetic rehearsal values, not posting claims.

## Inspect the retained pilot interactively

Use a data directory returned by a successful rehearsal:

```powershell
node scripts/run-local-pilot.mjs --resume "<absolute dataDir from the rehearsal summary>"
```

Open the exact loopback portal URL printed by the launcher. The generated
synthetic login is retained privately in that data directory's
`pilot-access.json`; no real account is used. Sign in, select Results, and inspect
the corrected synthetic receipt and saved evidence-based campaign draft. The browser rehearsal also checks continued
session validity across restart in its existing browser context.

Select the saved draft, open the Campaign lane and expand **Saved evidence snapshot**
below Brief. It is available independently of the Results preview. It shows the
facts captured at draft creation, not later corrections, and never changes storage.
Use the candidate-specific [PILOT-HANDOFF.md](C:/Users/barto/Documents/Codex/social-cues-app-saved-evidence-1788732637077-86b032/PILOT-HANDOFF.md) for its
exact retained data directory and port; do not move another worktree's pilot data.

In the launch terminal, enter `restart` to reuse the same port/data/session
configuration. Enter `stop` or press Ctrl+C to stop only that launcher's server.
Closing terminal input also requests a stop. Data is retained; nothing is
automatically removed. Resume refuses another running launcher's lock or a data
directory outside this worktree's task-owned `.tmp/local-pilot-*` paths. It fails
rather than replacing another process when the retained port is occupied.

For a fresh interactive signup instead:

```powershell
node scripts/run-local-pilot.mjs
```

Use synthetic identity/content only and the existing local tester promo
`SC-LOCAL-BEACON-4M7Q`. Fresh mode intentionally does not seed a provider account.
Use the completed rehearsal's resume directory to inspect an approved campaign
without performing real OAuth.

## Isolation and simulated prerequisite

The server binds to `127.0.0.1` on an available port, with `AUTH_PROVIDER=alpha-local`,
`NODE_ENV=test`, `SUPABASE_ENABLED=false` and a generated session secret. Only an
allowlist of operating-system environment names is inherited; provider credentials,
hosted-runtime markers, proxies and inherited `NODE_OPTIONS` are not passed on.
The existing server-process fixture suppresses `.env` loading. No `.env` is read.

After real authenticated signup, the browser calls the existing local-only
`/api/e2e/provider-accounts` route once to create an owned synthetic Facebook Page.
This is necessary because the supported UI cannot create a provider connection
without live OAuth. The fixture is a prerequisite, not a replacement for auth,
session, model save/load or campaign routes. Those routes reach the real server.
Variant generation uses the existing local fallback, with no AI API credential.

The unchanged `tests/support/tester-loop-provider-fixture.mjs` handles only two
exact synthetic Meta Page GET shapes and blocks other external server `fetch`
calls. Browser requests outside the pilot origin are aborted, service workers are
disabled, and fixture hits/rejections are recorded without tokens. This is an
application-level fetch boundary, not a machine-wide firewall. Do not use this
launcher for arbitrary code or real integrations. No provider write is authorized.

## Evidence and checks

```powershell
node --test local-pilot.launcher.test.mjs
node --check scripts/run-local-pilot.mjs
node --check local-pilot.browser.test.mjs
git diff --check
```

`test-results/local-pilot/<run>/` contains sanitized request-path/status evidence,
screenshots, Markdown/CSV, a synthetic result and content backup. The retained
`.tmp/local-pilot-*` directories contain private synthetic runtime data, including
generated login/session material. Do not upload these directories or commit them.
Server output is sanitized separately; provider logs contain event metadata only.

The focused `node evidence-draft.browser.test.mjs` check additionally simulates
both a rejected save and a saved response that is lost, then verifies same-form
retry keeps one campaign identity. That failure simulation is intercepted browser
evidence, distinct from the real-server successful save/restart rehearsal.

Expected local friction includes signup requiring the tester promo, explicit
UTC-offset selection, and provider-dependent panels
reporting unavailable credentials. The initial signed-out session 401, disabled
OAuth-debug 403, and unconfigured-provider 409 responses are expected; they are
not successful provider validations. Review approval is step one of two, so do
not confirm queueing. The current inherited visual theme is unchanged.

P1/P2 and backend evidence can be carried forward only when their executed source
inputs remain unchanged. This pilot adds real-process persistence evidence; it
does not replace provider, production, migration or payment verification.
