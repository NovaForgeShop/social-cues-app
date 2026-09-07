import assert from "node:assert/strict";
import crypto from "node:crypto";

let globalFetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  globalFetchCalls += 1;
  throw new Error("global fetch must not be used");
};
const {
  createStripeBillingGateway,
  StripeBillingGatewayError
} = await import("./stripe-billing-gateway.mjs");
const { STRIPE_BILLING_API_VERSION } = await import("./stripe-billing-configuration.mjs");

let checks = 0;
function check(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}
async function rejectsCode(action, code) {
  checks += 1;
  await assert.rejects(action, error => error instanceof StripeBillingGatewayError && error.code === code);
}

const SECRET_KEY = ["sk", "test", "gateway00000001"].join("_");
const WEBHOOK_SECRET = ["whsec", "gateway00000001"].join("_");
const NOW = 1_800_000_000_000;
const calls = [];
const responses = {
  "/v1/customers": { id: "cus_synthetic000001", livemode: false },
  "/v1/checkout/sessions": { id: "cs_test_synthetic000001", livemode: false, url: "https://checkout.stripe.com/c/pay/synthetic" },
  "/v1/billing_portal/sessions": { id: "bps_synthetic000001", url: "https://billing.stripe.com/p/session/synthetic" },
  "/v1/subscriptions/sub_synthetic000001": {
    id: "sub_synthetic000001",
    customer: "cus_synthetic000001",
    livemode: false,
    status: "active",
    current_period_start: 1_799_000_000,
    current_period_end: 1_801_000_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_business000001" } }] }
  }
};

async function request(url, options) {
  calls.push({ url, options });
  const pathname = new URL(url).pathname;
  const body = responses[pathname];
  return { status: body ? 200 : 404, body: JSON.stringify(body || { error: { message: "not found" } }) };
}

const gateway = createStripeBillingGateway({
  configuration: {
    environment: "test",
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    apiVersion: STRIPE_BILLING_API_VERSION
  },
  request,
  timeoutMs: 1000,
  timestampToleranceSeconds: 300,
  now: () => NOW
});

equal(calls.length, 0, "gateway import or construction performed a request");
equal(globalFetchCalls, 0, "gateway used global fetch during import or construction");

const customer = await gateway.createCustomer({
  workspaceId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "customer:test:workspace-0001"
});
equal(customer.customerId, "cus_synthetic000001");
equal(customer.environment, "test");

const checkout = await gateway.createCheckoutSession({
  workspaceId: "11111111-1111-4111-8111-111111111111",
  customerId: "cus_synthetic000001",
  planId: "business",
  priceId: "price_business000001",
  successUrl: "https://socialcuesapp.com/portal?checkout=success",
  cancelUrl: "https://socialcuesapp.com/portal?checkout=cancelled",
  idempotencyKey: "checkout:test:workspace-0001"
});
equal(checkout.checkoutSessionId, "cs_test_synthetic000001");
equal(checkout.url, "https://checkout.stripe.com/c/pay/synthetic");
equal("customerId" in checkout, false);
equal("priceId" in checkout, false);

const checkoutCall = calls.find(call => new URL(call.url).pathname === "/v1/checkout/sessions");
equal(checkoutCall.options.method, "POST");
equal(checkoutCall.options.headers["Stripe-Version"], "2026-05-27.dahlia");
equal(checkoutCall.options.headers.Authorization, `Bearer ${SECRET_KEY}`);
equal(checkoutCall.options.headers["Idempotency-Key"], "checkout:test:workspace-0001");
const checkoutForm = new URLSearchParams(checkoutCall.options.body);
equal(checkoutForm.get("mode"), "subscription");
equal(checkoutForm.get("customer"), "cus_synthetic000001");
equal(checkoutForm.get("line_items[0][price]"), "price_business000001");
equal(checkoutForm.get("line_items[0][quantity]"), "1");
equal(checkoutForm.get("metadata[workspace_id]"), "11111111-1111-4111-8111-111111111111");
equal(checkoutForm.get("metadata[plan_id]"), "business");
for (const forbidden of ["amount", "currency", "product", "payment_link", "customer_email", "payment_method_types[]"]) {
  equal(checkoutForm.has(forbidden), false, `checkout form accepted ${forbidden}`);
}

const portal = await gateway.createPortalSession({
  customerId: "cus_synthetic000001",
  returnUrl: "https://socialcuesapp.com/portal?stay=1",
  idempotencyKey: "portal:test:workspace-00001"
});
equal(portal.url, "https://billing.stripe.com/p/session/synthetic");
equal(portal.environment, "test");

const subscription = await gateway.retrieveSubscription({ subscriptionId: "sub_synthetic000001" });
equal(subscription.customerId, "cus_synthetic000001");
equal(subscription.subscriptionId, "sub_synthetic000001");
equal(subscription.priceId, "price_business000001");
equal(subscription.status, "active");

const callsBeforeUnsafe = calls.length;
responses["/v1/billing_portal/sessions"] = { url: "https://example.com/steal" };
await rejectsCode(() => gateway.createPortalSession({
  customerId: "cus_synthetic000001",
  returnUrl: "https://socialcuesapp.com/portal",
  idempotencyKey: "portal:test:unsafe-00000001"
}), "portal_url_invalid");
equal(calls.length, callsBeforeUnsafe + 1, "unsafe provider URL caused an automatic retry");

let rejectedCalls = 0;
const rejectingGateway = createStripeBillingGateway({
  configuration: {
    environment: "test",
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    apiVersion: STRIPE_BILLING_API_VERSION
  },
  request: async () => {
    rejectedCalls += 1;
    return { status: 500, body: JSON.stringify({ error: { message: `never expose ${SECRET_KEY} ${WEBHOOK_SECRET}` } }) };
  }
});
await rejectsCode(() => rejectingGateway.createCustomer({
  workspaceId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "customer:test:failure-0001"
}), "stripe_request_rejected");
equal(rejectedCalls, 1, "create operation was retried");
try {
  await rejectingGateway.createCustomer({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "customer:test:failure-0002"
  });
} catch (error) {
  check(!String(error).includes(SECRET_KEY), "secret key leaked through provider error");
  check(!String(error).includes(WEBHOOK_SECRET), "webhook secret leaked through provider error");
}

let timeoutCalls = 0;
const timeoutGateway = createStripeBillingGateway({
  configuration: {
    environment: "test",
    secretKey: SECRET_KEY,
    webhookSecret: WEBHOOK_SECRET,
    apiVersion: STRIPE_BILLING_API_VERSION
  },
  request: (_url, options) => new Promise((_resolve, reject) => {
    timeoutCalls += 1;
    options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }),
  timeoutMs: 10
});
await rejectsCode(() => timeoutGateway.createCustomer({
  workspaceId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "customer:test:timeout-0001"
}), "stripe_request_timeout");
equal(timeoutCalls, 1);

const event = {
  id: "evt_synthetic000001",
  type: "checkout.session.completed",
  created: Math.floor(NOW / 1000),
  livemode: false,
  data: { object: { id: "cs_test_synthetic000001" } }
};
const rawBody = new TextEncoder().encode(JSON.stringify(event));
const timestamp = String(Math.floor(NOW / 1000));
const signature = crypto.createHmac("sha256", WEBHOOK_SECRET)
  .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]))
  .digest("hex");
const verified = await gateway.verifyWebhookEvent({
  rawBody,
  signatureHeader: `t=${timestamp},v1=${signature}`,
  webhookSecret: WEBHOOK_SECRET,
  environment: "test"
});
equal(verified.id, event.id);
equal(verified.type, event.type);

await rejectsCode(() => gateway.verifyWebhookEvent({
  rawBody: "not bytes",
  signatureHeader: `t=${timestamp},v1=${signature}`,
  webhookSecret: WEBHOOK_SECRET,
  environment: "test"
}), "webhook_raw_bytes_required");
await rejectsCode(() => gateway.verifyWebhookEvent({
  rawBody,
  signatureHeader: `t=${timestamp},v1=${"0".repeat(64)}`,
  webhookSecret: WEBHOOK_SECRET,
  environment: "test"
}), "webhook_signature_invalid");
await rejectsCode(() => gateway.verifyWebhookEvent({
  rawBody,
  signatureHeader: `t=${Math.floor(NOW / 1000) - 301},v1=${signature}`,
  webhookSecret: WEBHOOK_SECRET,
  environment: "test"
}), "webhook_signature_timestamp_invalid");
await rejectsCode(() => gateway.verifyWebhookEvent({
  rawBody,
  signatureHeader: `t=${timestamp},t=${timestamp},v1=${signature}`,
  webhookSecret: WEBHOOK_SECRET,
  environment: "test"
}), "webhook_signature_duplicate_timestamp");
await rejectsCode(() => gateway.verifyWebhookEvent({
  rawBody,
  signatureHeader: `t=${timestamp},v1=${signature},v1=${signature}`,
  webhookSecret: WEBHOOK_SECRET,
  environment: "test"
}), "webhook_signature_duplicate");

const malformedRaw = new TextEncoder().encode("not-json");
await rejectsCode(() => gateway.verifyWebhookEvent({
  rawBody: malformedRaw,
  signatureHeader: `t=${timestamp},v1=${"0".repeat(64)}`,
  webhookSecret: WEBHOOK_SECRET,
  environment: "test"
}), "webhook_signature_invalid");

equal(globalFetchCalls, 0, "gateway called global fetch");
globalThis.fetch = originalFetch;
const serializedResults = JSON.stringify({ customer, checkout, portal, subscription, verified: { id: verified.id, type: verified.type } });
check(!serializedResults.includes(SECRET_KEY), "gateway result leaked secret key");
check(!serializedResults.includes(WEBHOOK_SECRET), "gateway result leaked webhook secret");
check(!serializedResults.includes(signature), "gateway result leaked webhook signature");

console.log(JSON.stringify({
  ok: true,
  suite: "stripe-billing-gateway",
  checks,
  injectedTransportCalls: calls.length + rejectedCalls + timeoutCalls,
  stripeRequests: 0,
  productionRequests: 0,
  globalFetchCalls,
  automaticRetries: 0,
  secretsExposed: 0
}));
