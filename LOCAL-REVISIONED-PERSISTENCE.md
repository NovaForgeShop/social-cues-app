# Local Revisioned Persistence (P11)

Base: accepted P10-R1 `9d4f6df8e34f02753a01fc7d2c55337949a57744`.
This is a local integration candidate, not a retained-data or production rollout.
R4 remains HOLD. Hosted database/RPC/schema and provider/billing domain rules are
unchanged; no external-action retry is introduced.

## Application Contract

`server.mjs` opens `local-workspace-persistence.mjs` before serving only when
Supabase storage is disabled and the runtime is not Vercel. The adapter uses the
accepted store's same resolved-directory lock, serialized queue, fresh reads,
atomic temporary-file replacement and durable operation receipts. There is one
live `model.json`, with shared registry and per-workspace content in the versioned
envelope. Metadata is owned by the storage layer, never a client snapshot.

A fresh directory remains file-absent until authorized signup atomically creates
the account registry and a nonempty canonical owned workspace. Signup/onboarding,
authenticated session and later workspace creation are tested with synthetic
accounts. Invalid JSON, legacy format, invalid canonical identity and disappearing
observed files fail closed without seed/reset writes. The original empty-store
initialize rejection remains intact. A normal shutdown drains requests and saves,
then releases the lock. SIGINT/SIGTERM and the local launcher IPC shutdown use this
path. Abrupt termination can leave a lock; there is no automatic stealing.

Authenticated GET `/api/model` exposes `persistence.conditionalSave` and
`persistence.revision: { epoch, revision }`, where revision is a decimal string.
Local POST `/api/model` requires exactly:

```json
{
  "kind": "model-save or content-recovery",
  "operationId": "stable-original-operation-id",
  "expectedRevision": { "epoch": "server-issued-epoch", "revision": "1" },
  "request": {}
}
```

Normal saves retain the existing canonical ownership/public-model merge contract.
Browser snapshots do not replace the shared auth, provider or billing registry.
Recovery requests use `social-cues.campaign-content.v1` and validated supported
content only. `local-recovery-validation.mjs` compiles bounded pure validators from
the trusted shipped HTML, not request code, to avoid a second schema definition.
This use of `node:vm` is source reuse, not a security sandbox claim.

Missing revision is 428; stale revision and reused operation ID are distinct 409
codes; bad input is 400; unclassified/unauthorized writers are 403. Storage failure
is 503 with `commitStatus: not_committed` or `unknown`. Client receipts bind actor,
kind, original request hash and committed revision. Exact retries are idempotent.
Superseded acknowledgments omit content and identify the current revision.

The UI preserves the losing draft and eligible unsaved inputs in memory, blocks
stale queued writes, and loads current content separately. It never automatically
rebases a recovery preview. Explicit current-state review plus another confirmation
is required. Unknown responses retry the identical original operation. Sensitive
credential/password/file inputs are excluded from retained input capture.

## Writer Audit

`local-workspace-writers.contract.test.mjs` inventories every current server save
call into `.tmp/local-writer-inventory.json` with exact line, caller, statement and
category. This is a review aid and bounded source regression, not a substitute for
the runtime concurrency/authorization tests.

| Writer family | Current local behavior |
| --- | --- |
| `ensureModel`, `localGetModel`, `renameLocalModelWithRetry`, legacy `localSaveModel` | Only four direct filesystem mutation statements exist in the server. Integrated local branches return before these legacy paths. Hosted fallback is unchanged. |
| `loadModel`, GET model/session/devices | In-memory normalization only; no steady-state local file rewrite. Runtime byte-comparison proves these reads do not save. |
| POST model, onboarding, campaign/manual-proof/evidence/recovery | Client envelope with canonical owner, reviewed revision and operation receipt. |
| Signup/login/password/device/MFA/invite/logout and `/app` session bookkeeping | Server-captured baseline; authenticated actor or explicit signup. Shared deltas merge against fresh registry; conflicting leaf changes reject. |
| Proof/actions/generation/intelligence/queue/approval/due/automation/ads/campaign/analyze/media and synthetic e2e account routes | Captured workspace revision for any content-changing delta. No stale full-file overwrite. |
| Scheduled publish, publish status, analytics collection, audience brief worker helpers | Same tracked-model save boundary. Missing owner/baseline rejects; stale content conflicts. Persistence failure is non-retryable and cannot restart a provider action. |
| OAuth starts/callbacks, provider/account checks, Meta/Discord/ManyChat/ElevenLabs operations and provider refresh/readback helpers | Shared changes preserve current content; changed connected accounts/activity/content require captured revision. Untracked clones or ownerless saves reject. |
| Patreon/LinkedIn/Discord webhook helpers and Meta callbacks | Same boundary; only a tracked, canonically owned context may write. Ownerless shared-file webhook writes reject rather than bypassing authorization. |

All remaining server model writers converge on `saveModel`/`saveModelForUser`.
`localPersistenceWrite` poisons the current request after a storage/ownership
failure, preventing catch handlers from retrying stale state or returning JSON
success. The adapter checks fresh canonical identity on reads and transactions,
preserves foreign workspace contents and forbids deleting existing entries.
Unclassified callback/worker contexts are intentionally unavailable locally; this
does not certify live provider flows. The local pilot dispatch guard blocks them.

Workspace content comprises campaigns, quick posts, actions, proof, media assets,
render jobs, publish queue, analytics/provider snapshots, activity, connected
accounts, and per-workspace editing/settings fields (including brand kit).
Derived `analytics` and the account/provider/billing registry remain shared.
Three-way shared changes apply only actual caller edits, preserving newer content;
changed content compares its captured revision. Simultaneous conflicting shared
fields reject. A health refresh changing derived analytics alone does not bump the
editable-content revision.

## Offline Synthetic Conversion Only

`scripts/convert-synthetic-local-workspace.mjs` requires `--synthetic-copy`, source
marker `syntheticFixture: social-cues.p11-offline-copy.v1`, source and new target
inside resolved disposable `.tmp` directories, a regular source file, no source
pilot/storage lock and an absent target. It validates canonical ownership and
preserves shared registry plus every workspace's owned collections. Legacy scalar
editing fields belong only to the legacy active workspace. Source bytes and SHA-256
are checked unchanged. No real/retained data was converted; this is not an operator
migration tool or authorization to convert retained P5/P7/P8 pilots.

## Verification

```powershell
node --test workspace-content-persistence.contract.test.mjs workspace-content-persistence.runtime.test.mjs local-workspace-persistence.contract.test.mjs local-workspace-writers.contract.test.mjs content-recovery.contract.test.mjs
node local-revisioned-model.runtime.test.mjs
node concurrent-recovery.browser.test.mjs
node content-recovery.browser.test.mjs
node local-pilot.browser.test.mjs
node --test local-pilot.launcher.test.mjs
npm.cmd run test:auth-verification
npm.cmd run test:workspace-authorization
node local-workspace-ownership.contract.test.mjs
npm.cmd run test:pricing-presentation
git diff --check
```

The real two-context browser test uses real local routes/processes. It covers both
recovery orderings, two ordinary same-base saves, preserved drafts, halted queue,
explicit re-review, receipt retry after deliberately suppressing an actual response,
and normal restart. The separate route test covers unrelated workspaces, shared
heartbeat/health changes, stale/replayed/superseded operations and read-only GETs.
Injected faults and mocked browser-only projection tests are separately labeled.
No real provider dispatch is part of this evidence.

Hosted recovery advertises unavailable until a separately reviewed conditional
database boundary exists. Receipts currently grow with operations within the
store's size limit; no unsafe pruning is added. Windows directory-sync and
power-loss guarantees remain qualified by P10. Process failure recovery, retained
data rollout, production schema drift and external provider acceptance are not
claimed. Root `server.mjs` remains the only deployment entrypoint.
