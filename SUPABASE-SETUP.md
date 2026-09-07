# Social Cues Supabase Boundary

## Status: R4 HOLD

This document is a safety boundary, not a production activation guide. Do not
apply a migration, populate credentials, enable hosted persistence, or move
external tester content into Supabase based on this file.

The deployed artifact and local contract suites do not establish production
schema state, RLS or grants, JWT gateway behavior, multi-instance concurrency,
durable recovery, retained-data conversion, or deletion behavior.

## Current Implementation

Root `server.mjs` still includes a compatibility path that reads and upserts one
shared `app_state` row with `id=primary`. If a Supabase save throws, the generic
save path can fall back to local filesystem persistence. A serverless filesystem
fallback is not a durable hosted commit and must not be treated as success for
external user content.

The repository also contains `hosted-workspace-persistence.mjs`. Its isolated
contract proves useful compare-and-swap behavior against guarded loopback fakes,
but `server.mjs` does not import or initialize that adapter. The rejected P15
integration must not be revived implicitly.

A configured response from `GET /api/supabase/status` proves only that the
current process recognizes configuration. It does not lift R4 or prove that an
authenticated workspace write is durable and isolated.

## R4 Go/No-Go Gates

Hosted persistence remains **NO-GO** until one reviewed evidence set proves all of
the following against the exact release candidate:

### Authenticated workspace binding

- A verified hosted session resolves one active workspace and only that
  workspace's durable model.
- Owner, admin, member, viewer, outsider, expired-session, and cross-workspace
  behavior matches the authorization contract.
- Browser input cannot choose or overwrite server-owned user, membership,
  workspace, revision, receipt, or credential fields.

### Tenant isolation

- Two independently authenticated users in different workspaces cannot read,
  write, infer, or delete each other's rows.
- Actual database RLS, grants, function execution privileges, and service-role
  boundaries are inspected and tested.
- Provider tokens, service credentials, internal revisions, and private receipts
  never appear in client responses, audit output, logs, or test artifacts.

### Multi-instance concurrency

- Independent application instances exercise create, read, update, conflict,
  disconnect, and retry paths against the same database.
- Stale writers fail closed without overwriting newer state.
- Exact retry after an ambiguous or lost response returns the prior bounded
  receipt rather than applying a second mutation.
- Same-millisecond writes, concurrent bootstrap, rollback, and malformed
  envelopes preserve the accepted compare-and-swap contract.

### Durable failure behavior

- A database timeout, unavailable database, rejected write, or ambiguous outcome
  returns an explicit non-commit result.
- Hosted requests never report success because data was written only to an
  ephemeral local filesystem.
- Restarting or routing the next request to another instance retains the last
  acknowledged workspace revision and content.

### Recovery and retained data

- Backup and restore procedures recover a selected workspace to a documented
  revision without crossing tenant boundaries.
- Any migration from shared `app_state` is reviewed, reversible, and proven not
  to attach legacy data to the wrong user or workspace.
- Recovery-point and recovery-time expectations are documented for the alpha.

### Retention and deletion

- The operator has an approved retention period for workspace content, audit
  records, provider metadata, and backups.
- Account and workspace deletion remove or schedule removal of all covered data,
  with a recorded request, completion result, and backup-expiry policy.
- Export, deletion, and recovery procedures are tested with synthetic data before
  the first external invite.

### Production evidence

- The exact production schema and migration history match the reviewed candidate.
- Supabase security and performance advisors are reviewed without weakening RLS
  or tenant predicates.
- Logs and request correlation distinguish accepted commits, conflicts, retries,
  and failures without exposing content or secrets.
- Every temporary test row and resource is proven absent after ordinary and
  fault-injected runs.

## Authentication Gate

Supabase-backed onboarding is a separate launch gate. Before inviting a tester,
the deployed release must prove invite-only signup, email verification, login,
session restoration, resend, password recovery, logout, and expired-session
behavior. `GET /api/auth/readiness` and `GET /api/auth/smtp/readiness` must both
report ready, but readiness responses alone do not replace end-to-end delivery
and denial tests.

## Allowed Local Use

Local development may continue with synthetic data in `data/model.json` and the
existing guarded contract suites. That local evidence must remain labeled local;
it is not proof of hosted Supabase behavior.

Do not inspect or copy real credentials into documentation. Do not apply SQL,
enable `SUPABASE_ENABLED`, or change external data during this documentation
task. The authoritative release limits remain in `RELEASE-READINESS.md` and
`PILOT-HANDOFF.md`.
