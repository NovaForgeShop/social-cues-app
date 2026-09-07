import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPORT_SCHEMA = "social-cues.alpha-public-smoke.v1";
const RELEASE_SCHEMA = "social-cues.release-readiness.v1";
const PRICING_SCHEMA = "social-cues.pricing-presentation.v1";
const DEFAULT_BASE_URL = "https://socialcuesapp.com";
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;
const BILLING_NON_OPERATIONAL_STATES = new Set([
  "disabled",
  "configuration_supported_but_incomplete",
  "configuration_invalid",
  "database_migration_missing",
  "database_unavailable",
  "database_ready_activation_held"
]);
const BILLING_PRODUCTION_MODES = new Set(["disabled", "live"]);

const EXPECTED_RELEASE_GATES = Object.freeze({
  hostedPersistence: Object.freeze({ review: "R4", status: "HOLD" }),
  externalUserContent: "HOLD",
  billingReleaseStage: "readiness_only",
  providers: "DEFERRED"
});

const REMAINING_NON_PUBLIC_GATES = Object.freeze([
  Object.freeze({ name: "hosted_persistence", status: "HOLD", review: "R4" }),
  Object.freeze({ name: "external_user_content", status: "HOLD" }),
  Object.freeze({ name: "billing", status: "READINESS_ONLY" }),
  Object.freeze({ name: "providers", status: "DEFERRED" })
]);

const CHECK_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "health", pathname: "/health", validate: validateHealth }),
  Object.freeze({ name: "release_readiness", pathname: "/api/release/readiness", validate: validateReleaseReadiness }),
  Object.freeze({ name: "auth_readiness", pathname: "/api/auth/readiness", validate: validateAuthReadiness }),
  Object.freeze({ name: "smtp_readiness", pathname: "/api/auth/smtp/readiness", validate: validateSmtpReadiness }),
  Object.freeze({ name: "billing_readiness", pathname: "/api/billing/readiness", validate: validateBillingReadiness }),
  Object.freeze({ name: "pricing", pathname: "/api/pricing", validate: validatePricing }),
  Object.freeze({ name: "anonymous_model_denial", pathname: "/api/model", validate: validateHostedAnonymousDenial }),
  Object.freeze({ name: "anonymous_monitoring_denial", pathname: "/api/monitoring/status", validate: validateHostedAnonymousDenial }),
  Object.freeze({ name: "anonymous_worker_denial", pathname: "/api/cron/workers", validate: validateWorkerDenial })
]);

class SmokeConfigurationError extends Error {
  constructor(resultCode) {
    super(resultCode);
    this.name = "SmokeConfigurationError";
    this.resultCode = resultCode;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function normalizedCommit(value) {
  return typeof value === "string" && COMMIT_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function boundedRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : null;
}

function normalizeBaseOrigin(value) {
  if (typeof value !== "string" || !value || value.length > 2_048) {
    throw new SmokeConfigurationError("base_url_invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SmokeConfigurationError("base_url_invalid");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new SmokeConfigurationError("base_url_invalid");
  }
  return parsed.origin;
}

function flagValue(argv, index, name) {
  const argument = argv[index];
  if (argument === name) {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new SmokeConfigurationError("argument_value_missing");
    }
    return { value, consumed: 2 };
  }
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length);
    if (!value) throw new SmokeConfigurationError("argument_value_missing");
    return { value, consumed: 1 };
  }
  return null;
}

export function parseAlphaSmokeArguments(argv = []) {
  let baseUrl = DEFAULT_BASE_URL;
  let expectedCommit = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const seen = new Set();

  for (let index = 0; index < argv.length;) {
    let parsed = null;
    let name = "";
    for (const candidate of ["--base-url", "--expected-commit", "--timeout-ms"]) {
      parsed = flagValue(argv, index, candidate);
      if (parsed) {
        name = candidate;
        break;
      }
    }
    if (!parsed) throw new SmokeConfigurationError("argument_unknown");
    if (seen.has(name)) throw new SmokeConfigurationError("argument_duplicate");
    seen.add(name);
    if (name === "--base-url") baseUrl = parsed.value;
    if (name === "--expected-commit") expectedCommit = parsed.value;
    if (name === "--timeout-ms") {
      if (!/^\d{1,5}$/.test(parsed.value)) throw new SmokeConfigurationError("timeout_invalid");
      timeoutMs = Number(parsed.value);
    }
    index += parsed.consumed;
  }

  const baseOrigin = normalizeBaseOrigin(baseUrl);
  const normalizedExpectedCommit = normalizedCommit(expectedCommit);
  if (!normalizedExpectedCommit) throw new SmokeConfigurationError("expected_commit_required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new SmokeConfigurationError("timeout_invalid");
  }
  return { baseOrigin, expectedCommit: normalizedExpectedCommit, timeoutMs };
}

function isoTimestamp(now) {
  const value = typeof now === "function" ? now() : new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

function emptyObservations() {
  return {
    auth: null,
    smtp: null,
    billing: null,
    pricing: null
  };
}

function configurationFailureReport(resultCode, now) {
  return {
    schema: REPORT_SCHEMA,
    timestamp: isoTimestamp(now),
    baseOrigin: null,
    expectedCommit: null,
    observedCommit: null,
    pass: false,
    checks: [{
      name: "configuration",
      status: "FAIL",
      resultCode,
      httpStatus: null,
      requestId: null
    }],
    observations: emptyObservations(),
    remainingNonPublicGates: REMAINING_NON_PUBLIC_GATES
  };
}

async function boundedResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return { ok: false, resultCode: "response_too_large" };
  }
  if (!response.body) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      return { ok: false, resultCode: "response_too_large" };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { ok: true, text };
}

async function requestJson({ baseOrigin, pathname, timeoutMs, fetchImpl }) {
  const requestUrl = new URL(pathname, `${baseOrigin}/`);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    const httpStatus = Number.isInteger(response.status) ? response.status : null;
    const requestId = boundedRequestId(response.headers.get("x-request-id"));
    if (response.status >= 300 && response.status < 400) {
      let resultCode = "unexpected_redirect";
      const location = response.headers.get("location");
      if (location) {
        try {
          if (new URL(location, requestUrl).origin !== baseOrigin) resultCode = "cross_origin_redirect";
        } catch {
          resultCode = "unexpected_redirect";
        }
      }
      await response.body?.cancel();
      return { ok: false, resultCode, httpStatus, requestId };
    }
    if (!/^application\/json\b/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel();
      return { ok: false, resultCode: "response_not_json", httpStatus, requestId };
    }
    const bounded = await boundedResponseText(response);
    if (!bounded.ok) return { ok: false, resultCode: bounded.resultCode, httpStatus, requestId };
    let body;
    try {
      body = JSON.parse(bounded.text);
    } catch {
      return { ok: false, resultCode: "malformed_json", httpStatus, requestId };
    }
    if (!isPlainObject(body)) {
      return { ok: false, resultCode: "malformed_json", httpStatus, requestId };
    }
    return { ok: true, body, httpStatus, requestId };
  } catch {
    return {
      ok: false,
      resultCode: timedOut ? "request_timeout" : "request_network_error",
      httpStatus: null,
      requestId: null
    };
  } finally {
    clearTimeout(timer);
  }
}

function pass(resultCode, observation = null, observedCommit = null) {
  return { pass: true, resultCode, observation, observedCommit };
}

function fail(resultCode, observation = null, observedCommit = null) {
  return { pass: false, resultCode, observation, observedCommit };
}

function validateHealth(response) {
  const body = response.body;
  const valid = response.httpStatus === 200
    && hasExactKeys(body, ["ok", "app", "status"])
    && body.ok === true
    && body.app === "Social Cues"
    && body.status === "healthy";
  return valid ? pass("health_contract_ok") : fail("health_contract_invalid");
}

function releaseGatesValid(gates) {
  return hasExactKeys(gates, ["hostedPersistence", "externalUserContent", "billingReleaseStage", "providers"])
    && hasExactKeys(gates.hostedPersistence, ["review", "status"])
    && gates.hostedPersistence.review === EXPECTED_RELEASE_GATES.hostedPersistence.review
    && gates.hostedPersistence.status === EXPECTED_RELEASE_GATES.hostedPersistence.status
    && gates.externalUserContent === EXPECTED_RELEASE_GATES.externalUserContent
    && gates.billingReleaseStage === EXPECTED_RELEASE_GATES.billingReleaseStage
    && gates.providers === EXPECTED_RELEASE_GATES.providers;
}

function validateReleaseReadiness(response, expectedCommit) {
  const body = response.body;
  const observedCommit = normalizedCommit(body.commitSha);
  if (
    response.httpStatus !== 200
    || !hasExactKeys(body, [
      "ok", "schema", "ready", "releaseIdentityReady", "commitSha",
      "environment", "runtime", "gates"
    ])
    || body.ok !== true
    || body.schema !== RELEASE_SCHEMA
    || body.releaseIdentityReady !== true
    || body.environment !== "production"
    || body.runtime !== "vercel"
    || !observedCommit
  ) {
    return fail("release_contract_invalid", null, observedCommit);
  }
  if (observedCommit !== expectedCommit) {
    return fail("release_commit_mismatch", null, observedCommit);
  }
  if (body.ready !== false || !releaseGatesValid(body.gates)) {
    return fail("release_hold_regression", null, observedCommit);
  }
  return pass("release_identity_and_holds_ok", null, observedCommit);
}

function validateAuthReadiness(response) {
  const body = response.body;
  const observation = {
    ready: body.ready === true,
    provider: body.provider === "supabase" ? "supabase" : null,
    alphaLocalFallback: body.alphaLocalFallback === true,
    emailVerificationRequired: body.emailVerificationRequired === true,
    passwordRecoveryReady: body.passwordRecoveryReady === true,
    loginAlertingReady: body.loginAlertingReady === true,
    rateLimitGuarded: body.rateLimitGuarded === true,
    signupMode: body.signupAccess?.mode === "invite-only" ? "invite-only" : null
  };
  const valid = response.httpStatus === 200
    && body.ok === true
    && observation.ready
    && observation.provider === "supabase"
    && observation.alphaLocalFallback === false
    && observation.emailVerificationRequired
    && observation.passwordRecoveryReady
    && observation.loginAlertingReady
    && observation.rateLimitGuarded
    && observation.signupMode === "invite-only";
  return valid
    ? pass("hosted_auth_readiness_ok", observation)
    : fail("hosted_auth_readiness_regression", observation);
}

function validateSmtpReadiness(response) {
  const body = response.body;
  const observation = { ready: body.ready === true };
  const valid = response.httpStatus === 200
    && hasExactKeys(body, ["ok", "ready"])
    && body.ok === true
    && body.ready === true;
  return valid
    ? pass("smtp_readiness_ok", observation)
    : fail("smtp_readiness_regression", observation);
}

function validateBillingReadiness(response) {
  const body = response.body;
  const acceptedState = BILLING_NON_OPERATIONAL_STATES.has(body.state);
  const acceptedMode = BILLING_PRODUCTION_MODES.has(body.mode);
  const observation = {
    state: acceptedState ? body.state : null,
    mode: acceptedMode ? body.mode : null,
    configured: body.configured === true,
    databaseReady: body.databaseReady === true,
    releaseStage: body.releaseStage === "readiness_only" ? "readiness_only" : null,
    checkoutAvailable: body.checkoutAvailable === true,
    portalAvailable: body.portalAvailable === true,
    webhookProcessingAvailable: body.webhookProcessingAvailable === true,
    ready: body.ready === true
  };
  const valid = response.httpStatus === 200
    && typeof body.ok === "boolean"
    && acceptedState
    && acceptedMode
    && typeof body.configured === "boolean"
    && typeof body.databaseReady === "boolean"
    && body.releaseStage === "readiness_only"
    && body.checkoutAvailable === false
    && body.portalAvailable === false
    && body.webhookProcessingAvailable === false
    && body.ready === false;
  return valid
    ? pass("billing_activation_unavailable_ok", observation)
    : fail("billing_readiness_regression", observation);
}

function validatePricing(response) {
  const body = response.body;
  const pricing = isPlainObject(body.pricing) ? body.pricing : {};
  const plans = Array.isArray(pricing.plans) ? pricing.plans : [];
  const planCount = Math.min(plans.length, 100);
  const checkoutUnavailable = pricing.checkout?.available === false
    && pricing.checkout?.status === "unavailable";
  const billingUnavailable = pricing.billingActivation?.available === false
    && pricing.billingActivation?.status === "unavailable";
  const planCheckoutUnavailable = plans.length > 0
    && plans.length <= 100
    && plans.every(plan => (
      isPlainObject(plan)
      && plan.checkout?.available === false
      && plan.checkout?.status === "unavailable"
    ));
  const observation = {
    status: pricing.status === "available" ? "available" : null,
    planCount,
    checkoutAvailable: pricing.checkout?.available === true,
    billingActivationAvailable: pricing.billingActivation?.available === true
  };
  const valid = response.httpStatus === 200
    && body.ok === true
    && body.schemaVersion === PRICING_SCHEMA
    && pricing.status === "available"
    && checkoutUnavailable
    && billingUnavailable
    && planCheckoutUnavailable;
  return valid
    ? pass("pricing_visible_activation_unavailable_ok", observation)
    : fail("pricing_readiness_regression", observation);
}

function validateHostedAnonymousDenial(response) {
  const body = response.body;
  const valid = response.httpStatus === 401
    && hasExactKeys(body, ["ok", "error"])
    && body.ok === false
    && body.error === "Sign in to Social Cues before using this API.";
  return valid
    ? pass("anonymous_access_denied_ok")
    : fail(response.httpStatus >= 200 && response.httpStatus < 300
      ? "protected_route_unexpected_success"
      : "protected_route_denial_regression");
}

function validateWorkerDenial(response) {
  const body = response.body;
  const valid = response.httpStatus === 401
    && hasExactKeys(body, ["ok", "error"])
    && body.ok === false
    && body.error === "Worker authorization failed.";
  return valid
    ? pass("anonymous_worker_execution_denied_ok")
    : fail(response.httpStatus >= 200 && response.httpStatus < 300
      ? "protected_route_unexpected_success"
      : "worker_denial_regression");
}

function resultForRequest(definition, response, expectedCommit) {
  if (!response.ok) {
    return {
      check: {
        name: definition.name,
        status: "FAIL",
        resultCode: response.resultCode,
        httpStatus: response.httpStatus,
        requestId: response.requestId
      },
      observation: null,
      observedCommit: null
    };
  }
  const validation = definition.validate(response, expectedCommit);
  const requestIdMissing = response.requestId === null;
  return {
    check: {
      name: definition.name,
      status: validation.pass && !requestIdMissing ? "PASS" : "FAIL",
      resultCode: requestIdMissing ? "missing_request_id" : validation.resultCode,
      httpStatus: response.httpStatus,
      requestId: response.requestId
    },
    observation: validation.observation,
    observedCommit: validation.observedCommit
  };
}

export async function runAlphaPublicSmoke(options = {}) {
  const baseOrigin = normalizeBaseOrigin(options.baseOrigin);
  const expectedCommit = normalizedCommit(options.expectedCommit);
  const timeoutMs = Number(options.timeoutMs);
  if (!expectedCommit) throw new SmokeConfigurationError("expected_commit_required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new SmokeConfigurationError("timeout_invalid");
  }
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const checks = [];
  const observations = emptyObservations();
  let observedCommit = null;

  for (const definition of CHECK_DEFINITIONS) {
    const response = await requestJson({
      baseOrigin,
      pathname: definition.pathname,
      timeoutMs,
      fetchImpl
    });
    const result = resultForRequest(definition, response, expectedCommit);
    checks.push(result.check);
    if (definition.name === "auth_readiness" && result.observation) observations.auth = result.observation;
    if (definition.name === "smtp_readiness" && result.observation) observations.smtp = result.observation;
    if (definition.name === "billing_readiness" && result.observation) observations.billing = result.observation;
    if (definition.name === "pricing" && result.observation) observations.pricing = result.observation;
    if (definition.name === "release_readiness" && result.observedCommit) observedCommit = result.observedCommit;
  }

  return {
    schema: REPORT_SCHEMA,
    timestamp: isoTimestamp(options.now),
    baseOrigin,
    expectedCommit,
    observedCommit,
    pass: checks.every(check => check.status === "PASS"),
    checks,
    observations,
    remainingNonPublicGates: REMAINING_NON_PUBLIC_GATES
  };
}

export async function executeAlphaPublicSmoke(argv = [], dependencies = {}) {
  let parsed;
  try {
    parsed = parseAlphaSmokeArguments(argv);
  } catch (error) {
    const resultCode = error instanceof SmokeConfigurationError
      ? error.resultCode
      : "configuration_invalid";
    const report = configurationFailureReport(resultCode, dependencies.now);
    return { report, exitCode: 1 };
  }
  try {
    const report = await runAlphaPublicSmoke({
      ...parsed,
      fetchImpl: dependencies.fetchImpl,
      now: dependencies.now
    });
    return { report, exitCode: report.pass ? 0 : 1 };
  } catch {
    const report = configurationFailureReport("smoke_execution_failed", dependencies.now);
    return { report, exitCode: 1 };
  }
}

function runningAsMainModule() {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === import.meta.url);
}

if (runningAsMainModule()) {
  const { report, exitCode } = await executeAlphaPublicSmoke(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCode;
}
