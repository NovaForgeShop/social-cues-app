import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  POSTGRES_POSTGREST_IMAGE,
  POSTGREST_IMAGE,
  applySqlFile,
  cleanupHarness,
  createHarnessState,
  createNetwork,
  httpJson,
  jwt,
  jwtClaims,
  prepareState,
  psql,
  queryScalar,
  quoteLiteral,
  registerSecret,
  scanRuntimeSafety,
  startPostgres,
  startPostgrest
} from "./test-support/local-database-harness.mjs";

const repoDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(repoDirectory, "SUPABASE-STRIPE-BILLING-LIFECYCLE.sql");
const migrationSql = await readFile(migrationPath, "utf8");
const state = createHarnessState("postgrest");
const passed = [];
let externalRequests = 0;
let loopbackRequests = 0;

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "127.0.0.1") {
    externalRequests += 1;
    throw new Error("Only the Stripe B0 loopback PostgREST endpoint is allowed.");
  }
  loopbackRequests += 1;
  return nativeFetch(input, init);
};

const stripeSecretCanary = registerSecret(state, ["sk", "test", "B0PostgrestSecretCanary", "f6a21c"].join("_"));
const webhookSecretCanary = registerSecret(state, ["whsec", "B0PostgrestWebhookCanary", "a821de"].join("_"));
const malformedEnvelopeCanary = registerSecret(state, "B0_POSTGREST_MALFORMED_ENVELOPE_CANARY_71D9");
const customerA = registerSecret(state, "cus_B0PostgrestCustomerA123");
const customerB = registerSecret(state, "cus_B0PostgrestCustomerB456");
const subscriptionA = registerSecret(state, "sub_B0PostgrestSubscriptionA123");
const subscriptionB = registerSecret(state, "sub_B0PostgrestSubscriptionB456");
const subscriptionC = registerSecret(state, "sub_B0PostgrestSubscriptionC789");
const checkoutSessionA = registerSecret(state, "cs_test_B0PostgrestCheckoutSessionA123");
const checkoutSessionB = registerSecret(state, "cs_test_B0PostgrestCheckoutSessionB456");

void stripeSecretCanary;
void webhookSecretCanary;

const workspaceA = randomUUID();
const workspaceB = randomUUID();
const workspaceC = randomUUID();
const authenticatedSubject = randomUUID();

const baseFixtureSql = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login noinherit password ${quoteLiteral(state.postgresPassword)};
grant anon, authenticated, service_role to authenticator;

create table public.workspaces (
  id uuid primary key default pg_catalog.gen_random_uuid()
);

create table public.audit_logs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  workspace_id uuid,
  user_id uuid,
  event_type text not null,
  provider text,
  platform text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone not null default pg_catalog.now()
);

create table public.webhook_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  status text not null default 'processing'::text,
  attempts integer not null default 1,
  received_at timestamp with time zone not null default pg_catalog.now(),
  processed_at timestamp with time zone,
  last_error text,
  constraint webhook_events_provider_event_id_key unique (provider, event_id)
);

alter table public.webhook_events enable row level security;
revoke all on table public.webhook_events from public, anon, authenticated;
create policy "webhook events are service role only"
  on public.webhook_events for all to anon, authenticated
  using (false) with check (false);

grant usage on schema public to anon, authenticated, service_role;
insert into public.workspaces(id) values
  (${quoteLiteral(workspaceA)}::uuid),
  (${quoteLiteral(workspaceB)}::uuid),
  (${quoteLiteral(workspaceC)}::uuid);
`;

const reconcileInputNames = [
  "p_workspace_id",
  "p_stripe_environment",
  "p_stripe_customer_id",
  "p_stripe_subscription_id",
  "p_stripe_price_id",
  "p_plan_id",
  "p_subscription_status",
  "p_current_period_start",
  "p_current_period_end",
  "p_cancel_at_period_end",
  "p_event_created",
  "p_event_id"
];

const claimInputNames = [
  "p_workspace_id",
  "p_stripe_environment",
  "p_event_id",
  "p_event_type",
  "p_stale_after_seconds"
];

const reconcileOutputNames = [
  "applied",
  "binding_id",
  "cancel_at_period_end",
  "created_at",
  "current_period_end",
  "current_period_start",
  "plan_id",
  "result_code",
  "stripe_environment",
  "subscription_replaced",
  "subscription_status",
  "updated_at",
  "workspace_id"
];

const claimOutputNames = [
  "claimed", "duplicate", "event_attempts", "event_status", "result_code"
];

function assertDenied(response, context) {
  assert.ok([401, 403, 404].includes(response.status), `${context} was not denied: ${response.status}`);
}

function assertSafeError(response, expectedCode) {
  assert.ok(response.status >= 400 && response.status < 500, `expected client-safe error, received ${response.status}`);
  assert.match(response.text, new RegExp(expectedCode, "u"));
}

function firstRow(response, expectedFields) {
  assert.equal(response.status, 200, response.text);
  assert.ok(Array.isArray(response.json));
  assert.equal(response.json.length, 1);
  const row = response.json[0];
  assert.deepEqual(Object.keys(row).sort(), [...expectedFields].sort());
  return row;
}

async function check(name, fn) {
  await fn();
  passed.push(name);
  console.log(`PASS ${name}`);
}

function reconcileBody({
  workspaceId = workspaceA,
  environment = "test",
  customerId = customerA,
  subscriptionId = subscriptionA,
  priceId = "price_B0PostgrestPriceA123",
  planId = "business",
  status = "active",
  periodStart = "2026-08-01T00:00:00Z",
  periodEnd = "2026-09-01T00:00:00Z",
  cancelAtPeriodEnd = false,
  eventCreated = 100,
  eventId = "evt_B0PostgrestEventA123"
} = {}) {
  return {
    p_workspace_id: workspaceId,
    p_stripe_environment: environment,
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: subscriptionId,
    p_stripe_price_id: priceId,
    p_plan_id: planId,
    p_subscription_status: status,
    p_current_period_start: periodStart,
    p_current_period_end: periodEnd,
    p_cancel_at_period_end: cancelAtPeriodEnd,
    p_event_created: eventCreated,
    p_event_id: eventId
  };
}

function claimBody({
  workspaceId = workspaceA,
  environment = "test",
  eventId = "evt_B0PostgrestWebhook123",
  eventType = "invoice.paid",
  staleAfterSeconds = 300
} = {}) {
  return {
    p_workspace_id: workspaceId,
    p_stripe_environment: environment,
    p_event_id: eventId,
    p_event_type: eventType,
    p_stale_after_seconds: staleAfterSeconds
  };
}

let primaryError = null;
try {
  await prepareState(state);
  const crlfMigrationPath = path.join(state.tempDirectory, "stripe-b0-postgrest-crlf.sql");
  const canonicalMigrationSql = migrationSql.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  await writeFile(crlfMigrationPath, canonicalMigrationSql.replaceAll("\n", "\r\n"), "utf8");
  await createNetwork(state);
  await startPostgres(state, { image: POSTGRES_POSTGREST_IMAGE, networked: true });
  await psql(state, baseFixtureSql);
  await applySqlFile(state, crlfMigrationPath, { timeoutMs: 90_000 });
  await startPostgrest(state);

  const serviceToken = registerSecret(state, jwt(state, "service_role"));
  const authenticatedToken = registerSecret(state, jwt(state, "authenticated", authenticatedSubject));
  const wrongRoleToken = registerSecret(state, jwt(state, "postgres"));
  const missingRoleToken = registerSecret(state, jwtClaims(state, {
    sub: authenticatedSubject,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600
  }));

  await check("OpenAPI discovers only the exact RPC input signatures", async () => {
    const response = await httpJson(state, "/", {
      token: serviceToken,
      headers: { Accept: "application/openapi+json" }
    });
    assert.equal(response.status, 200);
    const reconcilePath = response.json?.paths?.["/rpc/social_cues_reconcile_stripe_binding"];
    const claimPath = response.json?.paths?.["/rpc/social_cues_claim_stripe_webhook_event"];
    assert.ok(reconcilePath?.post, "reconciliation RPC missing from HTTP discovery");
    assert.ok(claimPath?.post, "claim RPC missing from HTTP discovery");

    const reconcileDefinition = JSON.stringify(reconcilePath.post);
    const claimDefinition = JSON.stringify(claimPath.post);
    for (const inputName of reconcileInputNames) assert.match(reconcileDefinition, new RegExp(`"${inputName}"`, "u"));
    for (const inputName of claimInputNames) assert.match(claimDefinition, new RegExp(`"${inputName}"`, "u"));
    for (const unexpected of ["workspace_id", "stripe_secret", "raw_payload"]) {
      assert.equal(reconcileInputNames.includes(unexpected), false);
      assert.equal(claimInputNames.includes(unexpected), false);
    }

    const signatures = await queryScalar(state, `
      select pg_catalog.bool_and(signature = expected_signature)
      from (
        select function_catalog.proname,
               pg_catalog.oidvectortypes(function_catalog.proargtypes) as signature,
               case function_catalog.proname
                 when 'social_cues_reconcile_stripe_binding' then 'uuid, text, text, text, text, text, text, timestamp with time zone, timestamp with time zone, boolean, bigint, text'
                 when 'social_cues_claim_stripe_webhook_event' then 'uuid, text, text, text, integer'
               end as expected_signature
        from pg_catalog.pg_proc function_catalog
        join pg_catalog.pg_namespace namespace_catalog on namespace_catalog.oid = function_catalog.pronamespace
        where namespace_catalog.nspname = 'public'
          and function_catalog.proname in ('social_cues_reconcile_stripe_binding', 'social_cues_claim_stripe_webhook_event')
      ) signatures;
    `);
    assert.equal(signatures, "t");
  });

  await check("anonymous, authenticated, wrong-role, and missing-role RPC calls fail", async () => {
    const body = reconcileBody();
    assertDenied(await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", { method: "POST", body }), "anonymous RPC");
    assertDenied(await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", { method: "POST", token: authenticatedToken, body }), "authenticated RPC");
    assertDenied(await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", { method: "POST", token: wrongRoleToken, body }), "wrong-role RPC");
    assertDenied(await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", { method: "POST", token: missingRoleToken, body }), "missing-role RPC");
  });

  await check("client table reads and writes are denied", async () => {
    for (const [label, token] of [["anonymous", null], ["authenticated", authenticatedToken]]) {
      const read = await httpJson(state, "/stripe_billing_bindings?select=id", { token });
      assertDenied(read, `${label} binding read`);
      const write = await httpJson(state, "/stripe_checkout_sessions", {
        method: "POST",
        token,
        body: {
          workspace_id: workspaceA,
          stripe_environment: "test",
          idempotency_key: "postgrest-client-key-00000001",
          requested_plan_id: "business"
        }
      });
      assertDenied(write, `${label} checkout write`);
    }
  });

  await check("authenticated object possession cannot authorize cross-workspace reconciliation", async () => {
    const response = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: authenticatedToken,
      body: reconcileBody({ workspaceId: workspaceB, eventId: "evt_B0PostgrestCrossWorkspace123" })
    });
    assertDenied(response, "cross-workspace authenticated RPC");
    assert.equal(await queryScalar(state, `select not exists(select 1 from public.stripe_billing_bindings where workspace_id = ${quoteLiteral(workspaceB)}::uuid);`), "t");
  });

  await check("service role creates an allowlisted binding response", async () => {
    const response = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: serviceToken,
      body: reconcileBody()
    });
    const row = firstRow(response, reconcileOutputNames);
    assert.equal(row.applied, true);
    assert.equal(row.result_code, "created");
    assert.equal("stripe_customer_id" in row, false);
    assert.equal("stripe_subscription_id" in row, false);

    const serviceRead = await httpJson(state, "/stripe_billing_bindings?select=id,workspace_id,stripe_environment,plan_id,subscription_status", { token: serviceToken });
    assert.equal(serviceRead.status, 200);
    assert.equal(serviceRead.json.length, 1);
  });

  await check("service checkout writes enforce safe metadata, one-time identity, and no delete", async () => {
    const idempotencyKey = "postgrest-service-key-00000001";
    const create = await httpJson(state, "/stripe_checkout_sessions", {
      method: "POST",
      token: serviceToken,
      body: {
        workspace_id: workspaceA,
        stripe_environment: "test",
        idempotency_key: idempotencyKey,
        requested_plan_id: "business",
        lifecycle_status: "reserved",
        safe_result: { outcome: "reserved" }
      }
    });
    assert.equal(create.status, 201, create.text);

    const bindSession = await httpJson(state, `/stripe_checkout_sessions?idempotency_key=eq.${idempotencyKey}`, {
      method: "PATCH",
      token: serviceToken,
      body: {
        stripe_session_id: checkoutSessionA,
        lifecycle_status: "created",
        safe_result: { outcome: "created" }
      }
    });
    assert.ok([200, 204].includes(bindSession.status), bindSession.text);
    assert.equal(await queryScalar(state, `select stripe_session_id = ${quoteLiteral(checkoutSessionA)} from public.stripe_checkout_sessions where idempotency_key = ${quoteLiteral(idempotencyKey)};`), "t");

    const replaceSession = await httpJson(state, `/stripe_checkout_sessions?idempotency_key=eq.${idempotencyKey}`, {
      method: "PATCH",
      token: serviceToken,
      body: { stripe_session_id: checkoutSessionB }
    });
    assertSafeError(replaceSession, "STRIPE_B0_IMMUTABLE_CHECKOUT_IDENTITY_CONFLICT");

    const unsafeResult = await httpJson(state, `/stripe_checkout_sessions?idempotency_key=eq.${idempotencyKey}`, {
      method: "PATCH",
      token: serviceToken,
      body: { safe_result: { nested: { authorization: stripeSecretCanary } } }
    });
    assertSafeError(unsafeResult, "STRIPE_B0_CHECKOUT_SAFE_RESULT_INVALID");

    const deleteHistory = await httpJson(state, `/stripe_checkout_sessions?idempotency_key=eq.${idempotencyKey}`, {
      method: "DELETE",
      token: serviceToken
    });
    assert.ok([401, 403, 404, 405].includes(deleteHistory.status), `service-role checkout DELETE was not denied: ${deleteHistory.status}`);
    assert.equal(await queryScalar(state, `select pg_catalog.count(*) from public.stripe_checkout_sessions where idempotency_key = ${quoteLiteral(idempotencyKey)};`), "1");
  });

  await check("invalid environment, plan, and malformed envelopes fail safely", async () => {
    const invalidEnvironment = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: serviceToken,
      body: reconcileBody({ workspaceId: workspaceC, customerId: customerB, subscriptionId: subscriptionC, environment: "preview", eventCreated: 101, eventId: "evt_B0PostgrestInvalidEnv123" })
    });
    assertSafeError(invalidEnvironment, "STRIPE_B0_RECONCILIATION_INPUT_INVALID");

    const invalidPlan = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: serviceToken,
      body: reconcileBody({ workspaceId: workspaceC, customerId: customerB, subscriptionId: subscriptionC, planId: "enterprise", eventCreated: 102, eventId: "evt_B0PostgrestInvalidPlan123" })
    });
    assertSafeError(invalidPlan, "STRIPE_B0_SUBSCRIPTION_STATE_INVALID");

    const malformed = await httpJson(state, "/rpc/social_cues_claim_stripe_webhook_event", {
      method: "POST",
      token: serviceToken,
      body: {
        p_workspace_id: workspaceA,
        p_stripe_environment: "test",
        p_event_type: malformedEnvelopeCanary,
        p_stale_after_seconds: 300
      }
    });
    assert.ok(malformed.status >= 400 && malformed.status < 500);
  });

  await check("customer replacement fails while subscription replacement succeeds", async () => {
    const customerReplacement = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: serviceToken,
      body: reconcileBody({ customerId: customerB, eventCreated: 103, eventId: "evt_B0PostgrestCustomerChange123" })
    });
    assertSafeError(customerReplacement, "STRIPE_B0_CUSTOMER_CHANGE_REJECTED");

    const replacement = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: serviceToken,
      body: reconcileBody({
        subscriptionId: subscriptionB,
        priceId: "price_B0PostgrestPriceB456",
        planId: "growth",
        eventCreated: 104,
        eventId: "evt_B0PostgrestReplacement456"
      })
    });
    const replacementRow = firstRow(replacement, reconcileOutputNames);
    assert.equal(replacementRow.subscription_replaced, true);
    assert.equal(replacementRow.result_code, "current_subscription_replaced");
  });

  await check("cancellation followed by resubscription succeeds", async () => {
    const cancellation = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: serviceToken,
      body: reconcileBody({
        subscriptionId: null,
        priceId: null,
        planId: null,
        status: "canceled",
        periodStart: null,
        periodEnd: null,
        eventCreated: 105,
        eventId: "evt_B0PostgrestCancellation789"
      })
    });
    assert.equal(firstRow(cancellation, reconcileOutputNames).result_code, "current_subscription_cleared");

    const resubscription = await httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", {
      method: "POST",
      token: serviceToken,
      body: reconcileBody({
        subscriptionId: subscriptionC,
        priceId: "price_B0PostgrestPriceC789",
        planId: "agency",
        eventCreated: 106,
        eventId: "evt_B0PostgrestResubscription789"
      })
    });
    const resubscriptionRow = firstRow(resubscription, reconcileOutputNames);
    assert.equal(resubscriptionRow.subscription_replaced, true);
    assert.equal(resubscriptionRow.plan_id, "agency");
  });

  await check("event claim first use, replay, and HTTP concurrency are deterministic", async () => {
    const first = await httpJson(state, "/rpc/social_cues_claim_stripe_webhook_event", {
      method: "POST", token: serviceToken, body: claimBody()
    });
    const firstClaim = firstRow(first, claimOutputNames);
    assert.deepEqual(firstClaim, {
      claimed: true,
      duplicate: false,
      event_status: "processing",
      event_attempts: 1,
      result_code: "claimed"
    });

    const replay = await httpJson(state, "/rpc/social_cues_claim_stripe_webhook_event", {
      method: "POST", token: serviceToken, body: claimBody()
    });
    assert.equal(firstRow(replay, claimOutputNames).result_code, "already_claimed");

    const mismatchedType = await httpJson(state, "/rpc/social_cues_claim_stripe_webhook_event", {
      method: "POST",
      token: serviceToken,
      body: claimBody({ eventType: "invoice.payment_failed" })
    });
    assertSafeError(mismatchedType, "STRIPE_B0_WEBHOOK_CLAIM_CONFLICT");

    const concurrentBody = claimBody({ eventId: "evt_B0PostgrestConcurrentWebhook456" });
    const concurrent = await Promise.all([
      httpJson(state, "/rpc/social_cues_claim_stripe_webhook_event", { method: "POST", token: serviceToken, body: concurrentBody }),
      httpJson(state, "/rpc/social_cues_claim_stripe_webhook_event", { method: "POST", token: serviceToken, body: concurrentBody })
    ]);
    const results = concurrent.map(response => firstRow(response, claimOutputNames).result_code).sort();
    assert.deepEqual(results, ["already_claimed", "claimed"]);
    assert.equal(await queryScalar(state, "select pg_catalog.count(*) from public.webhook_events where provider = 'stripe' and event_id = 'test:evt_B0PostgrestConcurrentWebhook456';"), "1");
  });

  await check("competing HTTP subscription updates converge on the newest event", async () => {
    const lowBody = reconcileBody({
      subscriptionId: subscriptionB,
      priceId: "price_B0PostgrestPriceB456",
      planId: "growth",
      eventCreated: 107,
      eventId: "evt_B0PostgrestConcurrentLow456"
    });
    const highBody = reconcileBody({
      subscriptionId: subscriptionC,
      priceId: "price_B0PostgrestPriceC789",
      planId: "agency",
      eventCreated: 108,
      eventId: "evt_B0PostgrestConcurrentHigh789"
    });
    const [low, high] = await Promise.all([
      httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", { method: "POST", token: serviceToken, body: lowBody }),
      httpJson(state, "/rpc/social_cues_reconcile_stripe_binding", { method: "POST", token: serviceToken, body: highBody })
    ]);
    firstRow(low, reconcileOutputNames);
    assert.equal(firstRow(high, reconcileOutputNames).applied, true);
    assert.equal(await queryScalar(state, `select latest_event_created = 108 and stripe_subscription_id = ${quoteLiteral(subscriptionC)} from public.stripe_billing_bindings where workspace_id = ${quoteLiteral(workspaceA)}::uuid and stripe_environment = 'test';`), "t");
  });

  await check("PostgreSQL, PostgREST, HTTP, stdout, and stderr exclude canaries", async () => {
    await scanRuntimeSafety(state);
    assert.equal(externalRequests, 0);
    assert.ok(loopbackRequests > 0);
  });
} catch (error) {
  primaryError = error;
} finally {
  try {
    await cleanupHarness(state);
  } catch (cleanupError) {
    primaryError ??= cleanupError;
  }
}

if (primaryError) throw primaryError;
assert.equal(state.cleanupComplete, true);
assert.equal(externalRequests, 0);

console.log(JSON.stringify({
  ok: true,
  suite: "stripe-billing-database-postgrest",
  passed: passed.length,
  checks: passed,
  postgresImage: POSTGRES_POSTGREST_IMAGE,
  postgrestImage: POSTGREST_IMAGE,
  migrationLineEndings: "crlf",
  network: "isolated-local-bridge",
  loopbackRequests,
  externalRequests,
  persistentVolumes: 0,
  cleanupComplete: state.cleanupComplete
}));
