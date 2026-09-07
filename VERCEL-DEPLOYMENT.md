# Social Cues Vercel Deployment And External Alpha Gate

## Recorded Deployment Artifact

Management records the following successful Vercel production deployment:

- Git commit: `6d000048a77fdc0494b3824168e0bf832d6c30cd`
- GitHub combined status: `success`
- Status context: `Vercel`
- Vercel deployment ID: `6314634319`
- Created: `2026-09-07T18:59:03Z`
- Production deployment URL:
  `https://social-cues-cvr4wgqr6-socialcuesapp.vercel.app`
- Canonical public site: `https://socialcuesapp.com/`

This establishes that the reviewed artifact was built and deployed. It does not
establish hosted authentication, durable workspace persistence, tenant isolation,
data deletion, alerting, worker execution, or rollback readiness. P31 does not
redeploy or mutate that external system.

## Source Deployment Contract

The current repository contract is:

- `package.json` starts the application with `node server.mjs`.
- `vercel.json` declares root `server.mjs` as the sole Vercel function.
- `api/server.mjs` is absent and must not be recreated.
- `vercel.json` schedules `/api/cron/workers` every minute.
- The worker route requires `WORKER_SECRET`, or `CRON_SECRET` as its fallback.
  In Vercel mode, an absent or invalid bearer secret is denied.

The minimal public `GET /health` source contract is HTTP `200` with exactly
these JSON fields:

```json
{
  "ok": true,
  "app": "Social Cues",
  "status": "healthy"
}
```

The route does not return a `mode` field. A successful health response proves
only that the function can answer a minimal request.

## Current External Alpha Boundary

The intended alpha is invite-only and limited to named testers. Until R4 passes,
the public deployment may be used only as a non-data-bearing demonstration. It
must not accept or retain tester workspace content, media, credentials, provider
accounts, or other user data.

The following stay outside the minimum alpha:

- Stripe checkout, Customer Portal, webhook processing, charges, and paid
  entitlement mutation.
- Live provider OAuth, account connection, automated publishing, and provider
  acceptance claims.
- Shared `app_state` as storage for external tester content.
- Any hosted filesystem fallback represented as a durable commit.

## Go/No-Go Summary

| Gate | Current state | Go condition |
| --- | --- | --- |
| Deployment artifact | RECORDED | Exact commit, tree, deployment ID, domain, and build status are retained as evidence. |
| Hosted authentication | HOLD | The complete invite, verification, login, recovery, session, and denial flow passes on the deployed candidate. |
| Workspace persistence | R4 HOLD | Durable per-workspace CAS and tenant isolation pass across multiple application instances. |
| Retention and deletion | HOLD | Approved retention, export, workspace/account deletion, backup expiry, and recovery procedures are tested. |
| Monitoring and worker operations | HOLD | Alerts, correlated logs, secured worker execution, and incident ownership are verified. |
| Rollback | HOLD | A known-good target and a rehearsed, data-compatible rollback procedure are recorded. |
| Billing | REQUIRED HOLD | `readiness_only` and all three unavailable capability flags remain intact. |
| Providers | DEFERRED | Each provider is enabled only after a separately authorized live acceptance review. |

No external tester invite is a GO while any HOLD row remains unresolved.

## Hosted Authentication Gate

Before the first invite, verify the exact deployed release with a dedicated
synthetic alpha account:

1. `GET /api/auth/readiness` reports `ready: true`, hosted authentication rather
   than local-password fallback, required email verification, password recovery,
   login alerting, rate limiting, and the intended invite-only signup policy.
2. `GET /api/auth/smtp/readiness` reports `ready: true`.
3. An authorized invite can create an account and sends a verification email.
4. An unverified account cannot receive an authenticated application session.
5. The verification link enables login to the intended account and workspace.
6. Resend and password-recovery messages complete without account enumeration.
7. Expired, malformed, revoked, and foreign sessions fail closed.
8. Logout and remembered-device behavior match the authentication contract.
9. No token, credential, password, or private account identifier appears in
   responses, logs, URLs, or retained evidence.

Readiness endpoints are necessary signals, not substitutes for the end-to-end
flow.

## Persistence And Tenant-Isolation Gate

R4 remains **HOLD**. Follow the complete matrix in `SUPABASE-SETUP.md`. At
minimum, independent deployed instances must prove:

- authenticated session to active workspace to workspace-owned row binding;
- owner/member/viewer/outsider and cross-workspace authorization;
- atomic compare-and-swap with explicit stale conflict;
- exact retry after a lost or ambiguous response;
- restart and instance-switch durability;
- no successful fallback to ephemeral filesystem storage;
- production schema, RLS, grants, JWT gateway, and advisor review;
- secret-free responses, logs, audit records, and receipts.

Do not revive the rejected P15 integration. Review any future adapter wiring as a
new security and data-integrity change.

## Retention, Deletion, And Recovery Gate

Before retaining tester content, publish and rehearse an operator procedure that
records:

- retention periods for workspace content, media, audit records, provider
  metadata, and backups;
- data export and authenticated workspace/account deletion;
- deletion completion evidence and backup-expiry behavior;
- backup ownership, frequency, recovery point, and recovery time;
- a synthetic restore into the correct workspace without cross-tenant data;
- support ownership and response expectations for access, correction, export,
  deletion, and incident requests.

The Meta deletion callback is not a substitute for general Social Cues account
and workspace deletion.

## Monitoring And Worker Gate

Before inviting testers:

1. Confirm the public `/health` response matches the exact minimal contract.
2. Confirm every response carries an `X-Request-ID` and that the same identifier
   is available in sanitized runtime and exception records.
3. Verify the operator-protected `/api/monitoring/status` route and error
   collection without exposing content or secrets.
4. Configure actionable alerts for server errors, authentication failures,
   persistence conflicts/unavailability, and failed worker runs.
5. Prove an unauthenticated or incorrectly authenticated
   `/api/cron/workers` request returns `401`.
6. Prove one authorized worker invocation records a bounded result and cannot
   cross workspace boundaries.
7. Record who acknowledges alerts, where incident evidence is kept, and when the
   alpha is paused.

A source-level Sentry hook or cron declaration alone is not operational proof.

## Rollback Gate

Before the alpha opens, record a known-good deployment commit, deployment ID, and
alias target. Rehearse the rollback in an authorized non-production or controlled
environment and prove:

- the alias moves to the intended artifact;
- the health and authentication smoke checks recover;
- the rollback does not require weakening authentication or tenant isolation;
- the prior artifact remains compatible with the current schema and retained
  data;
- worker execution and new writes can be paused during the decision;
- one named operator owns the rollback and documents start, result, and recovery.

Do not execute a production rollback based solely on this document.

## Billing And Provider Invariants

`stripe-billing-configuration.mjs` defines
`STRIPE_BILLING_RELEASE_STAGE = "readiness_only"`.
`stripe-billing-application.mjs` reports checkout, portal, and webhook
capabilities as unavailable. Those invariants must pass immediately before an
alpha invite. Do not add billing credentials, activate routes, issue payment
URLs, charge a customer, or grant a paid entitlement.

Keep provider OAuth and publishing disabled for the minimum alpha. Synthetic
readiness tests, guarded provider mocks, and manual receipts do not prove live
provider approval, ownership, scopes, quota, or delivery. Any provider activation
requires its own authorized acceptance plan and rollback.

## Operator Decision Record

A GO decision must preserve one reviewable record containing:

- release commit and tree;
- deployment ID, URL, timestamp, and status;
- result and evidence path for every gate above;
- named alpha testers and data they are allowed to enter;
- billing and provider disablement confirmation;
- known-good rollback target and operator;
- retention, deletion, recovery, support, and incident contacts;
- reviewer, decision timestamp, unresolved risks, and expiration or next review.

Keep `RELEASE-READINESS.md` and `PILOT-HANDOFF.md` as the authoritative
evidence limits. Deployment success must never be used to override their holds.
