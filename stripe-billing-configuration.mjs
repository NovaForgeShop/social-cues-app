import { PRICING_CONFIGURATION, resolvePricingPlan } from "./pricing-packaging.mjs";
import {
  STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION,
  validateStripeBillingConfiguration
} from "./stripe-billing-lifecycle.mjs";

export const STRIPE_BILLING_RELEASE_STAGE = "readiness_only";
export const STRIPE_BILLING_API_VERSION = "2026-05-27.dahlia";
export const STRIPE_BILLING_SUPPORTED_PRICING_VERSION = PRICING_CONFIGURATION.version;
export const STRIPE_BILLING_CANONICAL_PLAN_IDS = Object.freeze(["business", "growth", "agency"]);
export const STRIPE_BILLING_ENVIRONMENT_NAMES = Object.freeze([
  "STRIPE_BILLING_MODE",
  "STRIPE_PRICING_CONFIGURATION_VERSION",
  "STRIPE_TEST_SECRET_KEY",
  "STRIPE_TEST_WEBHOOK_SECRET",
  "STRIPE_LIVE_SECRET_KEY",
  "STRIPE_LIVE_WEBHOOK_SECRET",
  "STRIPE_PRICE_BUSINESS_MONTHLY",
  "STRIPE_PRICE_GROWTH_MONTHLY",
  "STRIPE_PRICE_AGENCY_MONTHLY",
  "PUBLIC_APP_URL"
]);

const GENERIC_CREDENTIAL_NAMES = Object.freeze(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
const PRICE_ENV_BY_PLAN = Object.freeze({
  business: "STRIPE_PRICE_BUSINESS_MONTHLY",
  growth: "STRIPE_PRICE_GROWTH_MONTHLY",
  agency: "STRIPE_PRICE_AGENCY_MONTHLY"
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function environmentValue(environment, name) {
  const value = environment?.[name];
  return typeof value === "string" ? value.trim() : "";
}

function hasConfiguredName(environment, name) {
  return Object.prototype.hasOwnProperty.call(environment || {}, name)
    && environmentValue(environment, name) !== "";
}

function safeReadiness(state, mode, configured, reasonCode = null) {
  return deepFreeze({
    ok: state === "disabled" || state === "configured-held",
    state,
    mode,
    configured,
    releaseStage: STRIPE_BILLING_RELEASE_STAGE,
    reasonCode,
    checkoutAvailable: false,
    portalAvailable: false,
    webhookProcessingAvailable: false
  });
}

function unavailable(state, mode, reasonCode, readinessState = "configuration_invalid") {
  return deepFreeze({
    ok: false,
    state,
    readinessState,
    mode,
    releaseStage: STRIPE_BILLING_RELEASE_STAGE,
    internal: null,
    safeReadiness: safeReadiness(state, mode, false, reasonCode)
  });
}

function applicationOrigin(value, mode) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  const testLoopback = mode === "test" && loopback && parsed.protocol === "http:";
  if ((parsed.protocol !== "https:" && !testLoopback)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) return null;
  return { origin: parsed.origin, allowHttpLoopbackForTests: testLoopback };
}

function secretKeyValid(value, mode) {
  return new RegExp(`^sk_${mode}_[A-Za-z0-9]{8,}$`, "u").test(value);
}

function webhookSecretValid(value) {
  return /^whsec_[A-Za-z0-9]{8,}$/u.test(value) && value.length >= 16 && value.length <= 255;
}

function priceIdValid(value) {
  return /^price_[A-Za-z0-9]{6,246}$/u.test(value);
}

export function resolveStripeBillingConfiguration(environment = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    return unavailable("misconfigured", "disabled", "environment_invalid");
  }

  const modeInput = environmentValue(environment, "STRIPE_BILLING_MODE").toLowerCase();
  const mode = modeInput || "disabled";
  if (!["disabled", "test", "live"].includes(mode)) {
    return unavailable("unsupported", "disabled", "mode_unsupported");
  }
  if (GENERIC_CREDENTIAL_NAMES.some(name => hasConfiguredName(environment, name))) {
    return unavailable("unsupported", mode, "legacy_credentials_unsupported");
  }
  if (mode === "disabled") {
    return deepFreeze({
      ok: true,
      state: "disabled",
      mode,
      releaseStage: STRIPE_BILLING_RELEASE_STAGE,
      internal: null,
      safeReadiness: safeReadiness("disabled", mode, false)
    });
  }
  const approvedPriceNames = new Set(Object.values(PRICE_ENV_BY_PLAN));
  if (Object.keys(environment).some(name => /^STRIPE_PRICE_.+_MONTHLY$/iu.test(name) && !approvedPriceNames.has(name))) {
    return unavailable("unsupported", mode, "unknown_plan_mapping");
  }

  const secretName = mode === "test" ? "STRIPE_TEST_SECRET_KEY" : "STRIPE_LIVE_SECRET_KEY";
  const webhookName = mode === "test" ? "STRIPE_TEST_WEBHOOK_SECRET" : "STRIPE_LIVE_WEBHOOK_SECRET";
  const secretKey = environmentValue(environment, secretName);
  const webhookSecret = environmentValue(environment, webhookName);
  if (!secretKey || !webhookSecret) {
    return unavailable("misconfigured", mode, "active_credentials_missing", "configuration_supported_but_incomplete");
  }
  if (!secretKeyValid(secretKey, mode) || !webhookSecretValid(webhookSecret)) {
    return unavailable("misconfigured", mode, "active_credentials_invalid");
  }

  const pricingVersion = environmentValue(environment, "STRIPE_PRICING_CONFIGURATION_VERSION");
  if (!pricingVersion) {
    return unavailable("misconfigured", mode, "pricing_version_missing", "configuration_supported_but_incomplete");
  }
  if (pricingVersion !== STRIPE_BILLING_SUPPORTED_PRICING_VERSION) {
    return unavailable("misconfigured", mode, "pricing_version_mismatch");
  }

  const priceIdsByPlan = {};
  for (const planId of STRIPE_BILLING_CANONICAL_PLAN_IDS) {
    const priceId = environmentValue(environment, PRICE_ENV_BY_PLAN[planId]);
    if (!priceId) return unavailable("misconfigured", mode, "canonical_price_missing", "configuration_supported_but_incomplete");
    if (!priceIdValid(priceId)) return unavailable("misconfigured", mode, "canonical_price_invalid");
    priceIdsByPlan[planId] = priceId;
  }
  if (new Set(Object.values(priceIdsByPlan)).size !== STRIPE_BILLING_CANONICAL_PLAN_IDS.length) {
    return unavailable("misconfigured", mode, "canonical_price_duplicate");
  }

  const origin = applicationOrigin(environmentValue(environment, "PUBLIC_APP_URL"), mode);
  if (!origin) return unavailable("misconfigured", mode, "application_origin_invalid");

  const lifecycleConfiguration = {
    version: STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION,
    pricingVersion,
    environment: mode,
    secretKeyPresent: true,
    webhookSecret,
    priceIdsByPlan,
    applicationOrigin: origin.origin,
    allowHttpLoopbackForTests: origin.allowHttpLoopbackForTests,
    webhookClaimStaleAfterSeconds: 300
  };
  try {
    validateStripeBillingConfiguration(lifecycleConfiguration, {
      version: PRICING_CONFIGURATION.version,
      resolvePlan: resolvePricingPlan
    });
  } catch {
    return unavailable("misconfigured", mode, "lifecycle_configuration_invalid");
  }

  return deepFreeze({
    ok: true,
    state: "configured-held",
    mode,
    releaseStage: STRIPE_BILLING_RELEASE_STAGE,
    internal: {
      lifecycleConfiguration,
      gatewayConfiguration: {
        environment: mode,
        secretKey,
        webhookSecret,
        apiVersion: STRIPE_BILLING_API_VERSION
      }
    },
    safeReadiness: safeReadiness("configured-held", mode, true)
  });
}
