import assert from "node:assert/strict";
import {
  createStripeBillingRepository,
  STRIPE_BILLING_REPOSITORY_METHOD_MAP,
  StripeBillingRepositoryError
} from "./stripe-billing-repository.mjs";

let checks = 0;
function check(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "cus_synthetic000001";
const SUBSCRIPTION = "sub_synthetic000001";
const SESSION = "cs_test_synthetic000001";
const EVENT = "evt_synthetic000001";
const calls = [];

function bindingRow(overrides = {}) {
  return {
    workspace_id: WORKSPACE_A,
    stripe_environment: "test",
    stripe_customer_id: CUSTOMER,
    stripe_subscription_id: SUBSCRIPTION,
    stripe_price_id: "price_business000001",
    plan_id: "business",
    subscription_status: "active",
    current_period_start: "2027-01-01T00:00:00.000Z",
    current_period_end: "2027-02-01T00:00:00.000Z",
    cancel_at_period_end: false,
    latest_event_created: 1800000000,
    latest_event_id: EVENT,
    created_at: "2027-01-01T00:00:00.000Z",
    updated_at: "2027-01-01T00:00:00.000Z",
    ...overrides
  };
}

function checkoutRow(overrides = {}) {
  return {
    workspace_id: WORKSPACE_A,
    stripe_environment: "test",
    stripe_session_id: null,
    idempotency_key: "checkout-contract-key-0001",
    requested_plan_id: "business",
    lifecycle_status: "reserved",
    result_code: "reserved",
    safe_result: {},
    created_at: "2027-01-01T00:00:00.000Z",
    updated_at: "2027-01-01T00:00:00.000Z",
    ...overrides
  };
}

function webhookRow(overrides = {}) {
  return {
    provider: "stripe",
    event_id: `test:${EVENT}`,
    event_type: "customer.subscription.updated",
    status: "processing",
    attempts: 1,
    environment: "test",
    workspace_id: WORKSPACE_A,
    result_code: "claimed",
    processing_result: {},
    received_at: "2027-01-01T00:00:00.000Z",
    processed_at: null,
    ...overrides
  };
}

const openApi = {
  paths: {
    "/rpc/social_cues_reconcile_stripe_binding": { post: Object.fromEntries([
      "p_workspace_id", "p_stripe_environment", "p_stripe_customer_id", "p_stripe_subscription_id",
      "p_stripe_price_id", "p_plan_id", "p_subscription_status", "p_current_period_start",
      "p_current_period_end", "p_cancel_at_period_end", "p_event_created", "p_event_id"
    ].map(name => [name, {}])) },
    "/rpc/social_cues_claim_stripe_webhook_event": { post: Object.fromEntries([
      "p_workspace_id", "p_stripe_environment", "p_event_id", "p_event_type", "p_stale_after_seconds"
    ].map(name => [name, {}])) }
  },
  definitions: {
    stripe_billing_bindings: { properties: Object.fromEntries(Object.keys(bindingRow()).map(name => [name, {}])) },
    stripe_checkout_sessions: { properties: Object.fromEntries(Object.keys(checkoutRow()).map(name => [name, {}])) },
    webhook_events: { properties: Object.fromEntries(Object.keys(webhookRow()).map(name => [name, {}])) }
  }
};

let reservationExists = false;
let currentCheckout = checkoutRow();
let currentWebhook = webhookRow();
async function request(pathname, options = {}) {
  calls.push({ pathname, options });
  if (pathname === "/") return openApi;
  if (/limit=0$/u.test(pathname)) return [];
  if (pathname.startsWith("/stripe_billing_bindings?")) {
    if (pathname.includes(`workspace_id=eq.${WORKSPACE_B}`)) return [];
    return [bindingRow()];
  }
  if (pathname.startsWith("/stripe_checkout_sessions?on_conflict=")) {
    if (reservationExists) return [];
    reservationExists = true;
    return [currentCheckout];
  }
  if (pathname.startsWith("/stripe_checkout_sessions?") && options.method === "PATCH") {
    const changes = JSON.parse(options.body);
    currentCheckout = checkoutRow({ ...currentCheckout, ...changes });
    return [currentCheckout];
  }
  if (pathname.startsWith("/stripe_checkout_sessions?")) return reservationExists ? [currentCheckout] : [];
  if (pathname === "/rpc/social_cues_claim_stripe_webhook_event") {
    return [{ claimed: true, duplicate: false, event_status: "processing", event_attempts: 1, result_code: "claimed" }];
  }
  if (pathname === "/rpc/social_cues_reconcile_stripe_binding") {
    return [{
      binding_id: "33333333-3333-4333-8333-333333333333",
      workspace_id: WORKSPACE_A,
      stripe_environment: "test",
      plan_id: "business",
      subscription_status: "active",
      current_period_start: "2027-01-01T00:00:00.000Z",
      current_period_end: "2027-02-01T00:00:00.000Z",
      cancel_at_period_end: false,
      applied: true,
      result_code: "current_subscription_updated",
      subscription_replaced: false,
      created_at: "2027-01-01T00:00:00.000Z",
      updated_at: "2027-01-01T00:00:00.000Z"
    }];
  }
  if (pathname.startsWith("/webhook_events?") && options.method === "PATCH") {
    const changes = JSON.parse(options.body);
    currentWebhook = webhookRow({ ...currentWebhook, ...changes });
    return [currentWebhook];
  }
  if (pathname.startsWith("/webhook_events?")) return [currentWebhook];
  throw new Error("unexpected fake request");
}

const repository = createStripeBillingRepository({ request, now: () => 1_800_000_000_000 });
const expectedMethods = [
  "getBindingByWorkspace",
  "getBindingByCustomer",
  "getBindingBySubscription",
  "getCheckoutBySession",
  "reserveCheckout",
  "bindCheckoutSession",
  "markCheckoutReconciliationRequired",
  "claimWebhookEvent",
  "getWebhookResult",
  "completeWebhookEvent",
  "failWebhookEvent",
  "reconcileBinding"
];
assert.deepEqual(Object.keys(STRIPE_BILLING_REPOSITORY_METHOD_MAP), expectedMethods);
checks += 1;
for (const method of expectedMethods) equal(typeof repository[method], "function", `${method} is missing`);

const readiness = await repository.probeReadiness();
equal(readiness.ready, true);
equal(readiness.state, "database_ready");
equal(calls.filter(call => /limit=0$/u.test(call.pathname)).length, 3, "probe did not inspect all B0 tables");
equal(calls.filter(call => call.pathname.startsWith("/rpc/")).length, 0, "readiness probe executed an RPC");

const byWorkspace = await repository.getBindingByWorkspace({ workspaceId: WORKSPACE_A, environment: "test" });
equal(byWorkspace.workspaceId, WORKSPACE_A);
equal(byWorkspace.environment, "test");
equal(byWorkspace.customerId, CUSTOMER);
const foreignWorkspace = await repository.getBindingByWorkspace({ workspaceId: WORKSPACE_B, environment: "test" });
equal(foreignWorkspace, null, "foreign workspace lookup returned another tenant");
const byCustomer = await repository.getBindingByCustomer({ environment: "test", customerId: CUSTOMER });
equal(byCustomer.workspaceId, WORKSPACE_A);
const bySubscription = await repository.getBindingBySubscription({ environment: "test", subscriptionId: SUBSCRIPTION });
equal(bySubscription.workspaceId, WORKSPACE_A);

const reserved = await repository.reserveCheckout({
  workspaceId: WORKSPACE_A,
  environment: "test",
  idempotencyKey: "checkout-contract-key-0001",
  requestedPlanId: "business"
});
equal(reserved.isNew, true);
equal(reserved.lifecycleStatus, "reserved");
const replayedReservation = await repository.reserveCheckout({
  workspaceId: WORKSPACE_A,
  environment: "test",
  idempotencyKey: "checkout-contract-key-0001",
  requestedPlanId: "business"
});
equal(replayedReservation.isNew, false);
equal(replayedReservation.requestedPlanId, "business");

const bound = await repository.bindCheckoutSession({
  workspaceId: WORKSPACE_A,
  environment: "test",
  idempotencyKey: "checkout-contract-key-0001",
  requestedPlanId: "business",
  sessionId: SESSION,
  lifecycleStatus: "created",
  resultCode: "checkout_created",
  safeResult: { status: "created", resultCode: "checkout_created", planId: "business", url: "https://checkout.stripe.com/c/pay/synthetic" }
});
equal(bound.sessionId, SESSION);
equal(bound.lifecycleStatus, "created");
const bySession = await repository.getCheckoutBySession({ environment: "test", sessionId: SESSION });
equal(bySession.workspaceId, WORKSPACE_A);
equal(bySession.sessionId, SESSION);

const marked = await repository.markCheckoutReconciliationRequired({
  workspaceId: WORKSPACE_A,
  environment: "test",
  idempotencyKey: "checkout-contract-key-0001",
  lifecycleStatus: "failed",
  resultCode: "checkout_reconciliation_required",
  safeResult: { status: "reconciliation_required", resultCode: "checkout_reconciliation_required" }
});
equal(marked.lifecycleStatus, "failed");

const claim = await repository.claimWebhookEvent({
  workspaceId: WORKSPACE_A,
  environment: "test",
  eventId: EVENT,
  eventType: "customer.subscription.updated",
  staleAfterSeconds: 300
});
equal(claim.claimed, true);
equal(claim.duplicate, false);
const claimCall = calls.find(call => call.pathname === "/rpc/social_cues_claim_stripe_webhook_event");
assert.deepEqual(JSON.parse(claimCall.options.body), {
  p_workspace_id: WORKSPACE_A,
  p_stripe_environment: "test",
  p_event_id: EVENT,
  p_event_type: "customer.subscription.updated",
  p_stale_after_seconds: 300
});
checks += 1;

currentWebhook = webhookRow({ processing_result: { ok: true, status: "reconciled", resultCode: "current_subscription_updated" } });
const webhookResult = await repository.getWebhookResult({
  workspaceId: WORKSPACE_A,
  environment: "test",
  eventId: EVENT,
  eventType: "customer.subscription.updated"
});
equal(webhookResult.resultCode, "current_subscription_updated");
const completed = await repository.completeWebhookEvent({
  workspaceId: WORKSPACE_A,
  environment: "test",
  eventId: EVENT,
  eventType: "customer.subscription.updated",
  resultCode: "current_subscription_updated",
  safeResult: { ok: true, status: "reconciled", resultCode: "current_subscription_updated" }
});
equal(completed.completed, true);
currentWebhook = webhookRow();
const failed = await repository.failWebhookEvent({
  workspaceId: WORKSPACE_A,
  environment: "test",
  eventId: EVENT,
  eventType: "customer.subscription.updated",
  resultCode: "repository_unavailable",
  retryable: true
});
equal(failed.failed, true);

const reconciled = await repository.reconcileBinding({
  workspaceId: WORKSPACE_A,
  environment: "test",
  customerId: CUSTOMER,
  subscriptionId: SUBSCRIPTION,
  priceId: "price_business000001",
  planId: "business",
  subscriptionStatus: "active",
  currentPeriodStart: "2027-01-01T00:00:00.000Z",
  currentPeriodEnd: "2027-02-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  eventCreated: 1800000000,
  eventId: EVENT
});
equal(reconciled.applied, true);
equal(reconciled.resultCode, "current_subscription_updated");
const reconcileCall = calls.find(call => call.pathname === "/rpc/social_cues_reconcile_stripe_binding");
assert.deepEqual(Object.keys(JSON.parse(reconcileCall.options.body)).sort(), [
  "p_cancel_at_period_end",
  "p_current_period_end",
  "p_current_period_start",
  "p_event_created",
  "p_event_id",
  "p_plan_id",
  "p_stripe_customer_id",
  "p_stripe_environment",
  "p_stripe_price_id",
  "p_stripe_subscription_id",
  "p_subscription_status",
  "p_workspace_id"
].sort());
checks += 1;

const requestLog = JSON.stringify(calls.map(call => ({ pathname: call.pathname, method: call.options.method || "GET", body: call.options.body || "" })));
check(!requestLog.includes("billing_entitlements"), "repository touched billing_entitlements");
check(!requestLog.includes("anon"), "repository supplied a client role");
check(!requestLog.includes("authenticated"), "repository supplied an authenticated client role");
check(calls.every(call => !call.pathname.includes(WORKSPACE_B) || call.pathname.includes(`workspace_id=eq.${WORKSPACE_B}`)), "cross-workspace lookup lost its filter");

const missingProbe = createStripeBillingRepository({
  request: async pathname => {
    if (pathname === "/") return { paths: {}, definitions: {} };
    throw new Error("must not continue incomplete probe");
  }
});
equal((await missingProbe.probeReadiness()).state, "database_migration_missing");

const unavailableRepository = createStripeBillingRepository({
  request: async () => { throw new Error(`raw SQL secret ${CUSTOMER}`); }
});
checks += 1;
await assert.rejects(
  () => unavailableRepository.getBindingByWorkspace({ workspaceId: WORKSPACE_A, environment: "test" }),
  error => error instanceof StripeBillingRepositoryError
    && error.code === "repository_request_failed"
    && !String(error).includes(CUSTOMER)
);

console.log(JSON.stringify({
  ok: true,
  suite: "stripe-billing-repository",
  checks,
  mappedMethods: expectedMethods.length,
  injectedPostgrestCalls: calls.length,
  remoteDatabaseRequests: 0,
  entitlementMutations: 0,
  secretsExposed: 0
}));
