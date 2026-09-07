# Social Cues Operator Pilot: P28 Baseline Candidate

P28 closes the inherited Discord community read-boundary failure on accepted P27
`0a388b7639df65d3458c3bdb819477acf128ce4a`. The P15 hosted CAS adapter is
still not wired into `server.mjs`, so P14 remains the current runnable local pilot
and hosted conditional save remains inactive. Branch:
`codex/discord-community-p28-20260907-094600`. Match `git rev-parse HEAD` to
the P28 delivery report and `.tmp/P28-final-evidence.json`.

This is a synthetic local rehearsal, not a production or paid release.
**R4 remains HOLD.** No live posting, provider setup, billing activation,
retained-data conversion, migration or deployment is authorized.

## P28 Authenticated Discord Community Reads

Before the repair, anonymous revisioned-local `GET /api/discord/community`
entered Discord account validation and attempted one guarded external GET before
returning sanitized `500`. Model bytes and workspace revisions did not change, but
provider inspection before authentication was a real application-boundary defect.

The shared `requireDiscordAccountForRead` helper now requires the existing entitled
session whenever hosted mode or revisioned local persistence is active. The guard
runs before workspace scoping, account selection, credential validation, refresh,
repair, save or provider traffic. The ten existing account-backed Discord routes
inherit it; static readiness, interactions, webhook verification and command
registration are unchanged.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_DISCORD_COMMUNITY_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves anonymous and invalid sessions receive exact sanitized `402` app-access
responses with byte-identical storage, unchanged revisions and no provider traffic.
A foreign no-account workspace receives only owner-free `409` connect guidance.
The authenticated owner retains the existing public community shape through two
guarded Discord GET mocks, advances exactly one owner revision and keeps its token
encrypted and owner scoped. Secrets are absent from HTTP, persistence plaintext,
logs and process output. Both child servers stop, release the lock and clean up.

P20 through P28 focused fixtures are green. Dedicated verification reports **382**
authentication checks, **165** workspace-authorization checks including the
original **24**, **111** local-ownership checks, **9** local-persistence tests,
**5** writer-inventory tests, **18** hosted-adapter tests, **13** workspace-content
contract tests, **20** persistence runtime tests and **27** revisioned-model checks
with zero external dispatches. The uncapped `npm test` suite exits successfully,
retaining **18** fail-closed payment-safety assertions and its successful final
generation/queue result.

No live Discord, Supabase, production or other provider request ran. No dependency,
lockfile, migration, deployment, billing or retained-data behavior changed. Discord
application verification remains deferred below 100 installed servers, no current
installation count was obtained, and R4 remains HOLD.

## P27 Revisioned Billing Checkout Controls

The inherited fixture read `canonicalBillingModel.workspace` from the root of
`model.json`. Revisioned local storage intentionally has no root workspace; its
canonical registry is `shared.workspaces` and its per-workspace entries live under
`workspaces`. Every existing signed-in candidate also began as the owner of a
separate workspace, so the old selector could prove neither the intended owner nor
a genuine same-workspace non-owner. The application route and held Stripe boundary
were correct; this was an incomplete, pre-revisioned test fixture.

The repaired test derives each candidate from the persisted revisioned registry,
authenticated user and exact active device. With the server stopped and its lock
released, it uses the existing local persistence adapter to point the synthetic
Member device at the selected owner's workspace without changing workspace
ownership or application source. A third canonical owner remains the independent
foreign-workspace body control. Billing request assertions then compare the exact
post-setup model bytes and both external and mocked-provider logs.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_BILLING_CHECKOUT_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves anonymous checkout returns `401`; the authenticated same-workspace
non-owner and its forged admin claim return `403`; the canonical owner, hostile
body and foreign-body cases all reach the unchanged readiness-only held boundary
and return `503`. No billing request changes durable state or reaches a real or
mocked provider. The focused server stops, releases the revisioned lock and removes
its task-owned directory.

P20 through P27 focused fixtures are green. Dedicated verification reports **382**
authentication checks, **165** workspace-authorization checks including the
original **24**, **111** local-ownership checks, **9** local-persistence tests,
**5** writer-inventory tests, **18** hosted-adapter tests, **13** workspace-content
contract tests, **20** persistence runtime tests, **27** revisioned-model checks
and **92** held Stripe-application checks. The uncapped suite clears P27 and next
stops at `test.mjs:8967`, where the inherited anonymous Discord community fixture
still expects OAuth-required `409`. Diagnose that fixture and authentication
contract independently in P28. Do not change it as part of P27.

No application, billing, provider, dependency, lockfile, migration or deployment
file changes in P27. No external provider, Supabase or production request ran, no
payment or entitlement was created, and R4 remains HOLD.

## P26 X Account Inspection And Validation

The inherited monolithic test called `/api/x/account` anonymously. Under
revisioned local persistence, the route loaded shared provider state and entered
X token validation before authentication. Validation can save account evidence,
refresh credentials or repair connection state, so the local writer rejected the
ownerless mutation as `workspace_writer_unclassified`; its internal `403` and
commit status escaped publicly.

The route now applies the existing entitled-session `402` response before account
loading, validation, refresh, repair or save whenever hosted or revisioned local
persistence is active. `/api/x/engagement/readiness`, OAuth behavior, encrypted
credential handling and all other provider routes are unchanged.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_X_ACCOUNT_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves anonymous and invalid-session requests return the exact sanitized app
access response with byte-identical storage, unchanged owner/foreign revisions,
no cookie or internal classifier, and zero provider traffic. The authenticated
owner retains the existing public readiness, posting and scope response, validates
an encrypted synthetic local account and advances exactly one owner revision. A
foreign workspace sees no owner account and changes no durable state. Plaintext
credentials and session values are absent from HTTP, persistence, request logs and
process output; both child servers stop, release the lock and clean up explicitly.

P20 through P25 remain green. Dedicated verification reports **382**
authentication checks, **165** workspace-authorization checks including the
original **24**, **111** local-ownership checks, **23** local
persistence/writer/content tests, **13** workspace-content contract tests, **20**
persistence runtime checks and **27** revisioned-model checks. The monolithic
suite clears P26 and next stops at `test.mjs:8510`, where the separate billing
checkout fixture cannot resolve canonical owner/non-owner/foreign controls. Keep
that P27 diagnosis independent. No external provider request was made. R4 stays
HOLD.

## P25 YouTube And Google Business OAuth Start

The inherited monolithic test called `/api/oauth/youtube/start` anonymously and
expected a redirect. Under revisioned local persistence the route created state
without an owner, then the writer rejected the save as
`workspace_writer_unclassified`. No write or provider request occurred, but the
internal `403` classification and commit status escaped publicly.

The route now returns its established `401` sign-in page before state creation
whenever revisioned local persistence is active and no valid session exists. This
covers both YouTube and `service=business`; hosted behavior, callback validation,
one-time state, credential encryption and the P20/P23/P24 replay and owner rules
remain unchanged.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_GOOGLE_START_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves anonymous and invalid-session requests return sanitized `401` responses
with byte-identical storage, unchanged revisions, no redirect/cookie and zero
provider traffic. Authenticated owner requests return separate `302` redirects to
Google's authorization endpoint with the canonical callback, `offline` access,
consent/account selection, the exact four YouTube scopes and the separate Google
Business `business.manage` scope. Both states are signed, distinct and durably
bound to the exact owner/workspace while a foreign workspace remains unchanged.
Public models and audit output omit private ledgers and raw state; secrets remain
absent from HTTP, persistence and process output. Shutdown, lock release and
directory cleanup are explicit.

P20 through P24 remain green. Dedicated verification reports **382**
authentication checks, **165** workspace-authorization checks (including the
original **24**), **111** local-ownership checks, **27** combined local
persistence/writer/content tests, **20** persistence runtime checks and **27**
revisioned-model checks. The P25 delivery evidence records the one closing
monolithic result and any later unrelated inherited assertion. No external
provider request was made. R4 stays HOLD.

## P24 Facebook Meta Callback Persistence

The valid local callback reached the guarded Meta exchange from an authenticated
owner state, but then persisted renewed shared state separately from the owner
workspace view. That made the owner view stale and returned `409
workspace_shared_state_conflict` after exchange instead of committing the result.

Meta now uses the accepted P20 local callback pattern. The owner view receives the
final sanitized OAuth audit ledger after session renewal, skips only the stale
local shared save and commits callback state plus owner-scoped accounts through
its revision-checked baseline. Hosted/nonlocal save behavior, P23 state rejection,
credential encryption and public scrubbing remain unchanged.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_META_CALLBACK_ATOMIC_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves both a failed and successful exchange return the existing explanatory
`200`, renew the same HttpOnly owner session, consume state, reject replay before
provider traffic and preserve foreign-workspace bytes. The successful callback
stores exactly one Meta identity, one Facebook Page and one linked Instagram
professional account with encrypted credentials and exact owner/workspace stamps.
An authenticated asset refresh preserves deduplication and selected Page/Instagram
IDs, and all three accounts survive a process restart.

The fixture serves **12** exact Meta-shaped interactions through the loopback-only
guard: one failed token exchange; successful short- and long-token exchanges;
identity, token-debug, permissions, Page/Instagram discovery and business reads;
then the four authenticated selection-refresh reads. It records zero non-loopback
requests, omits plaintext provider secrets from public bodies, durable state,
audit, mock evidence and process output, stops both child processes, releases the
workspace lock and explicitly removes its scenario directory.

P20 Google callback, P21 Meta start, P22 Meta assets and P23 Meta rejection remain
green. Dedicated verification reports **382** authentication checks, **165**
workspace-authorization checks (including the original **24**), **111** local-
ownership checks, **27** combined local persistence/writer/content checks, **20**
persistence runtime checks and **27** revisioned-model checks. No external
provider request was made.

The single final `npm test` is expected to clear P24 and next stop at current
`test.mjs:7497`, where the inherited anonymous YouTube OAuth start still expects
a `302`. Keep that authentication/ownerless-write diagnosis independent. R4 stays
HOLD.

## P23 Facebook Meta Callback Rejection

The inherited unissued callback attempted to persist a generic ownerless ingress
audit before the Meta route could return its existing rejection page. The local
writer correctly refused that write, but its internal `403
workspace_writer_unclassified` response escaped to the caller.

Local callback ingress now persists only when an exact live ledger state belongs
to the authenticated user and workspace. The Meta callback requires that same
owner locally, disables local signed-state recovery, and returns the established
sanitized `400` without writing rejected input. Hosted callback audit behavior is
unchanged.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_META_CALLBACK_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves missing, malformed, tampered, signed-but-unissued, wrong-provider,
ownerless, foreign-owner and replayed states all return exact `400` responses,
set no cookie, preserve model bytes/revisions/receipts and make no provider call.
It also proves public/private state separation, secret omission, shutdown, lock
release and explicit cleanup. The one valid owner-bound control reaches a guarded
Meta token exchange, consumes state, renews the session and leaves the foreign
workspace unchanged. At the P23 checkpoint it exposed the separate `409
workspace_shared_state_conflict` valid-path defect; P24 now repairs that path
without broadening P23 rejection handling.

P20 Google callback, P21 Meta start and P22 Meta assets remain green. Dedicated
verification reports **382** auth checks, **165** workspace-authorization checks,
**111** local-ownership checks, **27** combined local persistence/writer/content
checks, **20** persistence runtime checks and **27** revisioned-model checks. No
live Meta, Supabase or other provider call was made.

The single final `npm test` clears P23 and next stops at current `test.mjs:6863`,
where an inherited anonymous YouTube OAuth start still expects a `302`. The P20
authenticated Google callback fixture is green. Keep that start-route diagnosis
separate from P23 and from the P24 Meta valid-callback atomic-save repair.

## P22 Facebook Meta Asset Refresh

The inherited monolithic fixture called `/api/meta/assets` without a session. The
route performed token-backed repair and Meta inspection, then attempted an
ownerless local write and surfaced `403 workspace_writer_unclassified`. A guarded
diagnosis also found that authenticated foreign workspaces received shared Meta
connection and capability summaries derived from the owner's account even though
the public account list itself was filtered.

Local revisioned mode now requires a valid session before any repair, inspection,
provider request or persistence. Authenticated refresh computes connection,
health, diagnostic and capability output from only the current owner's account
rows, restores the exact prior shared Meta summary fields, and persists legitimate
owner-bound account repair/discovery. Hosted app-access handling and the anonymous
static use-case/capability catalogs are unchanged.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_META_ASSETS_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves exact anonymous/invalid-session `401` responses and byte-identical state;
anonymous static catalogs; three repaired owner Meta assets; **37** scoped
capabilities; exact owner/workspace identity; one revision increment; no client
receipt; a zero-asset, zero-provider-call foreign workspace with unchanged state;
public/private field separation; two child shutdowns; lock release and explicit
cleanup. Four Meta-shaped interactions are handled by the local guard and no
non-loopback request is dispatched.

Dedicated verification reports **382** authentication checks, **165** workspace-
authorization checks, **111** local-ownership checks, **27** combined local
persistence/writer/content checks, **20** persistence runtime checks and **27**
revisioned-model checks. The inherited P21 Meta-start fixture remains green.

The final monolithic suite clears P22 and stops later at current `test.mjs:6457`:
an unissued `/api/oauth/meta/callback` expects `400` but receives `403
workspace_writer_unclassified`, `commitStatus: not_committed`, before provider
exchange. Treat that callback save/audit boundary as independent P23 work. The
standalone Meta-health authentication harness is also stale before route execution
because it writes the pre-revision raw seed format; do not weaken the store to make
that fixture pass.

## P21 Facebook Meta OAuth Start

The inherited monolithic fixture called the state-issuing Facebook start route
without a session and accepted only `200` or `302`. Under revisioned local
persistence the route created state without an owner, then surfaced the internal
`workspace_writer_unclassified` denial as `403`. The write did not commit and no
provider request occurred, but that internal classification was not an appropriate
public authentication response.

Facebook Meta start now returns the existing explicit `401` sign-in page whenever
local revisioned persistence is active and no valid session exists. The check runs
before OAuth state creation. Authenticated normal and `testing=pages` paths retain
their existing redirects and persist state with exact initiating owner/workspace
identity. Normal login excludes `pages_manage_posts`; testing adds
`pages_manage_posts`, `pages_manage_metadata` and `business_management` and forces
the profile selector. Direct Instagram Login remains separate and unchanged.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_META_START_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves anonymous and invalid-session denial, no unauthenticated mutation,
authenticated normal/testing redirects, exact scope split, durable owner binding,
revision advancement, private marker omission, zero external requests, child
shutdown, lock release and directory cleanup. Dedicated verification reports
**382** authentication checks, **165** workspace-authorization checks, **111**
local-ownership checks, **9** local-persistence tests and **27** revisioned-model
runtime checks.

The final monolithic suite clears P21 and stops only at the next inherited local
boundary at current `test.mjs:5798`: anonymous `/api/meta/assets` attempts to save
inspection state without an owner and receives `403 workspace_writer_unclassified`,
`commitStatus: not_committed`. Treat that route as independent P22 diagnosis. Do
not weaken local persistence or contact Meta while resolving it.

## P15 Contract Boundary

`hosted-workspace-persistence.mjs` defines a standalone authenticated workspace
adapter. Its loopback-only contract suite proves owner/workspace filters, opaque
`workspace_models.updated_at` revisions, atomic compare-and-swap, strict save
envelopes, stale-client conflicts, same-millisecond advancement, explicit
insert-only bootstrap with readback, exact lost-response replay, private bounded
receipts, ambiguous-outcome failure and restart recovery.

Run the contract without starting the application:

```powershell
node --check hosted-workspace-persistence.mjs
node --check hosted-workspace-persistence.contract.test.mjs
node --test hosted-workspace-persistence.contract.test.mjs
```

The suite also reads `server.mjs` and confirms the adapter is not imported or
initialized. It does not prove a hosted route, production Supabase behavior,
schema/RLS state, JWT gateway, advisors, logging or retained-data conversion.
Do not advertise hosted CSV import/export from this candidate.

## P20 YouTube And Google Business Callback

The inherited authenticated callback loaded shared state, consumed its OAuth
nonce, built the correct owner workspace view and reached the Google token
exchange. Local revisioned persistence then saved the shared model separately and
rejected the owner view as stale with `409 workspace_shared_state_conflict`. The
guard blocked the Google request before dispatch and no account was partially
committed.

Local YouTube callbacks now commit consumed state, renewed session data, sanitized
OAuth audit events and owner-scoped provider records through the workspace view's
single tracked baseline. A missing local state cannot fall back to its signed copy,
so sequential replay is rejected before provider exchange. Signed recovery and the
existing two-write behavior remain available outside local workspace persistence.
Provider credentials remain encrypted and public account serialization remains
scrubbed.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_GOOGLE_CALLBACK_FIXTURE_ONLY = 'true'
node test.mjs
```

The fixture creates separate owner and foreign workspaces; rejects a tampered
state; commits a synthetic failed exchange; rejects failed and successful state
replays; completes mocked YouTube and Google Business callbacks; preserves the
existing HttpOnly session cookie; validates owner/workspace identity, encrypted
storage, sanitized audit rows and public-field omission; restarts the server; and
proves cleanup. Its six provider-shaped calls are handled by the local guard and
no non-loopback request is dispatched.

The accepted P16 Twitch fixture remains green. Dedicated P20 verification reports
**382** authentication checks, **165** workspace-authorization checks, **111**
local-ownership checks, **9** local-persistence tests and **27** revisioned-model
runtime checks. The final monolithic suite clears P20 and stops only at the next
inherited anonymous Facebook Meta OAuth-start assertion at current
`test.mjs:5289`. At the P20 checkpoint the route rejected the request through the
internal `workspace_writer_unclassified` persistence classifier; P21 replaces that
leak with the explicit sign-in-required boundary and authenticates the success
assertions.

## P19 Revisioned Provider State

The inherited authenticated raw `/api/model` POST remains an explicit fail-closed
control: it receives `428 workspace_revision_required`, reports
`commitStatus: not_committed`, leaves `model.json` byte-identical and makes no
external request. A valid revisioned save then attempts `credential`,
`encryptedCredential` and nested `profile.accessToken` injection. The save receives
a normal durable receipt, but the credential markers are absent from private
storage and the public response.

This second control exposed a real accepted-boundary defect before repair: the
public response was scrubbed, but the incoming browser values reached disk.
`mergePublicModelUpdate` now recursively rejects credential-shaped browser input
before `mergeServerOnlyAccountFields` restores private fields from the existing
server-held account. Trusted server-side account merges remain unchanged.

Provider test state is no longer smuggled through a browser snapshot. The harness
stops its server, confirms the local lock is gone, writes 14 encrypted synthetic
account records through `openLocalWorkspacePersistence`, and restarts. Thirteen
nonexpired records are visible publicly, all are owner/workspace scoped, another
signed-in workspace remains blank and two Twitch credential paths collapse to one
posting asset. Later client campaign/cache writes carry current revisions and
operation IDs; the private X refresh fixture also uses the stopped-server adapter.

Run the focused fixture with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_PROVIDER_STATE_FIXTURE_ONLY = 'true'
node test.mjs
```

It proves 428/no-commit behavior, successful revision receipts, browser credential
denial, encrypted adapter persistence, restart survival, workspace isolation,
public secret absence, duplicate-account selection, zero external requests and
cleanup. The full suite advances through provider readiness, truth, dry-runs,
acceptance and ownership, then stops at the next inherited YouTube callback: `409`
`workspace_shared_state_conflict` near current `test.mjs:4422`. A separate
no-restart synthetic reproduction produces start `302` and the same callback `409`,
so this is the next independent persistence task, not a P19 regression. No Google
request was sent.

## P18 Core Model Baseline Repair

The inherited test requested `/api/model` before creating a session. Accepted local
revisioned persistence correctly returned a sanitized `401`; no workspace, model
collection, authentication ledger, OAuth ledger or token field was disclosed. P18
keeps that anonymous request as an explicit fail-closed control.

The fixture then creates its existing synthetic owner through the normal local
signup/session path and loads the same route with that session. The response is
`200`, its workspace ID matches the signed-in workspace, no foreign workspace is
visible, campaigns/quick posts/connected accounts retain their public shapes and
private connected-account credentials and server ledgers remain absent. The focused
fixture makes zero external requests.

Run the focused boundary with native Windows environment syntax:

```powershell
$env:SOCIAL_CUES_CORE_MODEL_FIXTURE_ONLY = 'true'
node test.mjs
```

The single final `npm test` advances past P18 and stops at the next independent
inherited fixture at current `test.mjs:3509`: an authenticated raw `/api/model`
POST omits the conditional-save envelope and receives `428`
`workspace_revision_required`, `commitStatus: not_committed`. Do not weaken the
revision contract in this candidate. No application source changed in P18.

## P17 Shopify Baseline Repair

The original configured Shopify scenario used no signed-in local workspace. The
revisioned persistence boundary correctly rejected both OAuth-state writes with
`403 workspace_writer_unclassified`, but the fixture constructed `new URL("")`
before inspecting either response. With the same synthetic credentials and an
authenticated workspace, the generic and direct starts correctly return `200` and
`302`, carry the expected client ID and callback, and make no external request.

P17 authenticates configured scenarios, checks status and URL presence before
parsing, validates HTTPS shop origin/path/client ID/callback/state, and retains the
full invalid and unknown-alias fail-closed matrix. The workspace-token control is
seeded through the canonical local adapter while its server is stopped, then
reloaded after restart; it remains connected and encrypted without satisfying
application OAuth readiness. All **38** scenarios, **58** executions and **10**
order sequences pass with explicit child shutdown, directory cleanup, secret
absence and zero external requests.

The single final `npm test` advances through Shopify and stops later at the inherited
unauthenticated `/api/model` assertion at current `test.mjs:3120`. The protected
route returns `401` with its sign-in-required response. P17 does not alter that
later fixture or any application source; treat it as the next independent task.

## P16 Twitch Baseline Repair

The inherited `test.mjs:821` failure was caused by two local callback saves sharing
one stale revision baseline. The first advanced shared OAuth/session state and the
second failed closed with `workspace_shared_state_conflict`; no Twitch account was
partially persisted. P16 uses the existing owner-scoped workspace view to commit
those shared changes and the connected account atomically in local mode. Hosted
and nonlocal save behavior is unchanged.

The loopback-only fixture rejects a tampered state before exchange, verifies the
synthetic token/users/validate sequence, confirms the account only in the state-
bound workspace, restarts the server against the same data, proves primary account
survival and foreign-workspace absence, checks public/private output boundaries and
removes the fixture directory. It makes no live Twitch or non-loopback request.

P17 leaves the accepted P16 Twitch callback implementation and evidence unchanged.

## Resume The Current Pilot

Run in Windows PowerShell:

```powershell
Set-Location -LiteralPath 'C:\Users\barto\Documents\Codex\social-cues-app-manual-csv-export-p14-20260906-214700'
git rev-parse HEAD
node scripts/run-local-pilot.mjs --resume ".tmp/local-pilot-YM8Yll"
```

Keep that terminal open. The launcher must report
[the retained local portal](http://127.0.0.1:49321/portal?stay=1).
After signing in, use **Open command center** or
[the app](http://127.0.0.1:49321/app). The pilot is stopped between uses.

This directory was created by the final P14 real-browser check in the current
local format. Do not replace it with old pilot data or copy it into another
checkout. If the directory, dependency junction, port or lock is unavailable,
stop and report it. Do not recreate accounts, steal locks, kill unrelated
processes or overwrite data. Dependencies and browsers were reused; no install
was performed for P14.

## Synthetic Login

Privately open this file locally, without pasting its contents into chat,
screenshots, source or reports:

```text
C:\Users\barto\Documents\Codex\social-cues-app-manual-csv-export-p14-20260906-214700\.tmp\local-pilot-YM8Yll\pilot-access.json
```

Use its existing synthetic account in **Log in**, not Create account or password
reset. The adjacent `pilot-config.json` contains private synthetic session
material and is not needed for the walkthrough. Keep the directory local.

## Inspect The Completed Rehearsal

1. Open **Results**. Existing manual and legacy evidence, campaign variants,
   queue state and the campaign's frozen evidence snapshot remain present.
2. Imported records have URLs under `https://example.test/`. They are labelled
   manual/operator-supplied and not provider-verified. One observed result records
   a measured zero; receipt-only records leave result fields blank.
3. Use **Edit receipt** on an imported record to confirm the ordinary Results form
   restores its explicit campaign, variant, platform, URL, time and observation.
4. Select **Use in self-launch draft**, then **Preview selected evidence**. The
   imported record appears as manual evidence. Do not create a campaign unless you
   deliberately want to alter the synthetic pilot.
5. Choose **Export receipts CSV**. Confirm three compatible saved manual records are
   listed and selection starts empty. Provider-derived and legacy evidence appear
   only as separate exclusion reasons; their private text is not shown.
6. Select only the records intended for the file. The final P14 rehearsal selected
   the formula-leading receipt and measured-zero result while leaving a third eligible
   receipt unselected. **Download reviewed snapshot** does not modify the workspace.
7. Use **Review CSV** on that app-generated file. Its two rows report exact existing
   manual records and cannot be selected, including after reload.
8. Use **CSV template** to confirm the original unmarked ten-column header-only file
   remains available for external input.

The final P14 test also covered quoted commas/newlines/quotes, reversible formula
protection, blank versus measured zero, Cancel/Escape with no writes, a newer saved
revision exposed only after explicit refresh, exact unknown-save retry and current
review, failed saved-content confirmation, in-flight context change, another actual
workspace, mobile/keyboard operation and server restart. All browser traffic was
constrained to the task-owned local server. The inherited P13 import workflow remains
covered separately.

## Export Contract

The export review reads current authenticated saved content after earlier saves
settle and requires no write capability. It shows all ten compatible import fields,
derived platform and manual/unverified provenance before selection. Selection starts
empty. Download uses the explicitly labelled reviewed revision; use **Review latest
saved** to discover another client's later save. A workspace change or different
unresolved operation hides rows and disables download.

App files use `social-cues-manual-receipts-export.v1` before the unchanged ten-column
header. Formula-leading or reserved-prefix cells carry the reversible
`'social-cues-literal.v1:` prefix. Only exact marked files receive that decoding;
malformed markers/escapes reject, and unmarked external imports are unchanged.
Provider-derived, legacy, unassociated, invalid and non-roundtripping records remain
out of the file. Account, billing, provider, approval, queue, media, record identity,
private model and frozen-snapshot fields are not exported.

## CSV Review Contract

Use the exact header documented in `MANUAL-RESULTS.md`. The importer derives the
platform from the existing variant and never guesses campaign or variant IDs.
Every row, association, error and exact-duplicate result appears before saving.
Nothing is selected automatically. Only selected, valid, nonduplicate records are
appended; campaigns, approvals, queue state and frozen snapshots are unchanged.

CSV cell text is rendered as text. It is never executed. URLs are validated but
not opened; metrics are not fetched; no campaign or evidence draft is generated.
The duplicate rule compares validated facts exactly, with documented whitespace
normalization. It is not fuzzy or semantic deduplication.

A concurrent saved change requires **Review latest saved** and a new deliberate
confirmation. A different unresolved save must be reconciled first. An uncertain
CSV import can retry only its identical original operation/request and stable
record IDs. Keep that page open until reconciled; there is no durable browser
operation journal. A workspace change hides the old review. Confirmed import is
disabled where conditional-save capability is unavailable.

## Restart And Stop

In the launcher terminal, type `restart` and press Enter. It reuses the same port,
data and synthetic session configuration. Reload the browser. To finish, type
`stop` or press Ctrl+C and wait for
`Task-owned local pilot stopped; synthetic data retained.`
Do not terminate unrelated processes.

P14 separately resumed this exact directory, served health/portal/app, restarted,
then stopped: **12 checks**, identical model SHA-256 before and after, both locks
absent and zero provider request/attempt. See `.tmp/P14-resume-smoke.json`.

## Evidence And Limits

- P14 real export workflow: **83 checks**, Chromium desktop/WebKit mobile, actual
  local auth/session/model routes, fresh synthetic accounts and labelled transport
  timing/failure injections. Evidence: `.tmp/p14-browser-1788747625333/evidence.json`.
- Inherited P13 real import workflow: **56 checks**.
- Existing manual-entry browser regression: **204 checks**.
- Existing evidence-draft browser regression: **118 checks**.
- Accepted losing-campaign regression: **56 checks**.
- Real concurrent-recovery regression: **21 checks**.
- Mocked content-recovery regression: **72 checks**, separately labelled.
- Real desktop/mobile local pilot: **110 checks**.
- Pure CSV export/import/manual/evidence/recovery/posting/coordination checks: **89 tests**.
- Pricing presentation: **179 checks**, run once after final HTML.

All test servers stopped. No real provider or production request was dispatched.
These are local evidence paths, not deployment artifacts. P15's fake PostgREST
server accepted only loopback requests to `/rest/v1/workspace_models`. The active
backend, authentication, database and provider behavior remains unchanged; carried
forward evidence must not be represented as fresh hosted verification.

Historical P13, P12-R1, P12 and P5/P7/P8 pilot directories remain untouched in their
original worktrees. No retained data was converted. See `RELEASE-READINESS.md`
for remaining hosted, provider, payment and operational gates.
