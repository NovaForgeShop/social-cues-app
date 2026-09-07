# Concurrent Recovery: History and Local Protection

P11 integrates the accepted P10 storage boundary into the local application.
See [Local Revisioned Persistence](LOCAL-REVISIONED-PERSISTENCE.md) for the current
contract and release limits. `concurrent-recovery.browser.test.mjs` now runs the
real two-context protection regression, not the historical lost-update observer.
The P9 observer remains available at commit `af90bf`.

Everything below is historical P9/P10 evidence and design, not the current local
application status. Hosted conditional persistence remains unavailable. R4 HOLD.

## Status and Reproduction

Base: `13d60641fd6b76e3562a2bc842bf9c192575232e` (accepted P8,
single-writer local supported-content recovery only). P9 changes only
`concurrent-recovery.browser.test.mjs` and this document. No persistence fix is
implemented here. R4 remains HOLD.

**Observed: Client A's older recovery preview overwrote Client B's later confirmed
campaign edit. Both saves returned HTTP 200. The lost edit remained lost after an
actual server restart.** This is not a passing multi-client recovery guarantee.

Run from this worktree, with its existing Playwright dependencies available:

```powershell
node --check concurrent-recovery.browser.test.mjs
node concurrent-recovery.browser.test.mjs
git diff --check
```

The harness creates fresh disposable local pilot data, two independent Chromium
contexts and two real sign-ins to the same synthetic user's workspace. All
application requests pass through unchanged; controls perform signup, login,
campaign saves, export, preview and confirmation. Network guards block external
origins. No provider account is seeded, variant generated or publishing job created.
Browser response bodies are projected to supported content; account/session bodies,
credentials and the private model document are not exported as evidence.

Final completed run: `.tmp/p9-reproduction-1788735827161/evidence.json`.
It contains correlated request/response sequence numbers, timestamps, 12 supported
content snapshots and four focused UI screenshots. Canonical JSON SHA-256 hashes
identify content, not raw-file formatting. All times below are UTC on 2026-09-06.

| Sequence | Time | Observation |
| --- | --- | --- |
| 159 / 160 | 23:03:50.962 / .977 | A baseline POST /api/model; HTTP 200 |
| 186 / 187, 313 / 314 | 23:03:51.407 / .420; 51.861 / .873 | B authenticated model GETs; HTTP 200; baseline loaded |
| 319 | 23:03:53.484 | A preview open; disk still contains baseline |
| 321 / 322 | 23:03:53.572 / .588 | B later campaign edit POST; HTTP 200 |
| 324 / 325 | 23:03:53.596 / .678 | B edit projected from disk, then recorded confirmed and persisted |
| 326 | 23:03:53.686 | A still holds the older baseline; local preview fingerprint unchanged |
| 328 / 329 | 23:03:53.749 / .765 | A confirms already-open preview; POST returns HTTP 200 |
| 331 / 332 | 23:03:53.877 | Disk contains older brief; UI says "Recovery confirmed" |
| 333 / 334 | 23:03:53.877 / 55.409 | Actual stop/start; same supported content on disk before any new model GET |
| 338 / 340, 465 / 466 | 23:03:55.672 / .694; 56.289 / .301 | Fresh authenticated page GETs; HTTP 200; older brief remains |

Synthetic baseline brief:
`SYNTHETIC P9 BASELINE. This is disposable campaign content, not a real post.`

B's later saved brief:
`SYNTHETIC CLIENT B LATER CONFIRMED EDIT. Preserve this independently saved campaign edit.`

Baseline content hash:
`32f867bcc034554739ff7d5c1b9c1796e6d31e5c68c0c5f79370e706707f58c3`.
B response/disk hash:
`5c43e14b6a494d2eb0fb151968371f5b565f7026a7291d74f4d8c2425f3c9633`.
A confirmed response, disk, restarted disk and restarted-page hash:
`be8532df271fcbc4d5d05fe9f49adf65d536273cb24f7b8b980bf5eebefd2886`.
The last hash differs from baseline because recovery adds `recoveryRecordedAt`.

The final run exited 0 with 30 explicit checks, no page errors, zero provider
fixture hits, zero blocked server provider attempts and zero external dispatches.
The server changed PID from 24472 to 10092; both were stopped. Cleanup checked the
browser disconnected, server stopped, both PIDs absent, pilot lock absent and
loopback port refusing connections.
No account/session export is needed to reproduce or inspect the evidence.

An earlier attempt, `.tmp/p9-reproduction-1788735485877/evidence.json`, stalled while
Playwright read an ordinary save's unconsumed response body, before the two-client
sequence. Its browser was stopped explicitly; the harness then verified cleanup.
The observer now consumes a clone of the actual page fetch response and has bounded
response waits. This was a harness observation issue, not concurrency evidence.
An intermediate successful run (`1788735607613`) also observed the loss; the final
run adds whole-supported-content equality and stricter cleanup absence checks.

## Existing Persistence Boundaries

Line references are for P8, unchanged in P9. Findings below are code observations,
not proof of production behavior or schema state.

| Location | Relevant behavior |
| --- | --- |
| `social-cues-app.html:4015` | `enqueueHostedModelSave` serializes this page's snapshots only; POST has no server revision |
| `social-cues-app.html:4034` | `saveModel` increments a browser-local counter and queues a full sanitized snapshot |
| `social-cues-app.html:6196` | `recoveryModelKey` fingerprints only A's local model; B cannot invalidate that fingerprint |
| `social-cues-app.html:6247` | `applyRecovery` checks local state, replaces supported content and trusts matching successful response |
| `server.mjs:21252` | GET /api/model loads, bootstraps and calls `saveModelForUser`: a read is also a write |
| `server.mjs:21276` | POST /api/model does authenticated read/ownership validation/merge/save with no revision precondition |
| `server.mjs:14528` | `mergeOwnedArray` preserves retained/runtime fields but replaces the user's incoming owned content |
| `server.mjs:6373` | `localGetModel` can replace unreadable JSON with seed data; unsuitable as authoritative error recovery |
| `server.mjs:6391` | Local queue covers temp-file write/rename, not earlier read/merge; no cross-process exclusion or CAS |
| `server.mjs:6443` | `supabaseSaveModel` upserts shared app_state without a precondition |
| `server.mjs:6713` | Registry-to-workspace lookup failure can produce a new default workspace |
| `server.mjs:6892` | `mirrorWorkspaceModel` writes workspace rows, snapshot, then normalized rows; catches errors as `{ok:false}` |
| `server.mjs:7022` | Normalized mirroring uses separate requests; no transaction with the snapshot or registry |
| `server.mjs:7624` | Workspace read overlays normalized/runtime data and may write a quarantine/bootstrap snapshot |
| `server.mjs:7692` | `modelForSession` can return a new workspace after hosted load failure |
| `server.mjs:7705` | `loadModel` can fall back to local storage and persist normalization changes |
| `server.mjs:7944` | `saveModel` catches cloud write failures and returns a local save |
| `server.mjs:7953` | `saveModelForUser` ignores failed workspace-mirror result, saves registry, returns workspace |

Local authority is the task data directory's `model.json`, containing shared and
workspace data. Hosted workspace content currently lives in
`public.workspace_models.model`, keyed by `workspace_id`; `app_state.primary` is a
separate shared registry, not an acceptable content-failure fallback. The starter
schema defines workspace_models at `supabase-schema.sql:25` and authenticated owner
insert/update policies at lines 218/223. It has no revision or commit receipt.
This is repository schema evidence, not a live grants/schema inspection.

Other writers matter even if only recovery gains a new precondition: GET/bootstrap,
normalization/quarantine, workspace startup/auth flows, media completion, OAuth and
webhook callbacks, and workers reach `saveModelForUser` or direct mirroring. For
example, scheduled-publish/status and audience workers call it at 9414, 9496 and
9685; media completion at 21196. This is a persistence call-site classification,
not a provider implementation audit. The request-local AsyncLocalStorage cache
around `getModel` does not protect against another request. A stale non-content
writer must not later reintroduce old campaigns through a full snapshot.

## Recommended Contract: One Revisioned Workspace Commit Boundary

All names in the design below are **proposed**, not existing fields/endpoints.
Keep existing authentication, membership, ownership and retained operational-field
rules. A revision is not authorization and must never select another workspace.

1. Issue a server-owned `(workspace_id, epoch UUID, revision bigint)` token for the
   persisted workspace snapshot. Revision starts at zero, increases once per
   semantic snapshot commit, is serialized as a decimal string and never comes
   from timestamps or the imported file. A new incarnation gets a new epoch to
   prevent old requests matching a recreated workspace. Read-only runtime overlays
   such as loadedAt and registry session metadata are outside this revision.
   Per-workspace scope avoids unrelated workspaces invalidating one another.
2. GET /api/model returns the authoritative snapshot and `modelRevision` from the
   same read, with no-store caching. Make steady-state GET read-only. Initialization
   is an explicit, idempotent transaction under the same writer boundary; default
   creation is permitted only after a confirmed absent row/file, never on error.
3. POST /api/model requires `expectedRevision` and a random `operationId` bound to
   the authenticated workspace and actor. Normal campaign/proof edits and recovery
   use the same contract. Recovery sends only the versioned supported-content
   replacement, not account/provider/billing data from an imported full model.
   The server validates the projection and current operational references again,
   preserving existing ownership checks. Runtime context cannot come from the file.
4. Atomically reread current state, check authorization, look up operation receipt,
   compare expected revision, validate/merge allowed changes into current state,
   write snapshot plus next revision and receipt, then acknowledge. No read/merge
   before the atomic boundary may authorize a stale replacement. Same-base writes
   have at most one winner. Ordinary unrelated semantic snapshot edits may cause a
   conservative conflict; do not conceal that with automatic whole-model merging.
5. Return HTTP 428 `workspace_revision_required` for a missing precondition; HTTP
   409 `workspace_revision_conflict` for a stale token, with current revision only
   after authorization; HTTP 503 `workspace_storage_unavailable` for read/write
   failure. Missing/forbidden session remains 401/403. Never translate storage
   failure into empty success, seed replacement, local cloud fallback or conflict.
   A possibly committed request gets `commitStatus: "unknown"`, not "not saved".
6. On conflict, preserve the operator's unsaved input, invalidate the preview,
   stop queued snapshots from the stale base, fetch current state and require a
   new explicit review. Display both intended replacement and current content.
   A newly reviewed replacement gets a new operation ID and current revision.
   No blind retry/rebase of an old recovery preview. Per-page chaining remains
   useful, but cannot provide inter-client correctness.
7. Save receipts durably with `(workspace_id, epoch, operation_id)` uniqueness,
   authenticated actor, operation kind, canonical validated payload hash, result
   revision and result-content hash. Resolve duplicate operation IDs before stale
   revision rejection. Same actor/input returns the original receipt, not another
   write; different input returns 409 `operation_id_reused`. If the workspace has
   advanced, return the old receipt marked superseded and require a current GET;
   never pass an old receipt off as the current workspace. Retain receipts for the
   workspace epoch in the initial implementation; later pruning needs an explicit
   replay-expiry protocol. A storage timeout retains the same ID/input for retry.

## Local Atomicity and Durability

Put server-private per-workspace epoch/revision/receipt records alongside content
in the same `model.json` replacement, excluded from public serialization and all
incoming merges. Every write to this shared file must enter one transaction queue
that rereads it before applying an explicit mutation to current state. Preserve
other workspaces and registry changes; do not write an old whole-file clone.

Enforce one server writer per resolved local data directory, using an exclusive
server-owned lock file (`open` with `wx`) acquired before serving requests and held
through shutdown. A second server fails startup. No age/PID-only lock stealing:
after an unclean stop, require an explicit offline, verified owner-lock recovery
before reopening the directory. The existing optional pilot launcher lock is not
this application guarantee. Uncoordinated file editors/old binaries remain outside
the contract and must not share the data directory.

Inside the queue: reread, compare, merge, serialize state plus receipt, write a
same-directory temp file, flush it, close, rename atomically and flush the directory
where supported before returning success. Clean process restart must preserve the
token and dedupe receipt. A temp-write/rename failure must not report success or
advance the revision; ambiguous post-rename failure is reconciled by operation ID.
Unreadable storage fails closed; retain damaged data for explicit repair.
Power-loss durability on Windows/filesystems without verified directory/write-
through semantics is a separate qualification, not proven by P9's normal restart.

## Hosted Atomicity and All-Writer Gate

Use a short PostgreSQL transaction, not a frontend lock or an in-process mutex.
Add `epoch uuid` and `revision bigint` to workspace_models and a
`workspace_model_commits` receipt table. A proposed service-only
`social_cues_commit_workspace_model` RPC locks the workspace row, checks the
receipt/precondition and writes the model/revision/receipt in one transaction.
Bootstrap uses the same initialization path. Lock workspace first, then receipt,
in a consistent order. No provider/network calls while holding database locks.
Check actor/workspace authorization against the existing canonical membership
policy, including again inside the transaction; do not broaden roles or ownership.

Fence unconditional table writes: remove direct snapshot insert/update privileges
from exposed API roles, including the service API role used by old REST upserts,
and grant only the narrow RPC entry point needed by the server. Use a dedicated
least-privilege function owner with a fixed search_path; reject anon/authenticated
RPC calls and never expose service credentials to browsers. Preserve authorized
read RLS. Verify effective privileges, function signatures and all remaining
privileged SQL writers in disposable PostgreSQL/PostgREST before any rollout.
This is a proposed narrowing migration, not permission to change a live account.

Route every server workspace snapshot writer through the revision repository.
Content mutation requires a known base revision; non-content mutation must be a
field-scoped intent applied to the current row, preserving current supported
content. A worker result that legitimately changes a campaign must revalidate its
target/base and commit a scoped change, not replay its pre-network full model.
Do not replay an external action after a database conflict. Unknown snapshot
mutation must reject until classified. Existing account/provider/billing policies,
credentials, dispatches and receipts stay outside the content replacement.

**Release gate:** a recovery-only route patch is insufficient while GET, fallback,
mirror or another writer can perform unconditional snapshot replacement. Central
adapters and their callers must prove complete writer coverage before claiming
hosted concurrency safety. Domain-specific adaptation beyond persistence intent
needs its own authorization; until then, hold hosted rollout rather than weaken
the precondition or silently preserve incompatible behavior.

## Actual Atomic Guarantee and Separate Writes

The proposed atomic guarantee covers workspace snapshot, revision and commit
receipt only. Existing workspace-row creation, normalized rows and app_state
registry writes are separate. Content-only saves must not invoke broad normalized
mirroring, which can touch account/token, device, queue/delivery and entitlement
rows. No provider or billing row belongs to the content recovery transaction.

If a future operation genuinely requires normalized content mirrors, commit an
ordered, revision-tagged outbox in the snapshot transaction and process it
idempotently, or move only those required rows into the same database transaction.
Until then there is no atomic whole-model/registry/normalized-row guarantee. A
snapshot committed followed by a failed separate write is partial completion;
report its actual status, never local fallback success or an unqualified rollback.
Reads must not substitute stale mirrored/default data for authoritative content.

## Exact Next Implementation Scope

These are future changes; **none are made or migrated by P9**:

| File | Required responsibility |
| --- | --- |
| `workspace-content-persistence.mjs` (new) | Typed revision/operation contract, validated supported projection, local commit queue and hosted RPC adapter; distinct conflict/storage errors |
| `server.mjs` | Wire GET/POST, public revision serialization, fail-closed content reads, bootstrap and all snapshot writer adapters; stop ignoring mirror failure; separate content saves from broad mirroring |
| `social-cues-app.html` | Carry revision per workspace, normal-save/recovery operation IDs, conflict stop/re-review, response-loss reconciliation and stale-response guards |
| `SUPABASE-WORKSPACE-MODEL-REVISION.sql` (new) | Revision/epoch/receipt schema, atomic service-only RPC, scoped grants and no-unconditional-writes boundary |
| `supabase-schema.sql` | Align clean-install snapshot schema with the reviewed migration |
| `workspace-content-persistence.contract.test.mjs` (new) | Contract/projection/error/replay cases with synthetic data |
| `workspace-content-persistence.runtime.test.mjs` (new) | Local storage failure, writer exclusion, atomicity and restart tests |
| `workspace-content-persistence.postgrest.test.mjs` (new) | Disposable database two-instance CAS, rollback, RLS/grants and replay proof |
| `concurrent-recovery.browser.test.mjs`, `content-recovery.browser.test.mjs` | Convert this observation into required conflict/re-review acceptance once implemented; retain real authenticated two-client coverage |
| `CONCURRENT-RECOVERY.md` | Replace design claims with exact verified guarantees and explicit remaining limits |

Focused acceptance cases for that implementation:

- Same-base A preview/B normal edit/A confirm: B wins; A gets 409, keeps input,
  reloads and re-reviews; B survives restart. Reverse ordering and two normal
  edits also have one winner. Two workspaces do not invalidate each other.
- Two separate hosted server processes race a database barrier: exactly one
  revision commit. An in-process-only test is insufficient.
- Lost successful response plus identical retry commits once, including after
  restart; altered input under the same ID rejects. A later writer remains intact
  when an older operation receipt is retrieved.
- Missing/stale/foreign epoch and cross-workspace ID do not write or disclose
  another tenant. Existing role restrictions and protected fields remain intact.
- GET/bootstrap, normalization/quarantine, registry-triggered mirroring and
  scoped runtime writes cannot replay old content. Legacy unversioned clients and
  direct REST snapshot updates reject. Clean authorized reads do not increment.
- File read/parse/write/rename failures and hosted read/commit failures produce
  storage errors, not conflict/default/local success. Inject failure before/after
  commit to prove both rollback and unknown-outcome reconciliation.
- Content/revision/receipt survive normal process restart. Second local writer
  fails startup; crash-lock handling is fail-closed and explicit. Report any
  unqualified power-loss/filesystem guarantees as unverified.
- Content recovery cannot create publishing work or change account/billing data;
  no secret/account/session material in receipts, projected evidence or logs.
  Check all test-owned processes, locks and disposable database resources absent
  before declaring cleanup complete.

P9 establishes the local lost-update example and a code-grounded design only.
It does not verify hosted concurrency, live Supabase policies, production logging,
crash/power-loss behavior, media recovery or cross-domain transactional atomicity.

## P10: Implemented Local Module, Not Application Integration

`workspace-content-persistence.mjs` exports `openWorkspaceContentStore` and
`WorkspaceContentPersistenceError`. It uses Node built-ins only. The server and
frontend do not import it; P9's application lost-update defect is still open.

### Adapter API

Open with `{dataDir, authorize, validateContent, mutations}`. Authorization and
validation callbacks must synchronously return exactly true. Mutation handlers
are a trusted server-configured map keyed by operation kind, not client-supplied
functions. Callbacks receive copies; mutations receive only fresh target content,
original request, actor ID and workspace ID. They cannot accidentally mutate the
store's other workspace, shared state or private receipt object through references.

`authorize` receives `{action, kind, actorId, workspaceId, shared, content}` after a
fresh file read. `action` distinguishes read, initialize and commit independently
of the mutation's kind. The future server adapter must derive actor/workspace from
its authenticated session and run existing canonical ownership/membership rules
against fresh state. `validateContent` must enforce the existing approved projection
and protected-field rules. This module does not invent roles or sanitize arbitrary
application content; only validated supported content belongs in a content slot.
Callbacks must be synchronous and free of network/provider side effects.

```js
const current = await store.read({ actorId, workspaceId });
const result = await store.commit({
  actorId, workspaceId, kind: "configured-server-mutation", operationId,
  expectedRevision: current.revision,
  request: originalSupportedRequest
});
await store.close();
```

Each token is `{epoch: UUID, revision: decimalString}`. BigInt arithmetic prevents
precision loss; JSON never carries a numeric revision. A new store issues an
independent epoch and revision "0" for each workspace. A newly accepted operation
advances revision once, even if its validated content happens to be identical.

The complete original commit envelope is captured before queuing and canonically
hashed, including actor, workspace, kind, ID, expected token and original request.
JSON object-key ordering is immaterial; malformed/non-JSON/accessor inputs reject.
Application handler changes to its request copy cannot alter the receipt binding.
Replay checks authorization again, then checks the durable receipt before rejecting
the old base revision. Different input/actor/kind under the same workspace's ID
rejects. A superseded receipt returns its original committed revision, the current
revision and `superseded: true`, with **no old content**. Unsuperseded reads/results
return content copies; private actor/hash/receipt records and shared state are not
part of those projections. Revision metadata returned explicitly is not a secret
or an authorization credential.

### File and Failure Contract

The standalone versioned `model.json` envelope is
`{format, shared, workspaces: {id: {content, epoch, revision, receipts}}}`. It is not
the existing server model format. Legacy files reject without conversion or seed
replacement. `initialize({actorId, shared, workspaces})` is an explicit authorized
bootstrap for a confirmed absent file only; existing, unreadable and corrupt files
are not reinitialized. Bootstrap requires at least one workspace. An empty map on
an absent store rejects with `workspace_input_invalid` (400) before writing, even
when callbacks would allow it; a denied nonempty bootstrap still rejects. Existing
stores retain their earlier `workspace_already_initialized` guard without changing
bytes. Empty-store creation and an add-workspace API are not introduced by P10-R1.
Every public operation serializes through one queue and
rereads storage. The resolved directory's exclusive `.workspace-content.lock`
blocks a second cooperating writer, including path aliases. There is no age/PID
stealing; after a crash, offline verification and explicit lock recovery remain
operator work. `close()` drains admitted work before releasing the owned lock.

Each commit writes content, revision and receipt in one same-directory temporary
file, flushes/closes it, then replaces `model.json`. Non-Windows directory flush is
attempted and failure is reported; Windows explicitly returns
`durability.directorySynced: false`. All platforms report power-loss guarantees as
unqualified. Normal process-restart persistence is tested, not power-loss recovery.
Receipt history is not pruned; a configurable 64 MiB default file bound fails closed
instead of silently deleting receipts. Shared-data mutations and adding workspaces
to an existing store are not exposed in this delivery.

| Error code | Status / commit status |
| --- | --- |
| `workspace_revision_required` | 428 / not_committed |
| `workspace_revision_conflict` | 409 / not_committed |
| `workspace_operation_id_reused` | 409 / not_committed |
| `workspace_authorization_failed` | 403 / not_committed |
| `workspace_writer_busy` | 409 / not_committed; distinct from a revision conflict |
| `workspace_storage_unavailable` | 503 / not_committed before replacement is attempted |
| `workspace_commit_unknown` | 503 / unknown during/after a rename attempt or response loss |

Invalid input/content has a 400-class error; closed/lost-owner state fails closed.
An actual rename rejection is conservatively unknown: there is no fallback success.
Retry the identical operation after storage becomes readable; its receipt determines
whether it committed. Never generate a new ID to resolve an ambiguous outcome.
Errors expose stable codes/phases, not private callback or storage diagnostics.

### Focused Proof and Integration Gate

```powershell
node --check workspace-content-persistence.mjs
node --check workspace-content-persistence.contract.test.mjs
node --check workspace-content-persistence.runtime.test.mjs
node --test workspace-content-persistence.contract.test.mjs workspace-content-persistence.runtime.test.mjs
git diff --check
```

The focused suite has 33 tests. It exercises same-base one-winner commits, unrelated
content preservation, canonical replay/actor binding, superseded receipts, fresh
mutation input, private metadata exclusion and decimal precision beyond 2^53.
Actual filesystem/child-process cases prove clean restart and retry, second-writer
exclusion, stale-lock retention, invalid storage preservation and real non-file/read
and rename errors. Labeled hooks simulate prewrite/sync/rename and post-rename/
response failures; IPC receipt suppression is synthetic transport loss, not an HTTP
test. The runtime evidence JSON records actual process IDs, restart scenarios and
verified child/directory cleanup. An earlier test cleanup-order defect was corrected
before the successful suite; no application behavior was changed to pass it.

Before server integration: design an explicit offline conversion from the existing
shared model to this envelope, preserving all canonical ownership and unrelated
state, or review an equivalent adapter format. Do not point this prototype at dirty
main's data or silently start a second content authority. Classify and route every
legacy whole-model writer, shared-data transaction and workspace-creation path
through the ownership/transaction boundary before enabling it. Noncooperating old
processes, manual file edits and arbitrary callback side effects are outside its
exclusive-writer guarantee.

Then wire authenticated server reads/commits without GET/default/fallback writes,
add frontend revision/conflict/re-review and retry handling, and rerun P9's real
two-context reproduction as a required protection test. Hosted database/RPC/grants,
all-writer coverage and normalized/registry atomicity remain separate future work.
No hosted code, migration, application adapter or deployment is included in P10.
