# R4 Hosted Persistence Integration Plan

## Decision And Scope

**R4 remains HOLD and NO-GO.** This plan is based on deployed P33 commit
`a445a6bd2b7876740dc64a384ae41f1a66ae5b9a` (tree
`a2dda7f77047a8adc4928fe922fd62eb02be05c6`). It does not authorize a schema
change, production query, hosted write, retained-data conversion, provider call,
billing action, deployment, or external tester invite.

Root `server.mjs` remains the sole deployed server entrypoint. `vercel.json`
points its function and cron to that root module and does not point to
`api/server.mjs`. Do not create a second server entrypoint during R4.

Until every GO gate in this document is satisfied against one exact release
candidate, the public deployment is a non-data-bearing demonstration. It must
not accept or retain external tester workspace content, media, provider
credentials, provider accounts, or other user data.

## Evidence Labels

Every statement in this document belongs to one of these classes:

| Label | Meaning |
| --- | --- |
| **CURRENT SOURCE** | Directly observable in commit `a445a6b`; it is not a claim about the live database. |
| **ACCEPTED INERT EVIDENCE** | A local, loopback-only contract passed and remains deliberately disconnected from `server.mjs`. |
| **REJECTED HISTORY** | An incomplete P15 worktree experiment; it is not an integration candidate and must not be copied. |
| **PROPOSED DESIGN** | Work to be reviewed and implemented in later phases. It is not current behavior. |
| **LATER LIVE VALIDATION** | Evidence that must be collected only under a separately authorized Supabase or deployment task. |

Local fixtures, source assertions, status routes, environment-variable presence,
and a successful deployment do not establish live schema state, RLS, grants,
JWT behavior, durability, multi-instance correctness, backup recovery, or data
deletion.

## Current Source Data Flow

### Hosted request path

The current data path is:

```text
request
  -> requestModelContext / getModel
  -> loadModel
  -> supabaseGetModel
  -> service-role GET app_state?id=eq.primary
  -> sessionFromRequest
  -> modelForSession
  -> service-role GET workspace_models by workspace_id
  -> route/helper mutates an in-memory whole model
  -> saveModelForUser
  -> mirrorWorkspaceModel
       -> upsert workspaces
       -> upsert profiles
       -> optional upsert workspace_members
       -> unconditional workspace_models upsert
       -> multiple normalized-table writes
  -> saveModel(serverRegistryModel(...))
       -> upsert app_state.primary
       -> on failure, localSaveModel under the Vercel /tmp data directory
  -> route may return success
```

The corresponding **CURRENT SOURCE** anchors are:

| Concern | Source anchor | Current behavior |
| --- | --- | --- |
| Hosted data directory | `server.mjs:52-62` | `SOCIAL_CUES_DATA_DIR` wins; Vercel otherwise uses `/tmp/social-cues-data`. |
| Supabase activation | `server.mjs:195-197` | Requires URL, a service credential, and `SUPABASE_ENABLED` not equal to `false`. |
| Service-role REST client | `server.mjs:5892-5931` | `supabaseRequest` uses the server credential for PostgREST requests. |
| Hosted auth mode | `server.mjs:6018-6034` | Vercel is Supabase auth or unavailable; local-password auth is not selected there. |
| Shared registry read/write | `server.mjs:6451-6471` | Loads or merge-upserts the single `app_state.primary` JSON document. |
| Server identity helpers | `server.mjs:6617-6627` | Workspace and owner UUIDs are selected from user fields; content and registry key sets are declared. |
| Shared registry projection | `server.mjs:6662-6699` | Clears content arrays but retains authentication, device, OAuth, billing, and integration registry fields. |
| Blank workspace construction | `server.mjs:6733-6830` | A failed/missing workspace lookup can become a newly constructed client workspace. |
| Public workspace snapshot | `server.mjs:6832-6868` | Filters owned content, strips registry fields, publicizes connected accounts, and empties device sessions. |
| Workspace row provisioning | `server.mjs:6871-6910` | Performs separate workspaces, profiles, and membership upserts. |
| Snapshot mirror | `server.mjs:6913-6935` | Merge-upserts `workspace_models` without a precondition, then mirrors normalized rows; errors become `{ok:false}`. |
| Normalized mirrors | `server.mjs:7043-7296` | Accounts, encrypted tokens, devices, queue state, receipts, analytics, and billing are written through separate requests. |
| Workspace snapshot read | `server.mjs:7645-7710` | Filters `workspace_models` by workspace only, then overlays normalized/runtime state. |
| Read failure handling | `server.mjs:7713-7723` | A hosted workspace read error is caught and replaced with a blank workspace model. |
| Global load fallback | `server.mjs:7726-7805` | Supabase load errors fall back to local storage; read-time normalization may call `saveModel`. |
| Generic saves | `server.mjs:7981-8005` | Supabase failure falls back to local save; workspace mirror failure is not enforced before success. |
| Session resolution | `server.mjs:14189-14277` | Resolves a device token and, in Supabase mode, validates or refreshes the Supabase user. |
| Hosted write gate | `server.mjs:14279-14304` | Requires a session and, on Vercel, an active application entitlement. |
| Workspace mutation | `server.mjs:14316-14417` | Workspace identity and ownership stamping occur after session resolution. |
| Model GET/POST | `server.mjs:21375-21457` | GET can bootstrap/save; POST accepts a whole-model merge and calls `saveModelForUser`. |
| Runtime initialization | `server.mjs:28322-28343` | The revisioned local adapter is local-only; all other modes call `ensureModel`, including Vercel. |
| Deployment entrypoint | `vercel.json:1-17` | Deploys root `server.mjs`; cron calls `/api/cron/workers`. |

The current configuration names relevant to this boundary are `AUTH_PROVIDER`,
`SUPABASE_ENABLED`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` or
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` or
`SUPABASE_SERVICE_ROLE_KEY`, and `SOCIAL_CUES_DATA_DIR`. This plan records names
only. It neither reads nor defines their values.

### Current schema boundary

`supabase-schema.sql:7-31` defines:

- `app_state(id, model, updated_at)`, keyed by text `id`;
- `workspace_models(workspace_id, owner_user_id, model, created_at, updated_at)`,
  keyed only by `workspace_id`;
- no explicit epoch, monotonic revision, request digest, operation receipt, or
  commit ledger column/table.

`supabase-schema.sql:159-178` enables RLS on both tables and denies exposed roles
access to `app_state`. `supabase-schema.sql:212-226` gives authenticated users
owner-and-entitlement-scoped select/insert/update policies on `workspace_models`.
Those policies do not constrain the service-role requests currently issued by
`supabaseRequest`.

`SUPABASE-PER-USER-MIGRATION.sql:7-215` adds normalized membership, account,
token, session, entitlement, analytics, audit, webhook, receipt, outbox, invite,
and rate-limit tables. Its RLS and grants at lines 263-382 deliberately keep
secrets and service ledgers inaccessible to `anon` and `authenticated`. The
migration does not add a workspace snapshot revision or durable model-commit
receipt.

This is repository schema evidence only. The production schema, migration
history, RLS enablement, grants, function ownership, JWT claims, and advisors
have not been inspected by P34.

### Current writer surface

`local-workspace-writers.contract.test.mjs:54-81` discovers more than 150 model
save call sites and assigns local-era categories. That is useful inventory, but
it does not enforce a hosted repository boundary.

Every current whole-model or mirror writer must be classified before R4 wiring:

| Writer family | Representative anchors | Required future treatment |
| --- | --- | --- |
| Core load/save/bootstrap | `server.mjs:7681`, `7804`, `7981-8005`, `21375-21457` | Replace hosted whole-model paths with explicit read, initialize, and commit operations. |
| Durable workers | `server.mjs:9455-9760` | Apply a scoped result to a freshly locked workspace; never replay a pre-provider snapshot. |
| Provider webhooks | `server.mjs:10713`, `10836`, `11734-11752` | Separate idempotent ingress/normalized writes from an optional workspace intent. |
| Provider refresh/repair helpers | `server.mjs:12510-13686` | Commit only provider-state deltas against fresh state; an inspection GET must not overwrite content. |
| OAuth callbacks | `server.mjs:19872-21060`, `24097-24149` | Consume state and store normalized credentials idempotently; do not dual-write stale snapshots and registry data. |
| Authentication/device/workspace | `server.mjs:21460-22131` | Use normalized identity repositories; signup initialization is explicit and idempotent. |
| Workspace content/media | `server.mjs:21277-21457`, `22285-23526`, `25143`, `26560`, `28285` | Client writes require a revision envelope; server writes use narrow typed intents. |
| Provider/account/community routes | `server.mjs:23625-24923`, `26414-28108` | Read-only inspection stays read-only; state changes use a typed intent and exact actor/workspace context. |
| Shared registry-only state | `server.mjs:18568-19155`, `19608-19853`, callback branches above | Move to normalized purpose-built storage; never carry workspace content through `app_state`. |

Direct normalized repositories such as Stripe, Vizard, response inbox, worker,
and provider-token tables are separate domain boundaries. R4 must not fold their
secret or financial records into `workspace_models.model` merely to obtain one
transaction.

## Current Defects And Risks

The following are **CURRENT SOURCE** risks, not new production observations:

1. `mirrorWorkspaceModel` is last-write-wins. Two instances can both read one
   model and overwrite each other with unconditional merge upserts.
2. A workspace read failure and a confirmed absent row both lead to a blank
   model. The caller cannot distinguish unavailable storage from first use.
3. `saveModelForUser` ignores the mirror result, saves a shared registry, and can
   return a workspace model even when durable workspace mirroring failed.
4. `saveModel` converts a hosted Supabase exception into local filesystem
   persistence. On Vercel that can report success for data present only in one
   instance's `/tmp` directory.
5. GET/bootstrap and load-time normalization can write. A read routed to a stale
   instance can therefore replace newer content.
6. Workspace snapshot reads use a service credential and omit an owner predicate.
   The application predicate, not RLS, is the effective tenant boundary.
7. Workspace, membership, snapshot, normalized account/token, queue, analytics,
   billing, and registry writes are separate. A callback or worker can partially
   complete and then return an ambiguous or misleading result.
8. A timestamp is metadata, not a durable operation identity. The current schema
   cannot deduplicate an old request after another operation has committed.
9. If `app_state.primary` is absent, `supabaseGetModel` writes the complete seed
   through `supabaseSaveModel` before a later user-scoped path may project it to a
   registry. The shared row therefore cannot be assumed content-empty merely
   because `serverRegistryModel` exists.

## Accepted Inert Adapter Evidence

`hosted-workspace-persistence.mjs` and
`hosted-workspace-persistence.contract.test.mjs` are **ACCEPTED INERT EVIDENCE**.
The contract explicitly asserts at test lines 167-170 that `server.mjs` neither
imports nor creates the adapter.

The inert contract demonstrates, against a guarded loopback fake only:

- UUID-bound owner/workspace reads (`hosted-workspace-persistence.mjs:47-60`,
  `197-211`);
- a strict envelope containing exactly `expectedRevision`, `kind`, `operationId`,
  and `request` (`hosted-workspace-persistence.mjs:134-143`);
- insert-only bootstrap followed by an owner-bound read
  (`hosted-workspace-persistence.mjs:214-236`);
- a conditional PATCH on workspace, owner, and prior `updated_at`
  (`hosted-workspace-persistence.mjs:266-326`);
- exact request-byte hashing, stale conflict, lost-response reconciliation,
  operation-ID reuse rejection, private receipt stripping, and adapter restart
  (`hosted-workspace-persistence.mjs:239-387`);
- zero non-loopback requests and cleanup in the contract fixture.

It does not prove server integration, a complete writer inventory, a live
PostgREST atomicity guarantee, production schema/RLS/grants, user-JWT behavior,
multi-instance deployment, durable receipt history, logs, backup/recovery,
deletion, or retained-data conversion. Its single private receipt is embedded in
the latest model, so it cannot replay an older operation after a newer commit.

## Rejected P15 History

The dirty historical worktree rooted at commit `01b06c3` is **REJECTED HISTORY**,
not a Git-reproducible candidate. Its experimental `server.mjs` depended on an
untracked older adapter and made no import or initialization for the
`hostedWorkspacePersistence` symbol it called.

Read-only comparison also shows that experiment:

- left `mirrorWorkspaceModel` as an unconditional upsert;
- routed only the client `/api/model` branch through CAS while the wider writer
  surface still replaced full snapshots;
- returned the mirror status object from `saveModelForUser` as though it were a
  saved model;
- performed normalized and `app_state` writes separately after the CAS;
- retained generic local fallback behavior;
- used an older adapter later corrected for absent-state bootstrap, invalid clock
  handling, and private receipt removal from returned rows.

No P15 code is to be copied, cherry-picked, or treated as reviewed. Future work
starts from the current deployed baseline and the invariants below.

## Threat Model

| Threat | Current exposure | Required control | Required proof |
| --- | --- | --- | --- |
| Tenant confusion | Workspace IDs are selected from mutable user fields and service-role reads bypass RLS. | Resolve actor, active workspace, owner, membership, role, and entitlement from trusted session plus durable rows; repeat checks at commit. | Owner/admin/member/viewer/outsider and cross-workspace matrix with guessed IDs producing indistinguishable denial. |
| Stale overwrite | Whole-model merge upserts have no precondition. | Per-workspace epoch plus monotonic revision; one atomic compare-and-swap boundary. | Two same-base clients have exactly one winner; losing content remains recoverable for review. |
| Concurrent bootstrap | Multiple instances can both construct and upsert a blank workspace. | Explicit insert-only or transactional initialize operation; never initialize after read error. | Barrier-controlled two-instance bootstrap yields one row and one epoch without replacement. |
| Ambiguous or lost response | A commit may succeed after the caller times out. | Durable operation receipt in the same transaction; reconcile by operation ID and request hash. | Failure injected before commit, after commit, and after response loss returns correct not-committed/unknown/replayed result. |
| Retry duplication | Retrying a callback or client request can repeat mutation or external work. | Client preserves operation ID and bytes; server checks durable receipt before revision; provider calls use their own idempotency/ingress ledger. | Identical retry commits once; altered bytes under one ID reject; old receipt remains resolvable after later commits. |
| Ephemeral filesystem success | Hosted Supabase failure falls back to `/tmp`. | Hosted repository has no filesystem implementation or fallback. | Every hosted storage fault returns 503/unknown and no `model.json` is created or changed. |
| Cross-instance drift | Request-local cache and process memory do not coordinate instances. | Database is authoritative; each intent locks/rereads current state inside its transaction. | Independent processes/instances race against a shared database and converge on one revision. |
| Credential leakage | Whole models and error details can carry token material. | Snapshot projection rejects auth, session, OAuth state, provider token, webhook, billing-private, and receipt-private fields. | HTTP, logs, exceptions, audit rows, receipts, database snapshots, stdout, and stderr contain no sentinels. |
| Service-role bypass | Current REST calls use a service credential that bypasses user RLS. | Interactive reads/commits use the verified user JWT where possible; service-only lanes use narrow RPCs and repeat membership/job checks. | Effective grants and RPC execution prove anon denial, authenticated scope, and narrowly bounded service execution. |
| RLS/grant mismatch | Repository SQL is not live evidence. | Compare exact migration fingerprint and catalog state; test JWT gateway roles. | Catalog, `has_table_privilege`, `has_function_privilege`, policies, and real JWT requests match the reviewed matrix. |
| Partial callback writes | OAuth state, credentials, workspace snapshot, and registry save are separate. | Durable ingress/idempotency state machine plus normalized transaction; workspace intent is explicit and independently reportable. | Fault at each boundary cannot expose credentials, resurrect state, or claim an uncommitted workspace result. |
| Worker races | A worker mutates a model read before network work and saves it later. | Lease/claim job first, perform provider work once, then apply a scoped result to fresh state; never replay old content. | Two workers cannot double-dispatch or overwrite a concurrent user edit; unknown provider outcome stays unknown. |
| Retained-data misbinding | Legacy shared content can be attached to whichever user triggers bootstrap. | Conversion requires an explicit immutable source-to-workspace mapping; ambiguous data is quarantined. | Synthetic migration has exact counts/hashes and never auto-assigns by current session, email guess, or latest login. |
| Rollback/schema incompatibility | An old server may resume unconditional writes after schema evolves. | Additive expand/migrate/contract sequence, writer pause, compatibility matrix, and forward-only data boundary. | Old candidate is denied or read-only against new schema; rollback cannot re-enable `app_state` or `/tmp` content writes. |

## Server-Owned Identity And Authorization Invariants

These are **PROPOSED DESIGN** invariants:

1. Hosted persistence is unavailable unless `authenticationExecutionMode()` is
   `supabase`, the session token resolves to one verified Supabase UUID user, and
   the trusted device session is active, unrevoked, unexpired, and bound to that
   same user.
2. The active workspace comes from the trusted device/session record, not request
   JSON, query parameters, browser storage, user metadata, or a provider callback.
3. The server loads exactly one durable `workspace_members` row matching the
   actor and active workspace. Missing, duplicated, malformed, inactive, or
   unavailable membership evidence denies access.
4. The durable `workspaces` row supplies the canonical owner. The actor ID,
   workspace ID, owner ID, role, entitlement, epoch, revision, and receipt fields
   are server-owned and cannot be overwritten by incoming content.
5. The conservative initial role matrix is: owner/admin may initialize, save, and
   recover; owner/admin/member/viewer may read if active and entitled; outsider,
   removed member, expired session, and cross-workspace actor receive no data.
   This is a proposed default and must be explicitly approved before SQL or route
   work. No broader member mutation is inferred from current code.
6. Authorization is checked both before expensive/provider work and again inside
   the durable commit. A revision token never grants authorization.
7. Interactive PostgREST/RPC calls use the verified user's JWT so `auth.uid()` is
   meaningful. Background service calls are separate APIs bound to a durable job,
   actor, workspace, lease, and allowed intent. A generic service-role model write
   is forbidden.
8. Membership lookup failure, schema mismatch, entitlement uncertainty, storage
   error, or ambiguous commit fails closed without a blank model, seed model, or
   local hosted write.

## Canonical Durable Contract

### Stored workspace envelope

The authoritative per-workspace record is **PROPOSED DESIGN**:

```json
{
  "workspace_id": "server-owned UUID",
  "owner_user_id": "server-owned UUID",
  "persistence_epoch": "server-generated UUID",
  "revision": "monotonic decimal integer",
  "model": "validated public workspace-content projection",
  "content_hash": "SHA-256 of canonical model bytes",
  "created_at": "database timestamp",
  "updated_at": "database timestamp"
}
```

`model` may contain only the approved workspace projection. It must not contain
password/auth users, device credentials, OAuth state, access/refresh tokens,
provider-token ciphertext, webhook secrets/events, private billing state,
service credentials, raw callback bodies, worker leases, or private commit
receipts. Those records remain in purpose-built normalized tables.

The epoch changes when a workspace is deliberately recreated. Revision starts at
zero and advances exactly once per semantic model commit. Timestamps remain
observability metadata and are not concurrency tokens.

### Client write envelope

The client sends exactly:

```json
{
  "expectedRevision": {
    "epoch": "UUID returned by the server",
    "revision": "decimal string returned by the server"
  },
  "kind": "model-save or content-recovery",
  "operationId": "client-generated UUIDv4",
  "request": "kind-specific public content"
}
```

Extra top-level keys reject. Missing revision returns 428. Malformed input returns
400 before storage. A stale valid token returns 409 only after authorization.
The server validates a bounded canonical request and merges only approved fields
into freshly read state. Recovery never imports account, provider, billing,
identity, receipt, or operational queue data.

### Durable private receipt

A separate `workspace_model_commits` ledger records, in the same transaction:

```text
workspace_id, persistence_epoch, operation_id, actor_user_id, kind,
expected_revision, result_revision, request_hash, content_hash, committed_at
```

The key is `(workspace_id, persistence_epoch, operation_id)` and each result
revision is unique within the workspace epoch. No request payload, content,
credential, token, email, or provider response is stored in the receipt.

Duplicate-operation lookup occurs before stale-revision rejection:

- same actor, kind, expected revision, and request hash returns the original
  receipt without another mutation;
- a reused ID with different evidence returns 409 `workspace_operation_id_reused`;
- if newer writes exist, the old receipt is returned as `superseded: true` with
  the current authorized revision, never as the current model representation.

### Public result and errors

Successful responses expose only:

```json
{
  "operationId": "UUIDv4",
  "committedRevision": { "epoch": "UUID", "revision": "decimal string" },
  "currentRevision": { "epoch": "UUID", "revision": "decimal string" },
  "replayed": false,
  "superseded": false,
  "commitStatus": "committed",
  "durability": { "driver": "supabase-postgres", "atomicCompareAndSwap": true }
}
```

The stable error set is:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `workspace_input_invalid` | Envelope or approved projection is invalid; no write. |
| 401 | `authentication_required` | No valid hosted session. |
| 403 | `workspace_authorization_failed` | Session, membership, role, entitlement, or tenant binding failed. |
| 409 | `workspace_revision_conflict` | Authorized request used a stale revision; no write. |
| 409 | `workspace_operation_id_reused` | Same operation ID was bound to different evidence. |
| 428 | `workspace_revision_required` | Client mutation omitted its precondition. |
| 503 | `workspace_storage_unavailable` | Read/transaction failed before a known commit. |
| 503 | `workspace_commit_unknown` | Outcome could not be reconciled; caller must retry identical bytes and ID. |

No error contains content, database detail, a service credential, token, receipt
hash input, foreign row existence, or another tenant's current revision.

## Hosted Fail-Closed Runtime

The hosted lane must never instantiate or call `ensureModel`, `localGetModel`, or
`localSaveModel`. Local development keeps its current explicitly local adapter;
the two implementations must not share fallback control flow.

A proposed `HOSTED_WORKSPACE_PERSISTENCE_MODE` has closed values `hold`,
`verify`, and `enforced`, defaulting to `hold`. This name and lifecycle require
review before implementation. In `hold`, external content routes remain denied.
In `verify`, only authorized synthetic staging evidence may run. In `enforced`,
startup validates required configuration and a repository schema fingerprint.

Public `/health` may remain minimal when persistence is unavailable, but
authenticated content routes and worker writers return 503 and release readiness
continues to report HOLD. A missing/partial Supabase configuration, failed schema
probe, unknown migration, repository initialization error, or permission mismatch
must never cause a blank workspace or filesystem initialization.

## Clean Adapter Seam And Call Graph

The adapter boundary is **PROPOSED DESIGN** and starts fresh; it does not assume
the P15 `server.mjs` patch is usable.

```text
HTTP route / callback ingress / claimed worker job
  -> verified session or durable service-job context
  -> resolveWorkspaceActor()
       -> trusted active workspace
       -> exact durable membership and role
       -> entitlement and canonical owner
  -> workspaceRepository.read(actorContext)
  -> build a closed, server-selected WorkspaceWriteIntent
  -> workspaceRepository.commit(actorContext, envelope, intent)
       -> RPC transaction rereads and locks workspace
       -> receipt lookup
       -> authorization recheck
       -> revision comparison
       -> validated field-scoped mutation
       -> model + revision + receipt commit
  -> separate domain repository/outbox work with explicit status
  -> public serializer strips all private state
```

The repository owns persistence only. It must not call providers, send email,
charge customers, parse browser identity, infer roles, or mutate normalized
credential/billing tables. Route/application code owns validated domain intents;
the database transaction owns atomic model/revision/receipt persistence.

Closed intent families are:

- `workspace.initialize`;
- `workspace.client-save`;
- `workspace.content-recovery`;
- `workspace.content-result` for generation/media analysis;
- `workspace.provider-state-result` for bounded public provider state only;
- `workspace.worker-result` bound to a claimed job and expected target;
- `workspace.system-repair` for separately reviewed deterministic repair.

Unknown intent names, ownerless callers, generic `server-write`, and raw whole-
model replacements reject as `workspace_writer_unclassified`. Registry-only,
credential, billing, webhook-ingress, worker-lease, and deletion operations use
their own repositories and are not workspace snapshot intents.

## Phased Implementation Sequence

Each phase is independently reviewable, testable, and reversible. No phase
implicitly authorizes the next.

### Phase R4.1: Hosted writer inventory gate

Create one test-only file, `hosted-workspace-writers.contract.test.mjs`. It reads
current source, enumerates every call to `saveModel`, `saveModelForUser`,
`mirrorWorkspaceModel`, `localSaveModel`, direct `workspace_models`, and direct
`app_state`, and requires an exact reviewed category. It fails on a new or
unclassified caller and emits only an ignored synthetic inventory artifact.

No application, schema, package, lockfile, environment, provider, or deployment
change belongs in R4.1. This is the **exact next code phase** and the next EO
should do only this phase.

### Phase R4.2: Inert repository v2 contract

Implement a fresh or deliberately revised repository behind no `server.mjs`
import. Add durable epoch/revision/receipt semantics, typed error results, strict
projection checks, and independent user-JWT/service-job request functions. Extend
the fake PostgREST suite for two adapter instances and receipt history. Preserve
the existing inert assertion.

Reversal: remove only the inert module/test commit; runtime behavior is unchanged.

### Phase R4.3: Additive SQL and disposable PostgREST proof

Draft one additive migration for revision columns, commit ledger, atomic RPCs,
constraints, indexes, policies, grants, and migration fingerprint. Align the clean
install schema. Apply it only to a disposable local PostgreSQL/PostgREST harness.
Prove transaction rollback and exact privileges before requesting any hosted
database change.

Reversal: drop disposable resources. Production remains untouched.

### Phase R4.4: Fail-closed hosted read and startup lane

Introduce the repository initialization seam in `server.mjs`, defaulted to HOLD.
Remove Vercel filesystem initialization/fallback from hosted control flow. Make
authenticated workspace GET read-only and distinguish absent, forbidden, and
unavailable. Do not enable client writes yet.

Reversal: revert the code commit while HOLD is still active; no retained data has
been converted.

### Phase R4.5: Client save and recovery lane

Expose revision metadata on GET, require the strict envelope on POST, and teach
`social-cues-app.html` to retain one revision per workspace, reuse operation ID
and exact bytes after unknown outcomes, stop on conflicts, preserve unsaved input,
reload, and require explicit review. Normal save and content recovery share the
same repository boundary.

Reversal: return to HOLD/read-only. Never fall back to the legacy write path.

### Phase R4.6: Server writer conversion

Convert one writer family per commit: bootstrap/signup, content/media, provider
state, callbacks/webhooks, then workers. Each call site must replace its old
whole-model save with a closed intent, with hermetic fault and race tests. Remove
direct snapshot upserts only after the inventory proves no bypass remains.

Reversal: pause the affected capability. Do not re-enable unconditional hosted
model writes.

### Phase R4.7: Legacy registry and retained-data rehearsal

Move remaining hosted auth/device/OAuth/billing registry state to normalized
repositories. Inventory `app_state.primary` without exposing values. Rehearse an
explicit synthetic conversion and quarantine ambiguous records. Disable all
external-content reads/writes through `app_state` before any retained conversion.

Reversal: restore from the pre-conversion synthetic backup into an isolated
environment; never auto-attach quarantined content.

### Phase R4.8: Authorized hosted validation

Under a new authorization, apply the reviewed migration to a non-production
Supabase project, run the live matrix below, then repeat against the exact release
candidate in a controlled production window. Keep billing and providers held.

### Phase R4.9: Bounded rollout

Enable one synthetic internal workspace, then named alpha workspaces in cohorts.
Pause on any conflict anomaly, unknown commit that cannot reconcile, tenant
denial mismatch, secret signal, schema drift, or rollback incompatibility. R4 is
not GO until the complete evidence record is reviewed.

## Hermetic Verification Matrix

The pre-live suite must use only loopback fakes or disposable local containers and
must prove cleanup after ordinary and injected-fault runs.

| Area | Required cases |
| --- | --- |
| Identity | Valid owner/admin; read-only member/viewer; outsider; removed/expired/revoked; malformed IDs; browser-selected workspace; foreign known/guessed workspace. |
| Reads | Exactly one owner/workspace row; no owner leakage; absent distinct from error; steady-state read makes zero writes; no registry or filesystem fallback. |
| Envelope | Missing/invalid/foreign epoch; non-decimal revision; malformed/extra keys; oversized/deep/cyclic content; forbidden private fields; canonical byte hashing. |
| Bootstrap | Two independent instances at a barrier; one initialization; one epoch; loser rereads; foreign-owner collision denies; clock/database failure writes nothing. |
| CAS | Same-base client/client, client/server, server/server, and recovery/normal races; exactly one winner; unrelated workspace revisions do not conflict. |
| Retry | Lost response before and after commit; identical byte retry; changed byte/kind/actor/revision under one ID; old receipt after later write; restart replay. |
| Failures | Read timeout, HTTP reset, malformed PostgREST success, zero/multiple returned rows, transaction exception, commit ambiguity, unavailable schema, denied grant. |
| Multi-instance | Two child processes use one fake/disposable database; no in-process mutex is relied upon; next instance reads the acknowledged revision. |
| Callback | State replay, normalized credential failure, workspace-intent failure, and response loss have explicit partial status; zero real provider requests. |
| Worker | Competing claims, lease loss, stale model, provider unknown result, and result commit conflict cannot double-dispatch or overwrite user content. |
| Projection | Auth, device, OAuth, provider tokens, billing-private data, webhook bodies, worker leases, and private receipts are absent from snapshots and responses. |
| Secret safety | Distinct sentinels are absent from HTTP, model rows, receipts, audit, logs, exceptions, stdout, stderr, fixture reports, and cleanup output. |
| Cleanup | Servers stopped; child processes exited; ports closed; rows/containers/networks/volumes/temp files removed; absence checks pass before `cleanupComplete`. |

Required local commands will include, as applicable:

```powershell
node --check server.mjs
node --check hosted-workspace-persistence.mjs
node --check hosted-workspace-persistence.contract.test.mjs
node --test hosted-workspace-persistence.contract.test.mjs
node --test hosted-workspace-writers.contract.test.mjs
npm.cmd run test:auth-verification
npm.cmd run test:workspace-authorization
npm.cmd test
git diff --check
```

Later phases must add dedicated runtime and PostgREST commands rather than hiding
their evidence inside only the monolithic suite.

## Later Live Supabase Matrix

This section is **LATER LIVE VALIDATION**, not permission to run it now.

1. Record exact application commit/tree, migration hash, Supabase project/ref,
   Postgres and PostgREST versions, deployment ID, region, and test window.
2. Inspect migration history and catalog definitions for both workspace tables,
   receipt ledger, RPC signatures, constraints, indexes, triggers, owners, RLS,
   policies, grants, default privileges, and function `search_path`.
3. Prove anon cannot read or execute; authenticated JWTs see only authorized
   workspace rows; owner/admin mutation and member/viewer read-only behavior match
   the approved matrix; service execution is limited to the background RPC.
4. Exercise exact JWT gateway behavior with two users in two workspaces, including
   known and guessed foreign IDs, expired/revoked sessions, and entitlement loss.
5. Run simultaneous commits through two independently deployed application
   instances and prove one revision winner, durable retry receipts, restart and
   region/instance-switch persistence, and no `/tmp` artifact or success path.
6. Inject bounded database timeout/connection loss before commit, after commit,
   and during response delivery. Reconcile every ambiguous outcome without a
   duplicate mutation.
7. Exercise synthetic callback and worker state machines with fake providers only.
   Prove no provider request, charge, email, or external side effect is required
   for persistence acceptance.
8. Review Supabase security and performance advisors. Resolve findings without
   disabling RLS, broadening grants, exposing a service key, or weakening tenant
   predicates. Record accepted residual findings explicitly.
9. Verify sanitized Vercel runtime/error logs correlate request ID, operation ID,
   intent, result code, latency, and revision transition without content, email,
   token, secret, provider payload, or foreign identifiers.
10. Create a synthetic backup, restore only the selected workspace into an
    isolated target, compare content/revision hashes, and record measured recovery
    point and recovery time. Prove another workspace is absent.
11. Execute authenticated export and workspace/account deletion for synthetic
    data. Verify snapshot, commit receipts, normalized rows, audit disposition,
    media, and scheduled backup expiry follow the approved retention policy.
12. Prove every test row, account, session, object, job, receipt, and temporary
    resource is absent. Set `cleanupComplete` only after explicit absence checks.

## Migration Decision

### No-migration path

A no-migration implementation may proceed beyond inert experiments only if the
existing live `workspace_models` table is proven to support all of these without
semantic shortcuts:

- atomic owner/workspace compare-and-swap;
- a monotonic non-timestamp revision with recreated-workspace fencing;
- durable replay history after intervening commits;
- exact interactive JWT and background-service authorization;
- prevention of every direct/unconditional snapshot writer;
- bounded secret-free receipts and indexes;
- reversible retained-data conversion and compatible rollback.

The repository schema at P33 lacks the required epoch, revision, and receipt
ledger, so current evidence does not satisfy this path. Embedding only the latest
receipt in `model` and hashing `updated_at`, as the inert adapter does, is useful
contract evidence but is insufficient for full R4 retry history and schema
fencing.

### Migration-required path

A migration is required if any item above needs a new column, table, constraint,
index, policy, grant, RPC, trigger, or direct-write revocation. On current source
evidence, that is the expected path. The migration must be additive first:

1. add epoch/revision/hash columns and commit ledger;
2. add atomic interactive and background RPCs with exact grants;
3. backfill only explicitly mapped synthetic/retained rows;
4. deploy compatible readers while writes remain held;
5. convert every writer and prove no bypass;
6. enable enforced writes in cohorts;
7. remove legacy content fields/writers only after backup and rollback evidence.

No migration is applied until its disposable Postgres/PostgREST harness, rollback
script, data mapping, and exact live authorization are separately approved.

## Legacy `app_state` Removal

Shared `app_state` is forbidden as storage or fallback for external workspace
content immediately. A temporary server registry may remain only while its
purpose-built replacements are built, and its workspace content collections must
stay empty.

The conversion procedure must:

1. pause hosted writes and workers;
2. inventory keys, record counts, source hashes, and candidate mappings without
   recording values or secrets in evidence;
3. require an explicit immutable source owner/workspace mapping;
4. quarantine rows with absent, conflicting, inferred, or multiple mappings;
5. initialize the destination through the same transactional repository;
6. compare approved projection hashes and normalized record counts;
7. mark conversion in a durable migration ledger;
8. disable legacy reads, observe, then disable writes;
9. remove external content from `app_state` only after backup/restore proof;
10. retain or delete registry-only data according to its approved normalized
    migration and retention policy.

The current login, latest session, email similarity, owner allowlist, or provider
account must never be used to infer ownership of legacy content.

## Observability And Rollout

Emit bounded structured events for repository initialization, authorized read,
bootstrap, commit accepted, conflict, replay, operation-ID misuse, commit unknown,
storage unavailable, writer unclassified, and authorization denial. Include
request correlation, operation ID, intent, status, duration, and old/new revision
numbers only after authorization. Hash or omit workspace/user identifiers in
general logs. Never log model content, request bytes, hashes' source values,
tokens, secrets, provider payloads, or raw database errors.

Required alerts are:

- any tenant-binding or grant denial anomaly;
- any `workspace_commit_unknown` that does not reconcile within the runbook;
- conflict-rate or unavailable-rate threshold breach;
- attempted hosted filesystem write;
- unclassified writer;
- schema fingerprint drift;
- receipt/model hash inconsistency;
- callback or worker partial completion requiring operator action.

Rollout order is synthetic internal workspace, one named alpha workspace, then
small named cohorts. Billing remains `readiness_only`; providers remain disabled
unless separately accepted. Each cohort has a stop condition, evidence owner,
support contact, retention scope, and rollback target.

## Rollback

Before rollout, record a known-good application artifact that is schema-compatible
and cannot write external content through `app_state` or `/tmp`. Rehearse:

1. pause content writes, callbacks, and workers;
2. preserve the database and receipt ledger;
3. route to a compatible read-only or fixed artifact;
4. verify health, authentication, tenant denial, and latest acknowledged revision;
5. reconcile unknown operations by durable receipt;
6. resume only after writer/schema compatibility is re-established.

Do not drop additive columns/tables during an application rollback. Do not deploy
an older unconditional-upsert server against migrated data. If no compatible
artifact exists, stay read-only and forward-fix.

## R4 GO Evidence

R4 can move from HOLD to GO only when one reviewable evidence bundle proves all
of the following against the exact release candidate:

- clean commit/tree, reproducible install, full baseline suite, focused R4 suites,
  syntax checks, and clean tracked worktree;
- one complete writer inventory with no direct/unconditional snapshot bypass;
- server-derived actor/workspace/owner/membership/role/entitlement binding;
- approved role matrix across owner, admin, member, viewer, outsider, expired,
  removed, and cross-workspace cases;
- atomic per-workspace epoch/revision/model/receipt commit under same-base races;
- exact lost/ambiguous response reconciliation and durable replay history;
- independent-instance and restart persistence with zero hosted filesystem
  fallback;
- callback and worker race/partial-result safety without duplicate external work;
- secret-free snapshots, responses, logs, audit records, receipts, test output,
  backups, and cleanup evidence;
- exact production schema/migration fingerprint, RLS, grants, RPC ownership,
  function `search_path`, JWT gateway, and advisor review;
- approved and rehearsed retained-data mapping, backup/restore, retention, export,
  deletion, and backup-expiry behavior;
- correlated alerts, named incident owner, cohort stop conditions, and a
  schema-compatible rehearsed rollback;
- explicit evidence that billing/provider holds remain unchanged and every test
  resource was removed.

## Automatic NO-GO Conditions

R4 remains HOLD if any test count differs, any writer is unclassified, any
storage error becomes blank/default/local success, any tenant predicate or role
is ambiguous, any direct snapshot writer remains, any operation can duplicate,
any old server can write migrated data, any secret appears, any advisor finding
requires weakening isolation, any cleanup absence check fails, or any required
live evidence is unavailable.

Environment readiness, a green public smoke, a loopback contract, successful SQL
application, or one successful hosted save can never lift R4 by itself.
