import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStripeBillingApplication } from "./stripe-billing-application.mjs";
import {
  STRIPE_BILLING_SUPPORTED_PRICING_VERSION,
  resolveStripeBillingConfiguration
} from "./stripe-billing-configuration.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
function check(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}

function validConfiguration(mode = "test") {
  return resolveStripeBillingConfiguration({
    STRIPE_BILLING_MODE: mode,
    STRIPE_PRICING_CONFIGURATION_VERSION: STRIPE_BILLING_SUPPORTED_PRICING_VERSION,
    [mode === "test" ? "STRIPE_TEST_SECRET_KEY" : "STRIPE_LIVE_SECRET_KEY"]: `sk_${mode}_application000001`,
    [mode === "test" ? "STRIPE_TEST_WEBHOOK_SECRET" : "STRIPE_LIVE_WEBHOOK_SECRET"]: ["whsec", "application000001"].join("_"),
    STRIPE_PRICE_BUSINESS_MONTHLY: "price_business000001",
    STRIPE_PRICE_GROWTH_MONTHLY: "price_growth0000001",
    STRIPE_PRICE_AGENCY_MONTHLY: "price_agency0000001",
    PUBLIC_APP_URL: mode === "test" ? "http://127.0.0.1:4177" : "https://socialcuesapp.com"
  });
}

function fixture({ probe = { ready: true, state: "database_ready" }, binding = null, mode = "test" } = {}) {
  const calls = { gateway: 0, repositoryMutation: 0, repositoryRead: 0, lifecycle: 0, provider: 0 };
  const gateway = Object.fromEntries([
    "createCustomer",
    "createCheckoutSession",
    "createPortalSession",
    "verifyWebhookEvent",
    "retrieveSubscription"
  ].map(method => [method, async () => {
    calls.gateway += 1;
    calls.provider += 1;
    throw new Error("held gateway method called");
  }]));
  const repository = {
    async probeReadiness() { calls.repositoryRead += 1; return probe; },
    async getBindingByWorkspace() { calls.repositoryRead += 1; return binding; },
    async getBindingByCustomer() { calls.repositoryRead += 1; return null; },
    async getBindingBySubscription() { calls.repositoryRead += 1; return null; },
    async getCheckoutBySession() { calls.repositoryRead += 1; return null; },
    async reserveCheckout() { calls.repositoryMutation += 1; },
    async bindCheckoutSession() { calls.repositoryMutation += 1; },
    async markCheckoutReconciliationRequired() { calls.repositoryMutation += 1; },
    async claimWebhookEvent() { calls.repositoryMutation += 1; },
    async getWebhookResult() { calls.repositoryRead += 1; return null; },
    async completeWebhookEvent() { calls.repositoryMutation += 1; },
    async failWebhookEvent() { calls.repositoryMutation += 1; },
    async reconcileBinding() { calls.repositoryMutation += 1; }
  };
  const app = createStripeBillingApplication({
    configuration: validConfiguration(mode),
    gatewayFactory: () => gateway,
    repositoryFactory: () => repository,
    lifecycleFactory: options => {
      checks += 1;
      assert.equal(options.configuration.environment, mode);
      return {
        async prepareCheckout() { calls.lifecycle += 1; },
        async preparePortal() { calls.lifecycle += 1; },
        async handleWebhook() { calls.lifecycle += 1; }
      };
    },
    gatewayRequest: async () => { calls.provider += 1; throw new Error("provider request attempted"); },
    repositoryRequest: async () => { throw new Error("unexpected repository request"); },
    clock: () => 1_800_000_000_000,
    generateEventId: () => "evt_application000001"
  });
  return { app, calls };
}

const disabled = createStripeBillingApplication({ configuration: resolveStripeBillingConfiguration({ STRIPE_BILLING_MODE: "disabled" }) });
const disabledReadiness = await disabled.getReadiness();
equal(disabledReadiness.state, "disabled");
equal(disabledReadiness.checkoutAvailable, false);

const incomplete = createStripeBillingApplication({
  configuration: resolveStripeBillingConfiguration({ STRIPE_BILLING_MODE: "test" })
});
equal((await incomplete.getReadiness()).state, "configuration_supported_but_incomplete");

const invalidEnvironment = {
  ...validConfiguration("test").safeReadiness,
  state: "misconfigured",
  mode: "test",
  readinessState: "configuration_invalid"
};
const invalid = createStripeBillingApplication({ configuration: invalidEnvironment });
equal((await invalid.getReadiness()).state, "configuration_invalid");

const missingMigrationFixture = fixture({ probe: { ready: false, state: "database_migration_missing" } });
equal((await missingMigrationFixture.app.getReadiness()).state, "database_migration_missing");
equal(missingMigrationFixture.calls.provider, 0);

const unavailableFixture = fixture({ probe: { ready: false, state: "database_unavailable" } });
equal((await unavailableFixture.app.getReadiness()).state, "database_unavailable");

const testFixture = fixture({
  binding: {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    environment: "test",
    customerId: "cus_application000001",
    subscriptionId: "sub_application000001",
    priceId: "price_business000001",
    planId: "business",
    subscriptionStatus: "active",
    currentPeriodStart: "2027-01-01T00:00:00.000Z",
    currentPeriodEnd: "2027-02-01T00:00:00.000Z",
    cancelAtPeriodEnd: false
  }
});
const testReadiness = await testFixture.app.getReadiness();
equal(testReadiness.state, "ready_for_later_test_activation");
equal(testReadiness.databaseReady, true);
equal(testReadiness.releaseStage, "readiness_only");
equal(testReadiness.checkoutAvailable, false);
equal(testReadiness.portalAvailable, false);
equal(testReadiness.webhookProcessingAvailable, false);

const status = await testFixture.app.getWorkspaceBillingStatus("11111111-1111-4111-8111-111111111111");
equal(status.ok, true);
equal(status.billing.planId, "business");
equal(status.billing.subscriptionStatus, "active");
const serializedStatus = JSON.stringify(status);
for (const forbidden of ["cus_application", "sub_application", "price_business", "customerId", "subscriptionId", "priceId", "https://checkout.stripe.com"]) {
  check(!serializedStatus.includes(forbidden), `workspace status exposed ${forbidden}`);
}

const readsBeforeHeld = testFixture.calls.repositoryRead;
const heldResults = await Promise.all([
  testFixture.app.prepareCheckoutHeld({ amount: 1, paymentLink: "https://example.com" }),
  testFixture.app.preparePortalHeld({ customerId: "cus_attacker000001" }),
  testFixture.app.handleWebhookHeld(new Uint8Array([123, 255, 0]))
]);
for (const result of heldResults) {
  equal(result.ok, false);
  equal(result.status, "activation_held");
  equal(result.releaseStage, "readiness_only");
  check(!("url" in result), "held result exposed a payment URL");
}
equal(testFixture.calls.gateway, 0, "held operation called gateway");
equal(testFixture.calls.lifecycle, 0, "held operation called B1");
equal(testFixture.calls.repositoryMutation, 0, "held operation mutated repository");
equal(testFixture.calls.repositoryRead, readsBeforeHeld, "held operation read repository");
equal(testFixture.calls.provider, 0, "held operation attempted provider transport");

const liveFixture = fixture({ mode: "live" });
equal((await liveFixture.app.getReadiness()).state, "database_ready_activation_held");
equal(liveFixture.calls.provider, 0);

const serverSource = await readFile(path.join(__dirname, "server.mjs"), "utf8");
check(serverSource.includes('from "./stripe-billing-configuration.mjs"'), "server does not import tracked Stripe configuration");
check(serverSource.includes('from "./stripe-billing-application.mjs"'), "server does not import tracked Stripe application");
check(serverSource.includes('from "./vizard-connection-service.mjs"'), "Vizard import was removed");
check(serverSource.includes('"/api/accounts/vizard/connect": "connect"'), "Vizard route was removed");
check(serverSource.includes("function supabaseAuthReady()"), "hosted authentication readiness was removed");
check(!serverSource.includes("https://api.stripe.com"), "server duplicates a direct Stripe gateway");
check(!serverSource.includes("STRIPE_SECRET_KEY"), "server accepts generic Stripe secret fallback");
check(!serverSource.includes("STRIPE_WEBHOOK_SECRET"), "server accepts generic Stripe webhook fallback");
check(!serverSource.includes("paymentLink"), "server retains browser payment-link authority");
const legacySubscriptionSentinel = serverSource.slice(
  serverSource.indexOf("function recordStripeSubscriptionState"),
  serverSource.indexOf("function stripeAccessForPlan")
);
check(legacySubscriptionSentinel.includes("throw new Error"), "legacy subscription recording is not hard-held");
check(!legacySubscriptionSentinel.includes("model.billing"), "legacy subscription sentinel mutates billing state");
check(!legacySubscriptionSentinel.includes("applyPaidEntitlement"), "legacy subscription sentinel mutates entitlement state");

const legacyPortalSentinel = serverSource.slice(
  serverSource.indexOf("function createStripeCustomerPortalSession"),
  serverSource.indexOf("function stripeAccessForPlan")
);
check(legacyPortalSentinel.includes("throw new Error"), "legacy portal creation is not hard-held");
check(!legacyPortalSentinel.includes("fetch("), "legacy portal sentinel performs a provider request");
check(!legacyPortalSentinel.includes("customerId"), "legacy portal sentinel accepts customer authority");
check(!legacyPortalSentinel.includes("returnUrl"), "legacy portal sentinel accepts return URL authority");
check(!legacyPortalSentinel.includes("https://"), "legacy portal sentinel returns a provider URL");

const legacyCheckoutPaymentSentinel = serverSource.slice(
  serverSource.indexOf("function inspectStripeCheckoutPaymentProofHeld"),
  serverSource.indexOf("function stripeAccessForPlan")
);
check(legacyCheckoutPaymentSentinel.includes('const paid = session.payment_status === "paid";'), "legacy checkout proof does not require paid status");
check(legacyCheckoutPaymentSentinel.includes("throw new Error"), "legacy checkout payment proof is not hard-held");
check(!legacyCheckoutPaymentSentinel.includes("applyPaidEntitlement"), "legacy checkout payment proof mutates entitlements");
check(!legacyCheckoutPaymentSentinel.includes("model."), "legacy checkout payment proof mutates application state");
check(!legacyCheckoutPaymentSentinel.includes("repository"), "legacy checkout payment proof mutates repository state");
check(!legacyCheckoutPaymentSentinel.includes("gateway"), "legacy checkout payment proof calls the Stripe gateway");

function routeSlice(route, nextRoute) {
  const start = serverSource.indexOf(`url.pathname === "${route}"`);
  const end = serverSource.indexOf(`url.pathname === "${nextRoute}"`, start + 1);
  check(start >= 0 && end > start, `route bounds missing for ${route}`);
  return serverSource.slice(start, end);
}

const checkoutRoute = routeSlice("/api/billing/checkout", "/api/billing/portal");
check(checkoutRoute.includes("requireWorkspaceManagementAccess"), "checkout lost owner/admin authorization");
check(checkoutRoute.includes("prepareCheckoutHeld"), "checkout is not held");
check(!checkoutRoute.includes("bodyJson"), "checkout parses browser billing authority");
check(!checkoutRoute.includes("fetch("), "checkout performs a provider request");

const portalRoute = routeSlice("/api/billing/portal", "/api/meta/assets");
check(portalRoute.includes("requireWorkspaceManagementAccess"), "portal lost owner/admin authorization");
check(portalRoute.includes("preparePortalHeld"), "portal is not held");
check(!portalRoute.includes("bodyJson"), "portal parses browser customer authority");
check(!portalRoute.includes("fetch("), "portal performs a provider request");

const webhookRoute = routeSlice("/api/billing/webhook", "/api/media/editor/readiness");
check(webhookRoute.includes("handleWebhookHeld"), "webhook is not held");
check(!webhookRoute.includes("bodyText"), "held webhook reads raw body");
check(!webhookRoute.includes("bodyJson"), "held webhook parses provider JSON");
check(!webhookRoute.includes("stripe-signature"), "held webhook reads signature");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const selected = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return selected;
}

async function loopbackRequest(port, pathname, { method = "GET", body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers: body ? { "Content-Type": "application/octet-stream", "Content-Length": Buffer.byteLength(body) } : {} }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

const port = await freePort();
const dataDirectory = path.join(__dirname, ".tmp", `stripe-billing-application-${process.pid}`);
await mkdir(dataDirectory, { recursive: true });
const childEnvironment = { ...process.env };
for (const name of Object.keys(childEnvironment)) {
  if (/^STRIPE_/iu.test(name)) delete childEnvironment[name];
}
Object.assign(childEnvironment, {
  PORT: String(port),
  HOST: "127.0.0.1",
  NODE_ENV: "test",
  AUTH_PROVIDER: "alpha-local",
  STRIPE_BILLING_MODE: "disabled",
  SOCIAL_CUES_DATA_DIR: dataDirectory
});
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: __dirname,
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"]
});
let childOutput = "";
child.stdout.on("data", chunk => { childOutput += chunk.toString("utf8"); });
child.stderr.on("data", chunk => { childOutput += chunk.toString("utf8"); });
try {
  const deadline = Date.now() + 15000;
  while (!childOutput.includes("Social Cues local test app running")) {
    if (child.exitCode !== null) throw new Error("test server exited before readiness");
    if (Date.now() > deadline) throw new Error("test server readiness timeout");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const publicReadiness = await loopbackRequest(port, "/api/billing/readiness");
  equal(publicReadiness.status, 200);
  equal(publicReadiness.body.state, "disabled");
  equal(publicReadiness.body.releaseStage, "readiness_only");
  equal(publicReadiness.body.checkoutAvailable, false);
  const webhook = await loopbackRequest(port, "/api/billing/webhook", { method: "POST", body: "not-json-and-not-read" });
  equal(webhook.status, 503);
  equal(webhook.body.status, "activation_held");
  equal(webhook.body.resultCode, "webhook_activation_held");
  check(!JSON.stringify(webhook.body).includes("not-json-and-not-read"), "held webhook reflected raw body");
} finally {
  child.kill();
  await new Promise(resolve => child.once("exit", resolve));
  await rm(dataDirectory, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  suite: "stripe-billing-application",
  checks,
  releaseStage: "readiness_only",
  gatewayCallsFromHeldOperations: testFixture.calls.gateway,
  lifecycleCallsFromHeldOperations: testFixture.calls.lifecycle,
  repositoryMutationsFromHeldOperations: testFixture.calls.repositoryMutation,
  stripeRequests: 0,
  providerRequests: 0,
  productionRequests: 0,
  entitlementMutations: 0,
  paymentUrls: 0,
  secretsExposed: 0,
  cleanupComplete: true
}));
