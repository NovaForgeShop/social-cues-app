import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStripeBillingApplication } from "./stripe-billing-application.mjs";
import {
  STRIPE_BILLING_SUPPORTED_PRICING_VERSION,
  resolveStripeBillingConfiguration
} from "./stripe-billing-configuration.mjs";
import { createStripeBillingRepository } from "./stripe-billing-repository.mjs";
import {
  POSTGRES_POSTGREST_IMAGE,
  POSTGREST_IMAGE,
  applySqlFile,
  cleanupHarness,
  createHarnessState,
  createNetwork,
  httpJson,
  jwt,
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
const state = createHarnessState("stripe-b2a-postgrest");
const passed = [];
let checks = 0;
let externalRequests = 0;
let loopbackRequests = 0;
let stripeTransportCalls = 0;
let repositoryMutationCallsFromHeldOperations = 0;

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname !== "127.0.0.1") {
    externalRequests += 1;
    throw new Error("Only the Stripe B2A loopback PostgREST endpoint is allowed.");
  }
  loopbackRequests += 1;
  return nativeFetch(input, init);
};

function check(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}
async function scenario(name, action) {
  await action();
  passed.push(name);
  console.log(`PASS ${name}`);
}

const WORKSPACE_A = randomUUID();
const WORKSPACE_B = randomUUID();
const WORKSPACE_C = randomUUID();
const AUTHENTICATED_SUBJECT = randomUUID();
const CUSTOMER_A = "cus_B2AApplicationCustomerA001";
const CUSTOMER_B = "cus_B2AApplicationCustomerB002";
const SUBSCRIPTION_A = "sub_B2AApplicationSubscriptionA001";
const SUBSCRIPTION_B = "sub_B2AApplicationSubscriptionB002";
const SUBSCRIPTION_C = "sub_B2AApplicationSubscriptionC003";
const SESSION_A = "cs_test_B2AApplicationSessionA001";
const SECRET_KEY = registerSecret(state, ["sk", "test", "B2AApplicationSecret0001"].join("_"));
const WEBHOOK_SECRET = registerSecret(state, ["whsec", "B2AApplicationSecret0001"].join("_"));
const EVENT_A = "evt_B2AApplicationEventA001";
const EVENT_B = "evt_B2AApplicationEventB002";
const EVENT_C = "evt_B2AApplicationEventC003";
const EVENT_D = "evt_B2AApplicationEventD004";
const PRICE_A = "price_B2AApplicationBusiness001";
const PRICE_B = "price_B2AApplicationGrowth002";
const PRICE_C = "price_B2AApplicationAgency003";

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
grant select, update on table public.webhook_events to service_role;
create policy "webhook events are service role only"
  on public.webhook_events for all to anon, authenticated
  using (false) with check (false);

grant usage on schema public to anon, authenticated, service_role;
insert into public.workspaces(id) values
  (${quoteLiteral(WORKSPACE_A)}::uuid),
  (${quoteLiteral(WORKSPACE_B)}::uuid),
  (${quoteLiteral(WORKSPACE_C)}::uuid);
`;

function parseRequestBody(body) {
  if (body === undefined || body === null || body === "") return undefined;
  return typeof body === "string" ? JSON.parse(body) : body;
}

function postgrestRequest(token) {
  return async (pathname, options = {}) => {
    const response = await httpJson(state, pathname, {
      method: options.method || "GET",
      token,
      headers: options.headers || {},
      body: parseRequestBody(options.body)
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`PostgREST ${response.status}: ${response.text}`);
    }
    return response.json ?? (response.text ? JSON.parse(response.text) : null);
  };
}

function reconcileInput(overrides = {}) {
  return {
    workspaceId: WORKSPACE_A,
    environment: "test",
    customerId: CUSTOMER_A,
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_A,
    planId: "business",
    subscriptionStatus: "active",
    currentPeriodStart: "2027-01-01T00:00:00.000Z",
    currentPeriodEnd: "2027-02-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    eventCreated: 100,
    eventId: EVENT_A,
    ...overrides
  };
}

function testConfiguration() {
  return resolveStripeBillingConfiguration({
    STRIPE_BILLING_MODE: "test",
    STRIPE_PRICING_CONFIGURATION_VERSION: STRIPE_BILLING_SUPPORTED_PRICING_VERSION,
    STRIPE_TEST_SECRET_KEY: SECRET_KEY,
    STRIPE_TEST_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRICE_BUSINESS_MONTHLY: PRICE_A,
    STRIPE_PRICE_GROWTH_MONTHLY: PRICE_B,
    STRIPE_PRICE_AGENCY_MONTHLY: PRICE_C,
    PUBLIC_APP_URL: "http://127.0.0.1:4177"
  });
}

let primaryError = null;
try {
  await prepareState(state);
  await createNetwork(state);
  await startPostgres(state, { image: POSTGRES_POSTGREST_IMAGE, networked: true });
  await psql(state, baseFixtureSql);
  await startPostgrest(state);

  const serviceToken = registerSecret(state, jwt(state, "service_role"));
  const authenticatedToken = registerSecret(state, jwt(state, "authenticated", AUTHENTICATED_SUBJECT));
  const serviceRepository = createStripeBillingRepository({
    request: postgrestRequest(serviceToken),
    now: () => Date.parse("2027-01-01T00:00:00.000Z")
  });

  await scenario("database readiness reports migration missing before B0R", async () => {
    const readiness = await serviceRepository.probeReadiness();
    equal(readiness.ready, false);
    equal(readiness.state, "database_migration_missing");
  });

  await applySqlFile(state, migrationPath, { timeoutMs: 90_000 });
  await psql(state, "notify pgrst, 'reload schema';");
  const readinessDeadline = Date.now() + 20_000;
  let databaseReadiness;
  while (Date.now() < readinessDeadline) {
    databaseReadiness = await serviceRepository.probeReadiness();
    if (databaseReadiness.ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  await scenario("database readiness succeeds after the exact B0R migration", async () => {
    equal(databaseReadiness?.ready, true, `unexpected readiness ${JSON.stringify(databaseReadiness)}`);
    equal(databaseReadiness?.state, "database_ready");
  });

  await scenario("reconciliation mapping creates an allowlisted binding", async () => {
    const result = await serviceRepository.reconcileBinding(reconcileInput());
    equal(result.workspaceId, WORKSPACE_A);
    equal(result.environment, "test");
    equal(result.resultCode, "created");
    equal(result.applied, true);
  });

  await scenario("workspace binding lookup remains explicitly scoped", async () => {
    const binding = await serviceRepository.getBindingByWorkspace({ workspaceId: WORKSPACE_A, environment: "test" });
    equal(binding.workspaceId, WORKSPACE_A);
    equal(binding.customerId, CUSTOMER_A);
  });

  await scenario("foreign workspace lookup returns no tenant data", async () => {
    const foreign = await serviceRepository.getBindingByWorkspace({ workspaceId: WORKSPACE_B, environment: "test" });
    equal(foreign, null);
  });

  await scenario("customer lookup maps exact durable ownership", async () => {
    const byCustomer = await serviceRepository.getBindingByCustomer({ environment: "test", customerId: CUSTOMER_A });
    equal(byCustomer.workspaceId, WORKSPACE_A);
  });

  await scenario("subscription lookup maps exact durable ownership", async () => {
    const bySubscription = await serviceRepository.getBindingBySubscription({ environment: "test", subscriptionId: SUBSCRIPTION_A });
    equal(bySubscription.workspaceId, WORKSPACE_A);
  });

  await scenario("checkout reservation is idempotent and workspace-bound", async () => {
    const first = await serviceRepository.reserveCheckout({
      workspaceId: WORKSPACE_A,
      environment: "test",
      idempotencyKey: "b2a-postgrest-checkout-key-0001",
      requestedPlanId: "business"
    });
    equal(first.isNew, true);
    const replay = await serviceRepository.reserveCheckout({
      workspaceId: WORKSPACE_A,
      environment: "test",
      idempotencyKey: "b2a-postgrest-checkout-key-0001",
      requestedPlanId: "business"
    });
    equal(replay.isNew, false);
    equal(replay.workspaceId, WORKSPACE_A);
  });

  await scenario("checkout binding and session lookup preserve identity", async () => {
    const bound = await serviceRepository.bindCheckoutSession({
      workspaceId: WORKSPACE_A,
      environment: "test",
      idempotencyKey: "b2a-postgrest-checkout-key-0001",
      requestedPlanId: "business",
      sessionId: SESSION_A,
      lifecycleStatus: "created",
      resultCode: "checkout_created",
      safeResult: { status: "created", resultCode: "checkout_created", planId: "business", url: "https://checkout.stripe.com/c/pay/synthetic" }
    });
    equal(bound.sessionId, SESSION_A);
  });

  await scenario("checkout session lookup remains environment-scoped", async () => {
    const lookup = await serviceRepository.getCheckoutBySession({ environment: "test", sessionId: SESSION_A });
    equal(lookup.workspaceId, WORKSPACE_A);
    equal(lookup.requestedPlanId, "business");
  });

  const webhookInput = {
      workspaceId: WORKSPACE_A,
      environment: "test",
      eventId: "evt_B2AApplicationWebhook001",
      eventType: "customer.subscription.updated",
      staleAfterSeconds: 300
  };
  await scenario("webhook claim maps the exact B0 claim result", async () => {
    const claim = await serviceRepository.claimWebhookEvent(webhookInput);
    equal(claim.claimed, true);
    equal(claim.resultCode, "claimed");
  });

  await scenario("completed webhook replay returns the stored safe result", async () => {
    await serviceRepository.completeWebhookEvent({
      ...webhookInput,
      resultCode: "current_subscription_updated",
      safeResult: { ok: true, status: "reconciled", resultCode: "current_subscription_updated" }
    });
    const replay = await serviceRepository.claimWebhookEvent(webhookInput);
    equal(replay.duplicate, true);
    equal(replay.resultCode, "already_complete");
    const safeResult = await serviceRepository.getWebhookResult(webhookInput);
    equal(safeResult.resultCode, "current_subscription_updated");
  });

  await scenario("B0R rejects durable customer mutation", async () => {
    await assert.rejects(
      () => serviceRepository.reconcileBinding(reconcileInput({ customerId: CUSTOMER_B, eventCreated: 101, eventId: EVENT_B })),
      error => error.code === "repository_request_failed" && !String(error).includes(CUSTOMER_B)
    );
    checks += 1;
  });

  await scenario("subscription replacement succeeds without changing customer", async () => {
    const replacement = await serviceRepository.reconcileBinding(reconcileInput({
      subscriptionId: SUBSCRIPTION_B,
      priceId: PRICE_B,
      planId: "growth",
      eventCreated: 102,
      eventId: EVENT_B
    }));
    equal(replacement.resultCode, "current_subscription_replaced");
    equal(replacement.subscriptionReplaced, true);
  });

  await scenario("terminal cancellation clears the mutable subscription", async () => {
    const cancelled = await serviceRepository.reconcileBinding(reconcileInput({
      subscriptionId: null,
      priceId: null,
      planId: null,
      subscriptionStatus: "canceled",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      eventCreated: 103,
      eventId: EVENT_C
    }));
    equal(cancelled.resultCode, "current_subscription_cleared");
  });

  await scenario("resubscription succeeds after a terminal cancellation", async () => {
    const resubscribed = await serviceRepository.reconcileBinding(reconcileInput({
      subscriptionId: SUBSCRIPTION_C,
      priceId: PRICE_C,
      planId: "agency",
      eventCreated: 104,
      eventId: EVENT_D
    }));
    equal(resubscribed.resultCode, "current_subscription_replaced");
    equal(resubscribed.planId, "agency");
  });

  await scenario("client roles cannot use repository table or RPC paths", async () => {
    const clientRepository = createStripeBillingRepository({ request: postgrestRequest(authenticatedToken) });
    checks += 1;
    await assert.rejects(() => clientRepository.getBindingByWorkspace({ workspaceId: WORKSPACE_A, environment: "test" }));
    checks += 1;
    await assert.rejects(() => clientRepository.claimWebhookEvent({
      workspaceId: WORKSPACE_A,
      environment: "test",
      eventId: "evt_B2AClientDenied001",
      eventType: "invoice.paid",
      staleAfterSeconds: 300
    }));
  });

  await scenario("B2A never creates or mutates billing entitlements", async () => {
    equal(await queryScalar(state, "select pg_catalog.to_regclass('public.billing_entitlements') is null;"), "t");
  });

  const fakeGateway = Object.fromEntries([
    "createCustomer",
    "createCheckoutSession",
    "createPortalSession",
    "verifyWebhookEvent",
    "retrieveSubscription"
  ].map(method => [method, async () => {
    stripeTransportCalls += 1;
    throw new Error(`held method ${method} called`);
  }]));
  const mutationMethods = new Set([
    "reserveCheckout", "bindCheckoutSession", "markCheckoutReconciliationRequired",
    "claimWebhookEvent", "completeWebhookEvent", "failWebhookEvent", "reconcileBinding"
  ]);
  const repositoryProxy = Object.fromEntries(Object.entries(serviceRepository).map(([method, value]) => [
    method,
    mutationMethods.has(method) && typeof value === "function"
      ? (...args) => {
          repositoryMutationCallsFromHeldOperations += 1;
          return value(...args);
        }
      : value
  ]));
  const application = createStripeBillingApplication({
    configuration: testConfiguration(),
    gatewayFactory: () => fakeGateway,
    repositoryFactory: () => repositoryProxy,
    gatewayRequest: async () => {
      stripeTransportCalls += 1;
      throw new Error("Stripe transport called");
    },
    repositoryRequest: postgrestRequest(serviceToken),
    clock: () => 1_800_000_000_000,
    generateEventId: () => "evt_B2AReadinessOnly001"
  });

  await scenario("application reports database-ready test mode with activation held", async () => {
    const readiness = await application.getReadiness();
    equal(readiness.state, "ready_for_later_test_activation");
    equal(readiness.databaseReady, true);
    equal(readiness.checkoutAvailable, false);
    equal(readiness.portalAvailable, false);
    equal(readiness.webhookProcessingAvailable, false);
  });

  await scenario("application checkout remains held despite database readiness", async () => {
    const result = await application.prepareCheckoutHeld({ amount: 1, priceId: PRICE_A });
    equal(result.status, "activation_held");
    equal(stripeTransportCalls, 0);
    equal(repositoryMutationCallsFromHeldOperations, 0);
  });

  await scenario("application portal remains held despite database readiness", async () => {
    const result = await application.preparePortalHeld({ customerId: CUSTOMER_A });
    equal(result.status, "activation_held");
    equal(stripeTransportCalls, 0);
    equal(repositoryMutationCallsFromHeldOperations, 0);
  });

  await scenario("application webhook remains unparsed and held despite database readiness", async () => {
    const result = await application.handleWebhookHeld(new Uint8Array([123, 0, 255]));
    equal(result.status, "activation_held");
    equal(stripeTransportCalls, 0);
    equal(repositoryMutationCallsFromHeldOperations, 0);
  });

  await scenario("workspace billing status is safe and contains no provider identity", async () => {
    const result = await application.getWorkspaceBillingStatus(WORKSPACE_A);
    equal(result.ok, true);
    equal(result.billing.planId, "agency");
    const serialized = JSON.stringify(result);
    for (const value of [CUSTOMER_A, SUBSCRIPTION_C, PRICE_C, SECRET_KEY, WEBHOOK_SECRET]) {
      check(!serialized.includes(value), "safe application status leaked a protected value");
    }
  });

  await scenario("PostgreSQL, PostgREST, stdout, stderr, and responses exclude synthetic secrets", async () => {
    await scanRuntimeSafety(state);
    equal(externalRequests, 0);
    equal(stripeTransportCalls, 0);
    check(loopbackRequests > 0, "local PostgREST was not exercised");
  });
} catch (error) {
  primaryError = error;
} finally {
  globalThis.fetch = nativeFetch;
  try {
    await cleanupHarness(state);
  } catch (cleanupError) {
    primaryError ??= cleanupError;
  }
}

if (primaryError) throw primaryError;
equal(state.cleanupComplete, true);
equal(externalRequests, 0);
equal(stripeTransportCalls, 0);
equal(repositoryMutationCallsFromHeldOperations, 0);

console.log(JSON.stringify({
  ok: true,
  suite: "stripe-billing-application-postgrest",
  scenarios: passed.length,
  passed,
  checks,
  postgresImage: POSTGRES_POSTGREST_IMAGE,
  postgrestImage: POSTGREST_IMAGE,
  network: "isolated-local-bridge",
  loopbackRequests,
  externalRequests,
  stripeTransportCalls,
  repositoryMutationCallsFromHeldOperations,
  entitlementMutations: 0,
  persistentVolumes: 0,
  secretsExposed: 0,
  cleanupComplete: state.cleanupComplete
}));
