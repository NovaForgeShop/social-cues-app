import assert from "node:assert/strict";
import {
  STRIPE_BILLING_API_VERSION,
  STRIPE_ALPHA_DISCOUNT_READINESS,
  STRIPE_BILLING_CANONICAL_PLAN_IDS,
  STRIPE_BILLING_RELEASE_STAGE,
  STRIPE_BILLING_SUPPORTED_PRICING_VERSION,
  resolveStripeBillingConfiguration
} from "./stripe-billing-configuration.mjs";

let checks = 0;
function check(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}

const synthetic = Object.freeze({
  testSecret: ["sk", "test", "synthetic00000001"].join("_"),
  liveSecret: ["sk", "live", "synthetic00000001"].join("_"),
  webhook: ["whsec", "synthetic00000001"].join("_"),
  business: "price_business000001",
  growth: "price_growth0000001",
  agency: "price_agency0000001"
});

function validEnvironment(mode = "test") {
  return {
    STRIPE_BILLING_MODE: mode,
    STRIPE_PRICING_CONFIGURATION_VERSION: STRIPE_BILLING_SUPPORTED_PRICING_VERSION,
    [mode === "test" ? "STRIPE_TEST_SECRET_KEY" : "STRIPE_LIVE_SECRET_KEY"]: mode === "test" ? synthetic.testSecret : synthetic.liveSecret,
    [mode === "test" ? "STRIPE_TEST_WEBHOOK_SECRET" : "STRIPE_LIVE_WEBHOOK_SECRET"]: synthetic.webhook,
    STRIPE_PRICE_BUSINESS_MONTHLY: synthetic.business,
    STRIPE_PRICE_GROWTH_MONTHLY: synthetic.growth,
    STRIPE_PRICE_AGENCY_MONTHLY: synthetic.agency,
    PUBLIC_APP_URL: mode === "test" ? "http://127.0.0.1:4177" : "https://socialcuesapp.com"
  };
}

function safeSerialized(result) {
  return JSON.stringify(result.safeReadiness);
}

const disabled = resolveStripeBillingConfiguration({ STRIPE_BILLING_MODE: "disabled" });
equal(disabled.state, "disabled");
equal(disabled.internal, null);
equal(disabled.safeReadiness.releaseStage, STRIPE_BILLING_RELEASE_STAGE);
equal(disabled.safeReadiness.checkoutAvailable, false);
equal(disabled.safeReadiness.portalAvailable, false);
equal(disabled.safeReadiness.webhookProcessingAvailable, false);
assert.deepEqual(disabled.safeReadiness.alphaDiscount, STRIPE_ALPHA_DISCOUNT_READINESS);
checks += 1;
equal(STRIPE_ALPHA_DISCOUNT_READINESS.label, "Alpha discount: 20% off forever");
equal(STRIPE_ALPHA_DISCOUNT_READINESS.percentOff, 20);
equal(STRIPE_ALPHA_DISCOUNT_READINESS.duration, "forever");
assert.deepEqual(STRIPE_ALPHA_DISCOUNT_READINESS.applicablePlanIds, ["business", "growth", "agency"]);
checks += 1;
equal(STRIPE_ALPHA_DISCOUNT_READINESS.eligibilityAuthority, "social_cues_account");
equal(STRIPE_ALPHA_DISCOUNT_READINESS.requiresDurableAccountEligibility, true);
equal(STRIPE_ALPHA_DISCOUNT_READINESS.stripeMapping, "coupon_or_promotion_code");
equal(STRIPE_ALPHA_DISCOUNT_READINESS.stripeObjectConfigured, false);
equal(STRIPE_ALPHA_DISCOUNT_READINESS.mutationAvailable, false);

for (const mode of ["test", "live"]) {
  const result = resolveStripeBillingConfiguration(validEnvironment(mode));
  equal(result.state, "configured-held", `${mode} should be configured and held`);
  equal(result.mode, mode);
  equal(result.internal.lifecycleConfiguration.environment, mode);
  equal(result.internal.lifecycleConfiguration.pricingVersion, STRIPE_BILLING_SUPPORTED_PRICING_VERSION);
  equal(result.internal.gatewayConfiguration.apiVersion, STRIPE_BILLING_API_VERSION);
  equal(result.safeReadiness.configured, true);
  equal(result.safeReadiness.releaseStage, "readiness_only");
  assert.deepEqual(result.safeReadiness.alphaDiscount, STRIPE_ALPHA_DISCOUNT_READINESS);
  checks += 1;
  assert.deepEqual(Object.keys(result.internal.lifecycleConfiguration.priceIdsByPlan).sort(), [...STRIPE_BILLING_CANONICAL_PLAN_IDS].sort());
  checks += 1;
  const safe = safeSerialized(result);
  for (const secret of Object.values(synthetic)) {
    check(!safe.includes(secret), `safe ${mode} readiness leaked configuration data`);
  }
}

const inactiveTestEnvironment = validEnvironment("test");
Object.defineProperty(inactiveTestEnvironment, "STRIPE_LIVE_SECRET_KEY", {
  enumerable: true,
  get() { throw new Error("inactive live secret was read"); }
});
Object.defineProperty(inactiveTestEnvironment, "STRIPE_LIVE_WEBHOOK_SECRET", {
  enumerable: true,
  get() { throw new Error("inactive live webhook secret was read"); }
});
equal(resolveStripeBillingConfiguration(inactiveTestEnvironment).state, "configured-held");

const inactiveLiveEnvironment = validEnvironment("live");
Object.defineProperty(inactiveLiveEnvironment, "STRIPE_TEST_SECRET_KEY", {
  enumerable: true,
  get() { throw new Error("inactive test secret was read"); }
});
Object.defineProperty(inactiveLiveEnvironment, "STRIPE_TEST_WEBHOOK_SECRET", {
  enumerable: true,
  get() { throw new Error("inactive test webhook secret was read"); }
});
equal(resolveStripeBillingConfiguration(inactiveLiveEnvironment).state, "configured-held");

for (const name of [
  "STRIPE_TEST_SECRET_KEY",
  "STRIPE_TEST_WEBHOOK_SECRET",
  "STRIPE_PRICING_CONFIGURATION_VERSION",
  "STRIPE_PRICE_BUSINESS_MONTHLY",
  "STRIPE_PRICE_GROWTH_MONTHLY",
  "STRIPE_PRICE_AGENCY_MONTHLY"
]) {
  const environment = validEnvironment("test");
  delete environment[name];
  const result = resolveStripeBillingConfiguration(environment);
  equal(result.state, "misconfigured", `${name} absence must fail closed`);
  equal(result.readinessState, "configuration_supported_but_incomplete");
}

const mismatchedVersion = validEnvironment("test");
mismatchedVersion.STRIPE_PRICING_CONFIGURATION_VERSION = "2099-01-01";
equal(resolveStripeBillingConfiguration(mismatchedVersion).safeReadiness.reasonCode, "pricing_version_mismatch");

for (const duplicate of ["STRIPE_PRICE_GROWTH_MONTHLY", "STRIPE_PRICE_AGENCY_MONTHLY"]) {
  const environment = validEnvironment("test");
  environment[duplicate] = environment.STRIPE_PRICE_BUSINESS_MONTHLY;
  equal(resolveStripeBillingConfiguration(environment).safeReadiness.reasonCode, "canonical_price_duplicate");
}

const genericSecret = validEnvironment("test");
genericSecret.STRIPE_SECRET_KEY = "unsupported";
equal(resolveStripeBillingConfiguration(genericSecret).state, "unsupported");
equal(resolveStripeBillingConfiguration(genericSecret).safeReadiness.reasonCode, "legacy_credentials_unsupported");

const genericWebhook = validEnvironment("test");
genericWebhook.STRIPE_WEBHOOK_SECRET = "unsupported";
equal(resolveStripeBillingConfiguration(genericWebhook).state, "unsupported");

const unknownPlan = validEnvironment("test");
unknownPlan.STRIPE_PRICE_ENTERPRISE_MONTHLY = "price_enterprise0001";
equal(resolveStripeBillingConfiguration(unknownPlan).safeReadiness.reasonCode, "unknown_plan_mapping");

for (const origin of ["", "not-a-url", "ftp://127.0.0.1", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?x=1"] ) {
  const environment = validEnvironment("test");
  environment.PUBLIC_APP_URL = origin;
  equal(resolveStripeBillingConfiguration(environment).safeReadiness.reasonCode, "application_origin_invalid");
}

const liveHttp = validEnvironment("live");
liveHttp.PUBLIC_APP_URL = "http://127.0.0.1:4177";
equal(resolveStripeBillingConfiguration(liveHttp).safeReadiness.reasonCode, "application_origin_invalid");

for (const origin of ["http://127.0.0.1:4177", "http://localhost:4177", "http://[::1]:4177"]) {
  const environment = validEnvironment("test");
  environment.PUBLIC_APP_URL = origin;
  equal(resolveStripeBillingConfiguration(environment).state, "configured-held");
}

const nonLoopbackHttp = validEnvironment("test");
nonLoopbackHttp.PUBLIC_APP_URL = "http://example.com";
equal(resolveStripeBillingConfiguration(nonLoopbackHttp).safeReadiness.reasonCode, "application_origin_invalid");

const wrongTestPrefix = validEnvironment("test");
wrongTestPrefix.STRIPE_TEST_SECRET_KEY = synthetic.liveSecret;
equal(resolveStripeBillingConfiguration(wrongTestPrefix).safeReadiness.reasonCode, "active_credentials_invalid");

const unknownMode = resolveStripeBillingConfiguration({ STRIPE_BILLING_MODE: "automatic" });
equal(unknownMode.state, "unsupported");
equal(unknownMode.safeReadiness.releaseStage, "readiness_only");

console.log(JSON.stringify({
  ok: true,
  suite: "stripe-billing-configuration",
  checks,
  modes: ["disabled", "test", "live"],
  releaseStage: STRIPE_BILLING_RELEASE_STAGE,
  secretsExposed: 0,
  providerRequests: 0,
  productionRequests: 0
}));
