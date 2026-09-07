# Social Cues Release Readiness

Assessment: P28 authenticated Discord community read boundary,
based directly on accepted P27
`0a388b7639df65d3458c3bdb819477acf128ce4a`. The P15 hosted
compare-and-swap adapter remains deliberately inert: `server.mjs` does not import
or initialize it. P14 remains the current runnable local operator pilot.

**Ready for the bounded synthetic local operator pilot. Production, hosted CSV
import/export, real provider publishing and paid access are not established ready.
R4 remains HOLD.**

## Demonstrated Locally

| Area | Current evidence |
| --- | --- |
| Reviewed CSV input | Header-only template; strict bounded parser supports BOM, CRLF/LF, quoted commas/newlines and escaped quotes. Malformed structure fails closed. |
| Reviewed CSV export | Fresh authenticated saved-model review lists every eligible current-workspace manual receipt/result and starts with no selection. Download includes only the explicit subset. |
| Export format safety | Exact `social-cues-manual-receipts-export.v1` marker, existing ten-column order, quoted values and marker-bound reversible formula protection preserve exact re-import. Malformed marker/escape forms fail closed; unmarked external behavior is unchanged. |
| Export minimization | Provider-derived, legacy, unassociated, invalid and non-roundtripping records are excluded with reason counts. Account/provider/billing/private model/approval/queue/media/identity/frozen-snapshot fields are absent. |
| Association and validation | Every row names an existing current-workspace campaign and variant. Platform is derived. Existing HTTPS, past time/offset and optional complete-observation validation is reused; blank and measured zero remain distinct. |
| Review and selection | Every parsed row, exact cells, association, validation errors and duplicate state appears before saving. Selection starts empty; invalid, unmapped and duplicate rows are disabled. Cell text remains inert. |
| Append-only import | Only explicitly selected records append. Existing proof order/content, campaigns, approvals, queue state and frozen evidence snapshots are retained. Imported records remain manual/operator-supplied and unverified. |
| Duplicate handling | Exact existing and in-file validated facts are visible and excluded. Reimport after reload/restart does not multiply unchanged receipts. This is documented exact comparison, not fuzzy semantic matching. |
| Save coordination | Review captures current local conditional revision. A further edit conflicts and requires fresh review. A different unknown operation remains authoritative. An uncertain import retries the identical operation/request and stable record IDs. |
| Export freshness | Export waits for earlier saves and confirms current saved content. Status identifies the reviewed revision/time and explicitly calls download a snapshot. Refresh reveals later client changes; context change or a different unresolved save disables export. |
| Workspace safety | Context change hides the old review and disables import. Another authenticated synthetic workspace cannot map the source IDs. Missing conditional capability disables confirmation. |
| Existing workflows | Imported records are editable with the ordinary Results form and explicitly selectable for the existing evidence preview without changing provenance or automatically creating a campaign. |
| Responsive operation | Real WebKit mobile review has scrollable rows, reachable actions, keyboard selection and Escape cancellation. |
| Operator continuity | Fresh P14 pilot resumes, serves local health/portal/app, restarts and stops with byte-identical saved model. Historical pilots remain unmodified. |
| Hosted CAS contract | A standalone adapter and loopback-only fake PostgREST suite prove owner/workspace-bound reads, opaque `updated_at` revisions, atomic filtered writes, stale-write rejection, explicit insert-only bootstrap, exact lost-response replay, bounded private receipts and fail-closed ambiguous outcomes. This row is contract evidence only, not active application behavior. |
| Twitch callback persistence | The authenticated local callback now commits consumed OAuth/session state and its owner-scoped connected account in one revisioned write. A hermetic fixture proves tampered-state denial, the exact synthetic token/user/validation sequence, primary/foreign isolation, restart persistence, private-field omission and cleanup with zero non-loopback requests. |
| Shopify credential matrix | All 38 canonical, alias, invalid, precedence, hostile-environment and workspace-token cases run through 58 isolated executions. Configured starts use an authenticated synthetic workspace and verify both OAuth entry points, client ID, callback, HMAC behavior and secret absence. Invalid inputs fail closed without a redirect. The separate encrypted workspace-token case is seeded through the canonical local adapter, survives restart, and does not satisfy application readiness. |
| Core model authentication | Anonymous `/api/model` access fails closed with a sanitized `401` and no workspace or private model fields. A normal synthetic owner session receives a `200` public model limited to the matching workspace, with the expected collection shape, no private ledgers or connected-account credentials and zero external requests. |
| Revisioned provider-state fixture | A bare authenticated model POST is retained as a `428 workspace_revision_required` control with byte-identical storage. A correctly revisioned malicious snapshot receives a normal receipt but cannot place top-level or nested credentials in storage. Synthetic provider credentials are encrypted and seeded only through the stopped-server local adapter with canonical owner/workspace identity; restart, public secret omission, foreign-workspace isolation and two-path-to-one-asset Twitch selection are proven with zero external requests. |
| YouTube/Google callback persistence | Local callbacks consume one-time state, renew the initiating session, retain sanitized OAuth audit evidence and commit failure or encrypted owner-scoped YouTube/Google Business records in one revisioned workspace write. A hermetic fixture proves tamper/replay denial, failed and successful exchanges, both Google branches, restart survival, foreign-workspace isolation, raw-secret absence and cleanup with zero non-loopback dispatches. |
| YouTube/Google OAuth start | State-issuing YouTube and Google Business starts require a valid session whenever revisioned local persistence is active. Anonymous and invalid-session requests return the existing sanitized `401` page before state creation. Authenticated owner starts retain exact Google redirects, YouTube/Business scope separation, offline consent parameters, signed distinct state, owner/workspace-bound durable records and isolated revisions with zero provider traffic. |
| X account inspection | `/api/x/account` now requires an entitled session before account loading, token validation, refresh, repair or persistence whenever revisioned local persistence is active. Anonymous and invalid-session reads return the established sanitized `402` app-access contract. An authenticated owner retains encrypted account validation, exact readiness and scope truth, while a foreign workspace sees no owner account and all guarded paths dispatch zero provider requests. |
| Discord community read boundary | The shared Discord account-read helper now requires an entitled session before workspace scoping, credential validation, refresh, repair or provider inspection whenever revisioned local persistence is active. Anonymous and invalid-session reads return the established sanitized `402` app-access contract with unchanged bytes/revisions and zero traffic. A foreign no-account workspace receives only scoped connect guidance. An authenticated owner retains the existing public community response through exactly two guarded Discord GET mocks, one owner revision and encrypted owner-scoped evidence. |
| Revisioned billing checkout controls | The test derives owner, same-workspace non-owner and foreign controls from `shared.workspaces`, `shared.authUsers`, exact active devices and persisted workspace entries instead of the absent legacy root `workspace`. The synthetic Member device is bound through the stopped-server local persistence adapter. Anonymous and non-owner denial, owner-held behavior, forged admin, hostile body and foreign-body cases leave exact storage bytes and both provider logs unchanged. This proves a local held boundary only; checkout remains unavailable. |
| Facebook Meta OAuth start | State-issuing Facebook starts require an authenticated local owner before mutation. Anonymous and invalid-session requests return the existing explicit `401` sign-in page instead of exposing a persistence classifier. Normal and testing starts retain separate scopes, owner/workspace-bound durable state and zero provider traffic. |
| Facebook Meta asset refresh | Local `/api/meta/assets` requires an authenticated workspace before token repair, inspection or persistence. Owner refresh uses guarded Meta responses, persists only owner-bound token-backed assets, and returns owner-scoped connection/capability truth. A foreign workspace receives no owner assets, connection summary or provider call, while static Meta capability catalogs remain anonymous. |
| Facebook Meta callback persistence | Missing, malformed, tampered, signed-but-unissued, wrong-provider, ownerless, foreign-owner and replayed local callback states retain P23's sanitized write-free `400`. Valid failed and successful callbacks now commit consumed state, renewed session data, sanitized OAuth audit evidence and owner-scoped Meta/Facebook/Instagram accounts through one revision-checked owner view. The guarded fixture proves encrypted storage, deduplication, selection, restart survival and foreign-workspace isolation with zero non-loopback requests. |

P28 verification:

- Before the repair, an anonymous revisioned-local `GET /api/discord/community`
  returned sanitized `500` only after entering Discord account validation and
  attempting one guarded external `GET` to `https://discord.com`. Durable model
  bytes and owner/foreign revisions remained unchanged. This was an application
  authentication-boundary defect, not a stale assertion.
- The shared `requireDiscordAccountForRead` helper now applies the existing
  entitled-session gate when either hosted mode or revisioned local persistence is
  active. The check occurs before workspace model scoping, account selection,
  credential validation, refresh, repair, save or provider traffic. Its ten
  existing account-backed routes inherit the guard; static Discord readiness,
  interaction, webhook and command-registration behavior is unchanged.
- `SOCIAL_CUES_DISCORD_COMMUNITY_FIXTURE_ONLY=true node test.mjs` proves anonymous
  and invalid-session requests return exact sanitized `402` app-access responses
  with byte-identical storage, unchanged owner/foreign revisions and zero provider
  traffic. A foreign no-account workspace receives owner-free `409` connect
  guidance without mutation or traffic. The authenticated owner receives the
  established public community shape through exactly two guarded GET mocks,
  advances only its own revision exactly once and retains encrypted owner-scoped
  account evidence. Secrets are absent from HTTP, persistence plaintext, logs and
  process output; both children stop, release the lock and clean up explicitly.
- P20 through P28 focused fixtures are green. Dedicated checks report **382**
  authentication checks, **165** workspace-authorization checks including the
  original **24**, **111** local-ownership checks, **9** local-persistence tests,
  **5** writer-inventory tests, **18** hosted-adapter tests, **13**
  workspace-content contract tests, **20** persistence runtime tests and **27**
  revisioned-model checks with zero external dispatches.
- The uncapped `npm test` suite now exits successfully after clearing P28. It
  reports the unchanged **18** fail-closed payment-safety assertions and finishes
  with `{ "ok": true, "generated": 18, "queued": "queued-review-only" }`.
- No live Discord, Stripe, Supabase or other provider request was dispatched. No
  dependency, lockfile, migration, SQL, hosted adapter, deployment, billing
  setting or retained-data conversion changed, and R4 remains HOLD.

P27 verification:

- The inherited fixture assumed `model.json` still exposed a root `workspace`.
  Revisioned local storage correctly exposes `shared.workspaces` plus keyed
  `workspaces` entries and has no root workspace. Its four existing authenticated
  candidates also each owned their own active workspace, so the old selector
  could not construct the required same-workspace non-owner control.
- The repair is confined to `test.mjs`. It derives canonical candidates only when
  the persisted workspace owner, auth user, active device and workspace entry all
  agree. It selects a non-management synthetic user, stops the server, confirms
  lock release and binds that exact device to the owner's workspace through
  `openLocalWorkspacePersistence`. Workspace ownership rows remain byte-for-byte
  unchanged and a distinct canonical owner supplies the foreign-workspace control.
- `SOCIAL_CUES_BILLING_CHECKOUT_FIXTURE_ONLY=true node test.mjs` proves anonymous
  checkout is sanitized `401`; the authenticated same-workspace non-owner and
  forged admin claim are `403`; the canonical owner, hostile body and foreign-body
  attempts remain `503 activation_held`. Every request leaves the complete
  post-setup model bytes unchanged and adds zero external or mocked-provider
  requests. Lock release and task-directory cleanup are explicit.
- The held application remains `readiness_only`. Its **92** checks record zero
  gateway calls, lifecycle calls, repository mutations, Stripe/provider/production
  requests, entitlement mutations, payment URLs or exposed secrets. No billing
  implementation, route, configuration or database behavior changed.
- P20 through P27 focused fixtures are green. Dedicated checks report **382**
  authentication checks, **165** workspace-authorization checks including the
  original **24**, **111** local-ownership checks, **9** local-persistence tests,
  **5** writer-inventory tests, **18** hosted-adapter tests, **13**
  workspace-content contract tests, **20** persistence runtime tests and **27**
  revisioned-model checks with zero external dispatches.
- The uncapped suite clears P27 and next stops at current `test.mjs:8967` on the
  inherited assertion `discord community should require connected Discord OAuth`.
  It expected anonymous `/api/discord/community` to return `409`. P28 must diagnose
  the current authentication/readiness contract independently; P27 does not alter
  Discord code or its fixture.
- No live Stripe, Discord, Supabase or other provider request was dispatched. No
  application, dependency, lockfile, migration, SQL, hosted adapter, deployment,
  billing setting or retained-data conversion changed, and R4 remains HOLD.

P26 verification:

- The inherited anonymous `/api/x/account` read entered X token validation with a
  shared model before authentication. Local validation can save account evidence,
  refresh or repair credentials, and the revisioned writer therefore rejected the
  ownerless save as `403 workspace_writer_unclassified` with `commitStatus`.
- The route now requires the existing entitled session whenever hosted or
  revisioned local persistence is active. The check occurs before account loading,
  validation, refresh, repair or save. `/api/x/engagement/readiness` and every
  neighboring route remain unchanged.
- `SOCIAL_CUES_X_ACCOUNT_FIXTURE_ONLY=true node test.mjs` proves anonymous and
  invalid-session reads return the exact sanitized `402` app-access response with
  byte-identical storage, unchanged owner and foreign revisions, no response
  cookie, no internal classifier and zero provider requests.
- The same guarded fixture seeds an encrypted synthetic X account only through the
  stopped-server local adapter. The authenticated owner receives the existing
  public account, readiness, posting and scope contract; local token validation
  advances exactly one owner revision. A foreign workspace receives no account or
  owner evidence and changes neither workspace. Plaintext credentials, session
  values and test secrets are absent from HTTP, persistence, request logs, stdout
  and stderr. Both children stop, release the workspace lock and pass explicit
  directory cleanup.
- P20 through P25 focused fixtures remain green. Dedicated checks report **382**
  authentication checks, **165** workspace-authorization checks including the
  original **24**, **111** local-ownership checks, **23** local
  persistence/writer/content tests, **13** workspace-content contract tests,
  **20** persistence runtime tests and **27** revisioned-model runtime checks.
- The final monolithic result clears P26 and next stops at current
  `test.mjs:8510`, where the inherited billing checkout fixture cannot resolve its
  canonical owner, non-owner and foreign-workspace controls. That later fixture or
  boundary diagnosis is P27 and is not changed here.
- No live X, Stripe, Supabase or other provider request was dispatched. No
  dependency, lockfile, migration, hosted adapter, deployment, billing setting or
  retained-data conversion changed, and R4 remains HOLD.

P25 verification:

- The inherited anonymous YouTube start reached `createOAuthState` and attempted
  an ownerless revisioned save. The writer correctly refused the mutation, but
  the route exposed `403 workspace_writer_unclassified` and `commitStatus` instead
  of an authentication response. A pre-edit loopback probe confirmed byte-identical
  storage and zero provider requests.
- `/api/oauth/youtube/start` now applies its existing sign-in-required `401` page
  when revisioned local persistence is active and no valid session exists. The
  check occurs before OAuth state creation and covers both ordinary YouTube and
  `service=business` starts. Hosted behavior and callback handling are unchanged.
- `SOCIAL_CUES_GOOGLE_START_FIXTURE_ONLY=true node test.mjs` proves anonymous and
  invalid-session `401` responses, byte-identical storage, unchanged owner and
  foreign revisions, no redirect or cookie, and no internal classifier exposure.
  It also proves authenticated `302` redirects to Google's exact authorization
  endpoint with the canonical callback, offline access, consent/account selection,
  four YouTube scopes and the separate `business.manage` scope.
- The two OAuth states are distinct and signed, and both private ledger records
  carry the exact initiating owner, user, workspace, platform and requested scopes.
  Owner revisions advance independently while the foreign workspace remains
  unchanged. Public models and OAuth audit output omit private ledgers and raw
  state; secrets and session values remain absent from HTTP, persistence and
  process output. The child stops, releases its lock and passes explicit cleanup.
- P20 through P24 focused fixtures remain green. Dedicated checks report **382**
  authentication checks, **165** workspace-authorization checks (including the
  original **24**), **111** local-ownership checks, **27** combined local
  persistence/writer/content-contract tests, **20** persistence runtime tests and
  **27** revisioned-model runtime checks.
- The closing monolithic result and any later unrelated inherited assertion are
  recorded in the P25 delivery evidence. P25 does not broaden into a later
  boundary.
- No live Google, Meta, Supabase or other provider request was dispatched. No
  dependency, lockfile, migration, hosted adapter, deployment, retained-data
  conversion or billing setting changed, and R4 remains HOLD.

P24 verification:

- The inherited valid callback loaded the owner view from the post-ingress local
  baseline, then saved `sharedModel` again after session renewal. That second
  shared save advanced the baseline independently, so the owner-view save failed
  closed with `409 workspace_shared_state_conflict` after provider exchange.
- Meta now follows the accepted P20 Google atomic pattern: after renewal, the
  local owner view receives the final sanitized OAuth event ledger and performs
  the sole callback-result save. The stale separate shared save remains unchanged
  for hosted/nonlocal operation and is skipped only for the revisioned local
  owner-view path.
- `SOCIAL_CUES_META_CALLBACK_ATOMIC_FIXTURE_ONLY=true node test.mjs` proves a
  failed exchange and a successful exchange both return the existing explanatory
  `200`, preserve the initiating HttpOnly session, consume state, reject replay
  before provider traffic and leave the foreign workspace unchanged. The success
  path stores exactly three owner/workspace-bound Meta, Facebook and Instagram
  accounts with AES-256-GCM credential envelopes, then preserves them across an
  authenticated asset refresh and process restart.
- The fixture verifies the exact synthetic failure, short-token, long-token,
  identity, token-debug, permissions, Page/Instagram discovery and business
  requests. All **12** provider-shaped interactions are handled by the loopback
  guard; no non-loopback request is dispatched. Public response bodies, durable
  audit, provider evidence and process output omit the synthetic application and
  provider secrets, codes, states and plaintext provider tokens; durable storage
  and process output also omit raw session values. Both child processes stop, the
  workspace lock is absent and cleanup is explicitly confirmed.
- P20 Google callback, P21 Meta start, P22 Meta assets and P23 Meta rejection
  focused fixtures remain green. Dedicated checks report **382** authentication
  checks, **165** workspace-authorization checks (including the original **24**),
  **111** local-ownership checks, **27** combined local
  persistence/writer/content-contract tests, **20** persistence runtime tests and
  **27** revisioned-model runtime checks.
- The single final `npm test` is expected to clear P24 and next stop at current
  `test.mjs:7497`, where the inherited anonymous YouTube OAuth start still expects
  a `302` redirect. That route boundary is the next independent task; it is not a
  Meta callback regression.
- No live Meta, Supabase or other provider request was dispatched. No dependency,
  lockfile, migration, hosted adapter, deployment, retained-data conversion or
  billing setting changed, and R4 remains HOLD.

P23 verification:

- The inherited unissued Meta callback reached generic callback ingress, recorded a
  transient ownerless audit event and attempted `saveModel` before the route could
  return its existing state-rejection page. Revisioned local persistence correctly
  refused that writer as `workspace_writer_unclassified`, but the internal `403`
  escaped instead of the intended sanitized `400`.
- Local callback ingress now attempts a durable audit write only for an exact live
  ledger state whose owner and workspace match the authenticated session. Invalid
  or foreign callback input retains only transient sanitized evidence. Nonlocal
  callback ingress continues to save its rejection audit as before.
- Local Meta state consumption disables signed-state recovery and requires the
  initiating session owner. Rejection returns the established `400` without a
  second local save. State signatures, one-time ledger matching, hosted behavior,
  revision checks and the local writer classifier remain fail closed.
- `SOCIAL_CUES_META_CALLBACK_FIXTURE_ONLY=true node test.mjs` proves eight exact
  rejection/replay responses, no rejection cookie, byte-identical storage and
  unchanged workspace revisions/receipts for every rejection. It also proves
  private state/code/secret omission, one child shutdown, lock release and explicit
  cleanup. Rejections make zero provider calls and the entire fixture makes zero
  non-loopback requests.
- At the P23 checkpoint, the owner-bound control reached exactly one guarded Meta
  token-exchange mock, consumed its state, preserved the foreign workspace and
  renewed the owner session before returning `409
  workspace_shared_state_conflict`. P24 repairs that separate valid-path defect;
  P23's rejection boundary remains unchanged and green.
- P20 Google callback, P21 Meta start and P22 Meta assets focused fixtures remain
  green. Dedicated checks report **382** authentication checks, **165** workspace-
  authorization checks (including the original **24**), **111** local-ownership
  checks, **27** combined local persistence/writer/content-contract tests, **20**
  persistence runtime tests and **27** revisioned-model runtime checks.
- The single final `npm test` clears the repaired Meta callback assertion and next
  stops at current `test.mjs:6863`, where the inherited anonymous YouTube OAuth
  start still expects a `302` redirect. The accepted P20 authenticated Google
  callback fixture remains green; diagnose the anonymous start authentication and
  ownerless-write boundary independently after P24.
- No live Meta, Supabase or other provider request was dispatched. No dependency,
  lockfile, migration, hosted adapter, deployment or billing setting changed, and
  R4 remains HOLD.

P22 verification:

- The inherited failure exposed two application-boundary defects. Anonymous and
  invalid-session reads reached token repair/inspection and then leaked `403
  workspace_writer_unclassified` from an ownerless local save. An authenticated
  foreign workspace could also receive shared `metaConnection` and capability
  truth derived from another workspace even though account rows themselves were
  filtered.
- Local revisioned persistence now returns the exact sanitized `401` sign-in JSON
  before any Meta mutation, inspection, provider request or save. Hosted behavior
  keeps its existing app-access gate. `/api/meta/use-cases` and
  `/api/meta/capabilities` remain anonymous, read-only catalogs.
- Authenticated local refresh temporarily isolates shared Meta summary fields,
  performs repair and discovery against the initiating owner's accounts, computes
  capability and diagnostic output from that owner-scoped model, restores the
  exact prior shared summary state, and then persists only legitimate owner-bound
  account changes. This retains durable token-backed repair without turning
  workspace health into shared cross-tenant truth.
- `SOCIAL_CUES_META_ASSETS_FIXTURE_ONLY=true node test.mjs` proves exact anonymous
  and invalid-session `401` responses, byte-identical denial state, unchanged
  neighboring static routes, one owner revision increment, unchanged client
  receipts, three owner-bound Meta/Facebook/Instagram assets, **37** capability
  rows, a zero-account foreign response, unchanged foreign revision/model bytes,
  private-marker absence, two child shutdowns, lock release and explicit cleanup.
  Exactly four guarded Meta-shaped calls run (`debug_token`, permissions, accounts
  and businesses); no non-loopback request is dispatched.
- The accepted P21 focused fixture remains green. Dedicated checks report **382**
  authentication checks, **165** workspace-authorization checks (including the
  original **24**), **111** local-ownership checks, **27** combined local
  persistence/writer/content-contract tests, **20** persistence crash/recovery
  runtime tests and **27** revisioned-model runtime checks.
- The standalone `test:meta-health-authentication` harness remains independently
  stale: before reaching a route it writes the pre-revision raw seed format into a
  fresh directory, which the accepted store rejects as
  `workspace_storage_unavailable`. P22 does not change that harness or weaken the
  store.
- The single final `npm test` clears P22 and next stops at inherited current
  `test.mjs:6457`, `meta callback should reject unissued OAuth state`. A separate
  fresh loopback probe confirms the unissued callback receives `403
  workspace_writer_unclassified`, `commitStatus: not_committed`, before any Meta
  exchange. That callback persistence boundary is P23, not part of P22.
- No live Meta, Supabase or other provider request was dispatched. No dependency,
  lockfile, migration, hosted adapter, deployment or billing setting changed, and
  R4 remains HOLD.

P21 verification:

- The inherited assertion was partly stale and exposed a real route boundary defect.
  Its anonymous Facebook start expected `200` or `302`; the route instead created
  state without an owner and leaked `403 workspace_writer_unclassified` from the
  local persistence layer. Nothing committed and no provider request occurred.
- A pre-edit loopback diagnosis proved authenticated normal and testing starts were
  otherwise correct: both returned `302`, advanced revisions, persisted state with
  exact owner/workspace identity and retained the intended scope split. Normal uses
  `public_profile`, `pages_show_list` and `pages_read_engagement`; testing adds
  `pages_manage_posts`, `pages_manage_metadata` and `business_management` and sets
  the profile selector.
- `/api/oauth/meta/start?platform=facebook` now applies its existing sign-in-required
  response when local revisioned persistence is active, before state creation. The
  hosted check, persistence classifier, OAuth state/session binding and Instagram
  Login routes are unchanged.
- `SOCIAL_CUES_META_START_FIXTURE_ONLY=true node test.mjs` proves anonymous and
  invalid-session `401` denial, no unauthenticated mutation, both authenticated
  redirects, exact scopes and selector behavior, durable owner binding, private
  marker absence, child shutdown, lock release and cleanup with zero external
  requests.
- Verification reports **382** authentication checks, **165** workspace-
  authorization checks (including the original **24**), **111** local-ownership
  checks, all **9** local-persistence tests and the **27**-check revisioned-model
  runtime with zero external dispatches.
- The single final `npm test` clears P21 and next stops at inherited
  `test.mjs:5798`: anonymous `/api/meta/assets` performs an owner-scoped local write
  and returns `403 workspace_writer_unclassified`, `commitStatus: not_committed`.
  That separate read/refresh contract is not changed in P21.
- No live Meta, Supabase or other provider request was dispatched. No dependency,
  lockfile, migration, hosted adapter, deployment or billing setting changed, and
  R4 remains HOLD.

P20 verification:

- The inherited callback failure was the same stale-baseline pattern repaired for
  Twitch in P16. The callback saved consumed shared OAuth/session state, then tried
  to save an owner workspace view created from the earlier revision; the second
  write failed closed with `409 workspace_shared_state_conflict` and no account was
  committed.
- A sanitized pre-edit reproduction returned OAuth start `302`, callback `409`,
  `commitStatus: not_committed`, and one Google token-endpoint attempt blocked by
  the test guard before dispatch. It also showed that local signed-state recovery
  could accept the consumed state again after the conflicted request.
- Local YouTube callbacks now require their durable one-time state, retain signed
  fallback for nonlocal/serverless operation, copy the final sanitized OAuth event
  ledger into the owner view, and skip the stale shared save. Hosted/nonlocal save
  behavior, provider encryption, public scrubbing and the P16 Twitch path are
  unchanged.
- `SOCIAL_CUES_GOOGLE_CALLBACK_FIXTURE_ONLY=true node test.mjs` passes a synthetic
  failed exchange, tamper and replay controls, YouTube success, Google Business
  authorization/location success, cookie preservation, exact owner/workspace
  scope, encrypted private storage, restart and cleanup. Six provider-shaped
  interactions are served by the in-process mock; no non-loopback request is
  dispatched.
- The accepted Twitch focused fixture still passes with four synthetic provider
  interactions, restart persistence, foreign-workspace isolation and zero
  non-loopback dispatches.
- Verification reports **382** authentication checks, **165** workspace-
  authorization checks (including the original **24**), **111** local-ownership
  checks, all **9** local-persistence tests and the **27**-check revisioned-model
  runtime with zero external dispatches.
- The one final `npm test` clears P20 and next stops at inherited
  `test.mjs:5289`, `facebook meta start failed`. A separate loopback-only
  reproduction confirms anonymous `/api/oauth/meta/start?platform=facebook`
  receives `403 workspace_writer_unclassified`, `commitStatus: not_committed`,
  with zero provider requests. That fixture is the next independent task and is
  not repaired here.
- No live Google, Meta, Supabase or other provider request was dispatched. No
  dependency, lockfile, migration, hosted adapter, deployment or billing setting
  changed, and R4 remains HOLD.

P19 verification:

- The inherited raw `/api/model` POST correctly failed closed; weakening the
  revision requirement was not an acceptable repair.
- A disposable behavioral reproduction proved a real authority defect in the
  accepted client merge: a correctly revisioned browser snapshot could write both
  `credential` and nested `profile.accessToken` values to private `model.json`,
  even though the public response scrubbed them. The repaired regression also
  covers the `encryptedCredential` spelling.
- `mergePublicModelUpdate` now recursively removes credential-shaped browser input
  before the existing merge helper restores private account fields from an
  existing server-held account. Trusted server-side merges remain unchanged. The
  same reproduction commits successfully without either marker reaching disk or
  public output.
- The provider fixture stops its task-owned server, confirms lock release, writes
  14 encrypted private account rows through `openLocalWorkspacePersistence`, then
  restarts. Thirteen nonexpired rows are publicly visible, all remain scoped to the
  signed-in workspace, the foreign member workspace remains blank and two Twitch
  credential paths collapse to one posting asset.
- Scheduled and historical campaign writes plus the server-cache forgery control
  now use strict revision envelopes and verify operation receipts. The temporary X
  refresh state is also written through the stopped-server adapter instead of
  browser credential authority.
- The focused command is
  `SOCIAL_CUES_PROVIDER_STATE_FIXTURE_ONLY=true node test.mjs` (set the variable
  with native shell syntax on Windows). It reports the expected 428/no-commit
  control, sanitized revisioned save, encrypted restart state, workspace isolation,
  duplicate selection, zero external requests and verified cleanup.
- The full suite advances through the repaired provider-state, readiness, truth,
  dry-run, acceptance and ownership assertions. It next stops at the inherited
  YouTube OAuth callback near current `test.mjs:4422` with `409`
  `workspace_shared_state_conflict`. A separate no-restart loopback reproduction
  returns OAuth start `302` and the same callback `409`, proving this is not caused
  by P19 fixture restart or provider seeding. No Google request was dispatched.

P18 verification:

- The inherited assertion was stale: it loaded `/api/model` before creating a
  session, while accepted revisioned local persistence intentionally requires an
  authenticated workspace for model reads.
- A sanitized loopback diagnosis and the focused fixture both prove anonymous
  `401` denial, authenticated `200` success, matching workspace IDs, no foreign
  workspace visibility, the complete public model shape, private-data absence and
  zero external requests.
- The focused command is
  `SOCIAL_CUES_CORE_MODEL_FIXTURE_ONLY=true node test.mjs` (set the variable with
  the native shell syntax on Windows).
- The single final `npm test` clears P18 and then stops at the next unrelated
  inherited raw model-write fixture at current `test.mjs:3509`. Its authenticated
  POST omits the required conditional-save envelope and correctly receives `428`
  `workspace_revision_required` with `commitStatus: not_committed`.
- No application, route, authentication, provider, dependency, lockfile,
  deployment or migration source changed in P18.

P17 verification:

- The original configured `canonical-pair` fixture reported credentials ready but
  issued anonymous OAuth-start writes. Both starts correctly returned `403`
  `workspace_writer_unclassified`, with no URL, redirect or external request.
- The same scenario in an authenticated synthetic workspace returned generic
  `200` and direct `302` starts with the expected client ID, HTTPS shop origin,
  callback URI and nonempty state. URL objects are now constructed only after
  status and URL-presence checks pass.
- All **38** scenarios and **58** executions across **10** order sequences pass.
  Callback HMAC behavior, accepted-name inventory, hostile-environment isolation,
  secret absence, configured/unconfigured behavior and zero external requests are
  retained.
- The workspace-token control no longer attempts to inject a provider credential
  through `/api/model`. It uses the canonical local persistence adapter while the
  fixture server is stopped, then proves the encrypted token survives restart but
  leaves Shopify application readiness unconfigured.
- Every scenario stops its child and explicitly proves its directory absent.
- The single final `npm test` clears the Shopify matrix, then stops at the inherited
  unauthenticated `request("/api/model")` assertion: the protected route returns
  `401` with the sign-in-required response at current `test.mjs:3120`. P17 does not
  modify that later fixture or any application source.

P16 verification:

- The focused Twitch fixture passes after two server starts and one clean restart.
- A tampered callback state is rejected before provider exchange or account write.
- The valid callback uses exactly one synthetic token exchange, one synthetic user
  lookup and two synthetic token validations; no live provider request is made.
- The primary account survives restart while the foreign workspace remains blank.
- **382** authentication-verification checks, **165** workspace-authorization
  checks, **111** local-ownership checks and all **9** local-persistence tests pass.
- The P16 Twitch behavior and focused evidence remain unchanged by P17.

P15 contract-only verification:

- **18** Node tests covering the inert activation boundary and hosted CAS behavior.
- **382** authentication-verification checks.
- **165** workspace-authorization checks, including the original **24** checks and
  later identity-policy coverage; zero provider/external requests.
- **111** local-ownership checks plus **6** local-writer inventory tests.
- **33** workspace-content persistence tests, **9** local persistence tests and a
  **27**-check local revisioned-model runtime with zero external dispatches.
- **20** P13/P14 CSV contract tests and **22** recovery/save-coordination tests.
- Zero non-loopback requests; the fixture accepted only `/rest/v1/workspace_models`.
- No SQL, migration, schema, dependency, lockfile, server, frontend, provider,
  billing or deployment change.
- No live Supabase project, environment file, retained data or production system
  was contacted or inspected.

The inherited P17 `ERR_INVALID_URL` was a fixture-ordering symptom, not a Shopify
credential resolver or OAuth-route defect. The fixture attempted anonymous local
state writes after revisioned persistence began requiring an authenticated owner,
then parsed an absent URL before checking the fail-closed response. P17 authenticates
only configured scenarios, preserves unconfigured denial, validates response shape
before parsing and keeps provider tokens outside browser model-write authority.

The inherited P18 `/api/model` `401` was likewise a stale fixture, not an
authentication defect. The test now retains an explicit anonymous control, creates
its existing synthetic owner through the normal signup/session path, and performs
the original public-model and secret-absence assertions only with that session.
The application route remains fail closed.

The inherited `test.mjs:821` failure was a real local persistence interaction, not
a stale response assertion. Revisioned persistence correctly rejected the Twitch
callback's second write as `workspace_shared_state_conflict` after its first write
had advanced the same baseline, leaving no partial account. P16 keeps hosted and
nonlocal behavior unchanged and makes the local callback commit the shared OAuth
state and owner-scoped account atomically through the workspace view. The focused
fixture now proves the response, durable account, restart and foreign-workspace
boundary instead of weakening the original success assertion.

P14 verification:

- **89** pure CSV export/import/manual/evidence/recovery/posting/coordination tests.
- **83** real P14 export browser checks with actual local auth/session/model routes.
- **56** real P13 browser checks with actual local auth/session/model routes.
- **204** manual-entry browser regression checks.
- **118** evidence-draft browser regression checks.
- **56** accepted losing-campaign browser regression checks.
- **21** real concurrent-recovery regression checks.
- **72** mocked content-recovery checks, separately labelled.
- **110** real desktop/mobile local-pilot checks.
- **12** retained P14 resume/restart smoke checks.
- **179** pricing-presentation checks, run once after final HTML.

The P14 browser run used fresh synthetic data and blocked all nonlocal browser
traffic. Its labelled seams hold one completed local review GET during an in-page
context change, replace one completed local review GET with a synthetic failure and
suppress one successful normal-save response. Application routes were not mocked.
All test servers stopped, both task-owned locks were explicitly absent and no
provider request or attempt was observed.

See `PILOT-HANDOFF.md`, `MANUAL-RESULTS.md`,
`.tmp/p14-browser-1788747625333/evidence.json` and
`.tmp/P14-resume-smoke.json` for the exact local evidence and workflow.

The P11 server/store/ownership implementation, P12-R1 save coordination and P13
import boundary remain unchanged by P15. P15 adds a standalone adapter but does
not connect it to a route, initializer or public capability response. No server,
authentication, ownership, provider, billing, dependency, lockfile or deployment
source changed. Authentication, database and provider suites are carried forward
unless listed in the P15 evidence and are not represented as fresh P15 runs.

## Remaining Release Gates

| Gate | What remains unverified or unavailable |
| --- | --- |
| Hosted persistence | The P15 adapter contract is not imported or initialized by `server.mjs`; hosted conditional save therefore remains inactive. The local fake-PostgREST proof is not live Supabase schema/RLS, JWT-gateway, advisor, drift, logging or recovery proof. |
| Retained data and durability | No retained or real data conversion was authorized. Abrupt termination and Windows power-loss guarantees retain their prior qualifications; stale locks are not stolen. |
| Unknown client outcomes | Exact retry is retained in the live page, not a durable browser journal. Reconcile before closing/reloading. After reload, inspect saved evidence and review the source file again. |
| CSV lifetime and provenance | Parsed input exists only in page memory and is lost on reload. CSV is operator-controlled text, not signed evidence. Files may contain private URLs or notes and must remain private. |
| Export snapshot and spreadsheet limits | An exported file is a user-held snapshot, not a signed artifact or proof of current server state. Explicit refresh is required to discover remote changes. Formula protection is contract-tested and browser-inert, but no external spreadsheet product was launched in P14. |
| Duplicate semantics | Detection is exact over validated facts with bounded normalization. Equivalent numeric/time spellings may be distinct; corrected evidence can make older CSV facts distinct again. Review remains mandatory. |
| Evidence truth | Imported URLs are validated but not visited. Metrics are never fetched or verified. Manual records do not prove delivery, account ownership, performance or product impact. |
| Hosting and operations | No production deployment/logs, advisor results, schema drift, worker run, alerting or rollback was checked. |
| Providers | Synthetic readiness and manual receipts do not prove OAuth/account ownership/scopes or successful live delivery. Each offered provider still needs separately authorized live acceptance. |
| Payments and paid AI | No paid call, checkout, portal, financial transaction or production reconciliation was performed. |

Current `vercel.json` still declares root `server.mjs` as the sole function and
`/api/cron/workers` every minute. Deployment configuration is unchanged by P28. This is source
inheritance, not production-deployment or worker verification. Do not recreate
`api/server.mjs`.

Provider approval, quota and credential prerequisites remain distinct from
application defects. Discord application verification remains deferred below 100
installed servers; P28 obtained no current installation count.

## Next Independent Decision

P28 closes the inherited monolithic regression chain with a green local `npm test`.
The next independent decision is whether to review and integrate the accepted
P15-P28 line as one clean candidate or keep hosted P15 activation separate for an
explicitly authorized security/data-integrity review. Do not weaken authentication,
add credentials, contact Discord, enable hosted import, convert historical pilots
or infer production readiness from this local contract. Discord commands,
interactions, bot installation and future application verification remain separate
provider acceptance work.

## R4 Platform Review

The separate settlement-intent/platform review remains **HOLD**. No Support
clearance, permission to resume R4, production readiness or financial execution
is inferred from P28. No R4 implementation or verification was performed.
