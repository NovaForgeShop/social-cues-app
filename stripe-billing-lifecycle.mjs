export const STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION = "stripe-billing-lifecycle-v1";

export const STRIPE_BILLING_EVENT_TYPES = Object.freeze([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed"
]);

const SUPPORTED_EVENT_TYPES = new Set(STRIPE_BILLING_EVENT_TYPES);
const CANONICAL_PLAN_IDS = Object.freeze(["business", "growth", "agency"]);
const ENVIRONMENTS = new Set(["test", "live"]);
const SUBSCRIPTION_STATUSES = new Set([
  "not_started",
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused"
]);
const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  "not_started",
  "incomplete_expired",
  "canceled",
  "unpaid"
]);
const STRIPE_SETTLEMENT_FACTS_VERSION = "stripe-entitlement-settlement.v1";
const STRIPE_SETTLEMENT_EVIDENCE = new Set([
  "authoritative_subscription_state",
  "non_authoritative_subscription_context",
  "no_subscription_evidence"
]);
const STRIPE_SETTLEMENT_FACT_KEYS = new Set([
  "version",
  "eventCreated",
  "stripeCustomerId",
  "settlementSubscriptionId",
  "evidence"
]);
const CONFIGURATION_KEYS = new Set([
  "version",
  "pricingVersion",
  "environment",
  "secretKeyPresent",
  "webhookSecret",
  "priceIdsByPlan",
  "applicationOrigin",
  "allowHttpLoopbackForTests",
  "webhookClaimStaleAfterSeconds"
]);
const CHECKOUT_REQUEST_KEYS = new Set(["planId", "idempotencyKey"]);
const PORTAL_REQUEST_KEYS = new Set(["idempotencyKey"]);
const OPERATION_KEYS = new Set(["context", "request"]);
const GATEWAY_METHODS = Object.freeze([
  "createCustomer",
  "createCheckoutSession",
  "createPortalSession",
  "verifyWebhookEvent",
  "retrieveSubscription"
]);
const REPOSITORY_METHODS = Object.freeze([
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
]);
const ERROR_DEFINITIONS = Object.freeze({
  invalid_request: Object.freeze({ status: 400, retryable: false, message: "The billing request is invalid." }),
  unauthorized_workspace: Object.freeze({ status: 403, retryable: false, message: "Workspace billing authorization is required." }),
  configuration_unavailable: Object.freeze({ status: 503, retryable: false, message: "Billing configuration is unavailable." }),
  unsupported_plan: Object.freeze({ status: 409, retryable: false, message: "The requested billing plan is unavailable." }),
  idempotency_conflict: Object.freeze({ status: 409, retryable: false, message: "The billing request conflicts with an existing request." }),
  provider_verification_failure: Object.freeze({ status: 400, retryable: false, message: "Webhook verification failed." }),
  provider_retryable_failure: Object.freeze({ status: 503, retryable: true, message: "The billing provider is temporarily unavailable." }),
  provider_terminal_failure: Object.freeze({ status: 502, retryable: false, message: "The billing provider rejected the operation." }),
  ambiguous_provider_creation: Object.freeze({ status: 503, retryable: false, message: "The billing operation requires reconciliation." }),
  ownership_mismatch: Object.freeze({ status: 409, retryable: false, message: "Billing ownership could not be verified." }),
  stale_event: Object.freeze({ status: 200, retryable: false, message: "The billing event is stale." }),
  duplicate_event: Object.freeze({ status: 200, retryable: false, message: "The billing event was already received." }),
  repository_unavailable: Object.freeze({ status: 503, retryable: true, message: "Billing persistence is temporarily unavailable." }),
  reconciliation_required: Object.freeze({ status: 409, retryable: false, message: "Billing reconciliation is required." })
});
const SAFE_RESULT_KEYS = new Set([
  "ok",
  "status",
  "resultCode",
  "classification",
  "retryable",
  "duplicate",
  "eventType",
  "environment",
  "planId",
  "subscriptionStatus",
  "currentPeriodStart",
  "currentPeriodEnd",
  "cancelAtPeriodEnd",
  "applied",
  "subscriptionReplaced",
  "entitlementActionRequired",
  "checkoutSessionId",
  "url",
  "desiredState"
]);
const SAFE_RESULT_STATUSES = new Set([
  "created",
  "reused",
  "reconciliation_required",
  "review_required",
  "no_transition",
  "stale",
  "reconciled",
  "ignored",
  "ownership_unresolved",
  "replayed",
  "in_progress"
]);
const SAFE_RESULT_CODES = new Set([
  "checkout_created",
  "checkout_reused",
  "checkout_reconciliation_required",
  "customer_creation_ambiguous",
  "checkout_creation_ambiguous",
  "create_customer_ambiguous",
  "create_checkout_session_ambiguous",
  "subscription_not_established",
  "partial_refund_requires_b2_review",
  "full_refund_requires_b2_review",
  "dispute_opened_requires_b2_review",
  "dispute_resolved_requires_b2_review",
  "dispute_lost_requires_b2_review",
  "created",
  "current_subscription_updated",
  "current_subscription_replaced",
  "current_subscription_cleared",
  "replayed_or_stale",
  "event_type_ignored",
  "durable_ownership_not_found",
  "already_complete",
  "already_claimed"
]);
const REDIRECT_PARAMETER_NAMES = new Set([
  "continue",
  "destination",
  "next",
  "redirect",
  "redirect_uri",
  "return",
  "return_to",
  "url"
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID_PATTERNS = Object.freeze({
  customerId: /^cus_[A-Za-z0-9]{6,248}$/u,
  subscriptionId: /^sub_[A-Za-z0-9]{6,248}$/u,
  checkoutSessionId: /^cs_[A-Za-z0-9_]{6,247}$/u,
  eventId: /^evt_[A-Za-z0-9]{6,248}$/u,
  priceId: /^price_[A-Za-z0-9]{6,246}$/u
});
const ID_RESULT_NAMES = Object.freeze({
  customerId: "customer_id",
  subscriptionId: "subscription_id",
  checkoutSessionId: "checkout_session_id",
  eventId: "event_id",
  priceId: "price_id"
});

class StripeBillingLifecycleError extends Error {
  constructor(classification, resultCode = classification) {
    const definition = ERROR_DEFINITIONS[classification] || ERROR_DEFINITIONS.provider_terminal_failure;
    super(definition.message);
    this.name = "StripeBillingLifecycleError";
    this.classification = classification in ERROR_DEFINITIONS ? classification : "provider_terminal_failure";
    this.code = boundedResultCode(resultCode, this.classification);
    this.status = definition.status;
    this.retryable = definition.retryable;
  }
}

function lifecycleError(classification, resultCode) {
  return new StripeBillingLifecycleError(classification, resultCode);
}

function fail(classification, resultCode) {
  throw lifecycleError(classification, resultCode);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeClone(value) {
  if (Array.isArray(value)) return value.map(safeClone);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, safeClone(child)]));
}

function boundedResultCode(value, fallback = "billing_operation_failed") {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9_]{0,79}$/u.test(normalized) ? normalized : fallback;
}

function resultCodeName(value) {
  return String(value || "operation")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
}

function requiredText(value, classification = "invalid_request", resultCode = classification, maximum = 255) {
  if (typeof value !== "string") fail(classification, resultCode);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(classification, resultCode);
  }
  return normalized;
}

function exactKeys(value, allowed, classification = "invalid_request", resultCode = classification) {
  if (!isPlainObject(value)) fail(classification, resultCode);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(classification, resultCode);
  }
  return value;
}

function environmentValue(value, classification = "configuration_unavailable") {
  if (typeof value !== "string" || !ENVIRONMENTS.has(value)) {
    fail(classification, "stripe_environment_invalid");
  }
  return value;
}

function workspaceIdValue(value, classification = "invalid_request") {
  const normalized = requiredText(value, classification, "workspace_identity_invalid").toLowerCase();
  if (!UUID_PATTERN.test(normalized)) fail(classification, "workspace_identity_invalid");
  return normalized;
}

function providerId(value, kind, classification = "provider_terminal_failure") {
  const pattern = ID_PATTERNS[kind];
  if (typeof value !== "string" || !pattern?.test(value)) {
    fail(classification, `stripe_${ID_RESULT_NAMES[kind] || "provider_id"}_invalid`);
  }
  return value;
}

function optionalProviderId(value, kind, classification = "provider_terminal_failure") {
  return value === null || value === undefined || value === "" ? null : providerId(value, kind, classification);
}

function eventCreatedValue(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    fail("provider_verification_failure", "stripe_event_created_invalid");
  }
  return normalized;
}

function configurationOrigin(value, environment, allowHttpLoopbackForTests) {
  const normalized = requiredText(value, "configuration_unavailable", "application_origin_invalid", 2048);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    fail("configuration_unavailable", "application_origin_invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  const testLoopback = environment === "test" && allowHttpLoopbackForTests === true && loopback && parsed.protocol === "http:";
  if ((parsed.protocol !== "https:" && !testLoopback)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    fail("configuration_unavailable", "application_origin_invalid");
  }
  return parsed.origin;
}

function applicationUrl(value, name, configuration) {
  const normalized = requiredText(value, "invalid_request", `${name}_invalid`, 2048);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    fail("invalid_request", `${name}_invalid`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  const testLoopback = configuration.environment === "test"
    && configuration.allowHttpLoopbackForTests
    && loopback
    && parsed.protocol === "http:";
  if ((parsed.protocol !== "https:" && !testLoopback)
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.origin !== configuration.applicationOrigin) {
    fail("invalid_request", `${name}_invalid`);
  }
  for (const [parameterName, parameterValue] of parsed.searchParams) {
    if (!REDIRECT_PARAMETER_NAMES.has(parameterName.toLowerCase())) continue;
    let destination;
    try {
      destination = new URL(parameterValue, configuration.applicationOrigin);
    } catch {
      fail("invalid_request", `${name}_invalid`);
    }
    if (destination.origin !== configuration.applicationOrigin) fail("invalid_request", `${name}_invalid`);
  }
  return parsed.toString();
}

function providerNavigationUrl(value, kind) {
  const normalized = requiredText(value, "provider_terminal_failure", `${kind}_url_invalid`, 2048);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    fail("provider_terminal_failure", `${kind}_url_invalid`);
  }
  const expectedOrigin = kind === "checkout" ? "https://checkout.stripe.com" : "https://billing.stripe.com";
  if (parsed.protocol !== "https:"
    || parsed.origin !== expectedOrigin
    || parsed.username
    || parsed.password
    || parsed.hash) {
    fail("provider_terminal_failure", `${kind}_url_invalid`);
  }
  return parsed.toString();
}

function pricingDependencies(value) {
  if (!isPlainObject(value)
    || typeof value.version !== "string"
    || !value.version.trim()
    || typeof value.resolvePlan !== "function") {
    fail("configuration_unavailable", "pricing_dependency_invalid");
  }
  return value;
}

function normalizedConfiguration(input, pricingInput) {
  exactKeys(input, CONFIGURATION_KEYS, "configuration_unavailable", "configuration_field_unknown");
  const pricing = pricingDependencies(pricingInput);
  if (input.version !== STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION) {
    fail("configuration_unavailable", "configuration_version_unsupported");
  }
  const environment = environmentValue(input.environment);
  if (input.pricingVersion !== pricing.version) {
    fail("configuration_unavailable", "pricing_configuration_version_mismatch");
  }
  if (input.secretKeyPresent !== true) fail("configuration_unavailable", "stripe_secret_key_missing");
  const webhookSecret = requiredText(
    input.webhookSecret,
    "configuration_unavailable",
    "stripe_webhook_secret_missing",
    255
  );
  if (webhookSecret.length < 16) fail("configuration_unavailable", "stripe_webhook_secret_invalid");
  if (!isPlainObject(input.priceIdsByPlan)) fail("configuration_unavailable", "stripe_price_mapping_invalid");
  const mappingKeys = Object.keys(input.priceIdsByPlan).sort();
  if (mappingKeys.join("|") !== [...CANONICAL_PLAN_IDS].sort().join("|")) {
    fail("configuration_unavailable", "stripe_price_mapping_incomplete");
  }
  const priceIdsByPlan = {};
  const seenPrices = new Set();
  for (const planId of CANONICAL_PLAN_IDS) {
    const resolved = pricing.resolvePlan(planId);
    if (!resolved?.ok || resolved.plan?.id !== planId) {
      fail("configuration_unavailable", "canonical_pricing_resolution_failed");
    }
    const priceId = providerId(input.priceIdsByPlan[planId], "priceId", "configuration_unavailable");
    if (seenPrices.has(priceId)) fail("configuration_unavailable", "stripe_price_mapping_duplicate");
    seenPrices.add(priceId);
    priceIdsByPlan[planId] = priceId;
  }
  if (input.allowHttpLoopbackForTests !== undefined && typeof input.allowHttpLoopbackForTests !== "boolean") {
    fail("configuration_unavailable", "loopback_policy_invalid");
  }
  if (environment === "live" && input.allowHttpLoopbackForTests === true) {
    fail("configuration_unavailable", "loopback_policy_invalid");
  }
  const allowHttpLoopbackForTests = input.allowHttpLoopbackForTests === true;
  const applicationOrigin = configurationOrigin(input.applicationOrigin, environment, allowHttpLoopbackForTests);
  const staleAfter = Number(input.webhookClaimStaleAfterSeconds);
  if (!Number.isInteger(staleAfter) || staleAfter < 1 || staleAfter > 3600) {
    fail("configuration_unavailable", "webhook_claim_window_invalid");
  }
  return deepFreeze({
    version: input.version,
    pricingVersion: input.pricingVersion,
    environment,
    secretKeyPresent: true,
    webhookSecret,
    priceIdsByPlan,
    applicationOrigin,
    allowHttpLoopbackForTests,
    webhookClaimStaleAfterSeconds: staleAfter
  });
}

export function validateStripeBillingConfiguration(input, pricing) {
  const configuration = normalizedConfiguration(input, pricing);
  return deepFreeze({
    ok: true,
    version: configuration.version,
    pricingVersion: configuration.pricingVersion,
    environment: configuration.environment,
    secretKeyPresent: configuration.secretKeyPresent,
    webhookSecretPresent: true,
    canonicalPlanIds: [...CANONICAL_PLAN_IDS],
    applicationOrigin: configuration.applicationOrigin,
    allowHttpLoopbackForTests: configuration.allowHttpLoopbackForTests,
    webhookClaimStaleAfterSeconds: configuration.webhookClaimStaleAfterSeconds
  });
}

export function classifyStripeBillingError(error) {
  const classification = error instanceof StripeBillingLifecycleError
    ? error.classification
    : "provider_terminal_failure";
  const definition = ERROR_DEFINITIONS[classification];
  return deepFreeze({
    ok: false,
    classification,
    resultCode: error instanceof StripeBillingLifecycleError
      ? error.code
      : "billing_operation_failed",
    status: definition.status,
    retryable: definition.retryable,
    message: definition.message
  });
}

function safeDesiredState(value) {
  if (!isPlainObject(value)) return undefined;
  if (value.kind === "no_transition") return { kind: "no_transition" };
  if (value.kind === "incident_review" && [
    "partial_refund",
    "full_refund",
    "dispute_opened",
    "dispute_resolved",
    "dispute_lost"
  ].includes(value.incident)) {
    return { kind: "incident_review", incident: value.incident };
  }
  if (value.kind !== "subscription_state"
    || !["paid", "failed", "provider_state", "unpaid", "no_payment_required"].includes(value.paymentSignal)
    || (value.planId !== null && !CANONICAL_PLAN_IDS.includes(value.planId))
    || !SUBSCRIPTION_STATUSES.has(value.subscriptionStatus)
    || typeof value.cancelAtPeriodEnd !== "boolean") return undefined;
  const currentPeriodStart = safeIsoTimestamp(value.currentPeriodStart);
  const currentPeriodEnd = safeIsoTimestamp(value.currentPeriodEnd);
  if (currentPeriodStart === undefined
    || currentPeriodEnd === undefined
    || (currentPeriodStart === null) !== (currentPeriodEnd === null)) return undefined;
  return {
    kind: "subscription_state",
    paymentSignal: value.paymentSignal,
    planId: value.planId,
    subscriptionStatus: value.subscriptionStatus,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd
  };
}

function safeIsoTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function safeNavigationUrl(value) {
  if (typeof value !== "string") return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!["https://checkout.stripe.com", "https://billing.stripe.com"].includes(parsed.origin)
    || parsed.username
    || parsed.password
    || parsed.hash) return undefined;
  return parsed.toString();
}

export function toSafeStripeBillingResult(input = {}) {
  if (!isPlainObject(input)) return deepFreeze({ ok: false, status: "invalid_result", resultCode: "billing_result_invalid" });
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_RESULT_KEYS.has(key)) continue;
    if (key === "desiredState") {
      const desiredState = safeDesiredState(value);
      if (desiredState) output.desiredState = desiredState;
      continue;
    }
    if (["ok", "retryable", "duplicate", "cancelAtPeriodEnd", "applied", "subscriptionReplaced", "entitlementActionRequired"].includes(key)) {
      if (typeof value === "boolean") output[key] = value;
    } else if (key === "status") {
      if (SAFE_RESULT_STATUSES.has(value) || [200, 400, 403, 409, 502, 503].includes(value)) output.status = value;
    } else if (key === "resultCode") {
      if (SAFE_RESULT_CODES.has(value)) output.resultCode = value;
    } else if (key === "classification") {
      if (typeof value === "string" && Object.hasOwn(ERROR_DEFINITIONS, value)) output.classification = value;
    } else if (key === "eventType") {
      if (SUPPORTED_EVENT_TYPES.has(value)) output.eventType = value;
    } else if (key === "environment") {
      if (ENVIRONMENTS.has(value)) output.environment = value;
    } else if (key === "planId") {
      if (value === null || CANONICAL_PLAN_IDS.includes(value)) output.planId = value;
    } else if (key === "subscriptionStatus") {
      if (value === null || SUBSCRIPTION_STATUSES.has(value)) output.subscriptionStatus = value;
    } else if (["currentPeriodStart", "currentPeriodEnd"].includes(key)) {
      const timestamp = safeIsoTimestamp(value);
      if (timestamp !== undefined) output[key] = timestamp;
    } else if (key === "checkoutSessionId") {
      if (typeof value === "string" && ID_PATTERNS.checkoutSessionId.test(value)) output.checkoutSessionId = value;
    } else if (key === "url") {
      const url = safeNavigationUrl(value);
      if (url) output.url = url;
    }
  }
  return deepFreeze(output);
}

function normalizedProviderEnvironment(value) {
  return environmentValue(value, "provider_terminal_failure");
}

function metadataText(metadata, key) {
  if (!isPlainObject(metadata) || typeof metadata[key] !== "string") return null;
  const normalized = metadata[key].trim();
  return normalized || null;
}

function subscriptionPriceId(object) {
  const price = object?.items?.data?.[0]?.price;
  return optionalProviderId(typeof price === "string" ? price : price?.id, "priceId");
}

function normalizedPeriod(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    fail("provider_terminal_failure", `${name}_invalid`);
  }
  return new Date(seconds * 1000).toISOString();
}

function normalizedTimestamp(value, fallbackSeconds, name) {
  if (value === null || value === undefined || value === "") return normalizedPeriod(fallbackSeconds, name);
  if (typeof value !== "string") fail("provider_terminal_failure", `${name}_invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("provider_terminal_failure", `${name}_invalid`);
  return new Date(milliseconds).toISOString();
}

export function normalizeStripeBillingEvent(eventInput, expectedEnvironment) {
  const environment = environmentValue(expectedEnvironment, "provider_verification_failure");
  if (!isPlainObject(eventInput)) fail("provider_verification_failure", "stripe_event_invalid");
  const eventId = providerId(eventInput.id, "eventId", "provider_verification_failure");
  const eventType = requiredText(eventInput.type, "provider_verification_failure", "stripe_event_type_invalid", 160);
  if (!/^[a-z0-9_.]{1,160}$/u.test(eventType)) fail("provider_verification_failure", "stripe_event_type_invalid");
  const eventCreated = eventCreatedValue(eventInput.created);
  if (eventInput.environment !== environment) {
    fail("provider_verification_failure", "stripe_event_environment_mismatch");
  }
  const object = eventInput.data?.object;
  if (!isPlainObject(object)) fail("provider_verification_failure", "stripe_event_object_invalid");
  if (object.environment !== undefined && object.environment !== environment) {
    fail("provider_verification_failure", "stripe_object_environment_mismatch");
  }
  const metadata = isPlainObject(object.metadata) ? object.metadata : {};
  const normalized = {
    eventId,
    eventType,
    eventCreated,
    environment,
    supported: SUPPORTED_EVENT_TYPES.has(eventType),
    checkoutSessionId: eventType.startsWith("checkout.session.")
      ? providerId(object.id, "checkoutSessionId")
      : null,
    customerId: optionalProviderId(
      typeof object.customer === "string" ? object.customer : object.customer?.id,
      "customerId"
    ),
    subscriptionId: optionalProviderId(
      eventType.startsWith("customer.subscription.")
        ? object.id
        : typeof object.subscription === "string"
          ? object.subscription
          : object.subscription?.id,
      "subscriptionId"
    ),
    priceId: eventType.startsWith("customer.subscription.") ? subscriptionPriceId(object) : null,
    subscriptionStatus: eventType.startsWith("customer.subscription.")
      ? requiredText(object.status, "provider_terminal_failure", "subscription_status_invalid", 40).toLowerCase()
      : null,
    currentPeriodStart: eventType.startsWith("customer.subscription.")
      ? normalizedPeriod(object.current_period_start, "current_period_start")
      : null,
    currentPeriodEnd: eventType.startsWith("customer.subscription.")
      ? normalizedPeriod(object.current_period_end, "current_period_end")
      : null,
    cancelAtPeriodEnd: eventType.startsWith("customer.subscription.") && object.cancel_at_period_end === true,
    paymentStatus: typeof object.payment_status === "string"
      && ["paid", "unpaid", "no_payment_required"].includes(object.payment_status.toLowerCase())
      ? object.payment_status.toLowerCase()
      : null,
    metadataWorkspaceId: metadataText(metadata, "social_cues_workspace_id")
      || (typeof object.client_reference_id === "string" ? object.client_reference_id.trim() || null : null),
    metadataPlanId: metadataText(metadata, "plan_id"),
    incident: null
  };
  if (eventType === "charge.refunded") {
    const amount = Number(object.amount);
    const refunded = Number(object.amount_refunded);
    normalized.incident = Number.isFinite(amount) && amount > 0 && refunded >= amount ? "full_refund" : "partial_refund";
  } else if (eventType === "charge.dispute.created") {
    normalized.incident = "dispute_opened";
  } else if (eventType === "charge.dispute.closed") {
    normalized.incident = object.status === "won" ? "dispute_resolved" : "dispute_lost";
  }
  return deepFreeze(normalized);
}

function requireMethods(value, methods, dependencyName) {
  if (!isPlainObject(value)) fail("configuration_unavailable", `${dependencyName}_invalid`);
  for (const method of methods) {
    if (typeof value[method] !== "function") fail("configuration_unavailable", `${dependencyName}_method_missing`);
  }
  return value;
}

function providerFailure(error, operation) {
  if (error instanceof StripeBillingLifecycleError) return error;
  const operationName = resultCodeName(operation);
  if (error?.ambiguous === true || error?.outcome === "ambiguous") {
    return lifecycleError("ambiguous_provider_creation", `${operationName}_ambiguous`);
  }
  if (error?.retryable === true) return lifecycleError("provider_retryable_failure", `${operationName}_retryable`);
  return lifecycleError("provider_terminal_failure", `${operationName}_failed`);
}

function repositoryFailure(error, operation) {
  if (error instanceof StripeBillingLifecycleError) return error;
  return lifecycleError("repository_unavailable", `${resultCodeName(operation)}_repository_unavailable`);
}

function trustedContext(value, requiredUrls = []) {
  if (!isPlainObject(value) || value.authorization !== "workspace_billing_manage") {
    fail("unauthorized_workspace", "workspace_billing_authorization_required");
  }
  const context = { workspaceId: workspaceIdValue(value.workspaceId, "unauthorized_workspace") };
  for (const urlName of requiredUrls) context[urlName] = value[urlName];
  return context;
}

function normalizeBinding(value, expected = {}) {
  if (!isPlainObject(value)) return null;
  const binding = {
    workspaceId: workspaceIdValue(value.workspaceId, "repository_unavailable"),
    environment: environmentValue(value.environment, "repository_unavailable"),
    customerId: providerId(value.customerId, "customerId", "repository_unavailable"),
    subscriptionId: optionalProviderId(value.subscriptionId, "subscriptionId", "repository_unavailable"),
    planId: value.planId === null || value.planId === undefined ? null : requiredText(value.planId, "repository_unavailable"),
    subscriptionStatus: requiredText(value.subscriptionStatus || "not_started", "repository_unavailable").toLowerCase(),
    latestEventCreated: Number(value.latestEventCreated || 0),
    latestEventId: value.latestEventId || null
  };
  if (expected.workspaceId && binding.workspaceId !== expected.workspaceId) fail("ownership_mismatch", "binding_workspace_mismatch");
  if (expected.environment && binding.environment !== expected.environment) fail("ownership_mismatch", "binding_environment_mismatch");
  return deepFreeze(binding);
}

function validateGatewayEnvironment(value, expected, resultCode) {
  if (!isPlainObject(value) || normalizedProviderEnvironment(value.environment) !== expected) {
    fail("provider_terminal_failure", resultCode);
  }
  return value;
}

function priceToPlan(configuration, priceId) {
  const normalized = providerId(priceId, "priceId");
  const planId = CANONICAL_PLAN_IDS.find(candidate => configuration.priceIdsByPlan[candidate] === normalized);
  if (!planId) fail("unsupported_plan", "stripe_price_not_configured");
  return planId;
}

function planFromResolver(pricing, configuration, requestedPlanId) {
  if (typeof requestedPlanId !== "string") fail("unsupported_plan", "canonical_plan_required");
  const resolved = pricing.resolvePlan(requestedPlanId);
  if (!resolved?.ok || !CANONICAL_PLAN_IDS.includes(resolved.plan?.id)) {
    fail("unsupported_plan", "canonical_plan_required");
  }
  const planId = resolved.plan.id;
  return deepFreeze({ planId, priceId: configuration.priceIdsByPlan[planId] });
}

function subscriptionStateFromObject(object, environment) {
  if (!isPlainObject(object)) fail("provider_terminal_failure", "subscription_response_invalid");
  if (object.environment !== environment) fail("provider_terminal_failure", "subscription_environment_mismatch");
  const status = requiredText(object.status, "provider_terminal_failure", "subscription_status_invalid", 40).toLowerCase();
  if (!SUBSCRIPTION_STATUSES.has(status)) fail("provider_terminal_failure", "subscription_status_invalid");
  return deepFreeze({
    customerId: providerId(typeof object.customerId === "string" ? object.customerId : object.customer, "customerId"),
    subscriptionId: providerId(typeof object.subscriptionId === "string" ? object.subscriptionId : object.id, "subscriptionId"),
    priceId: optionalProviderId(
      object.priceId || (typeof object.price === "string" ? object.price : object.price?.id) || subscriptionPriceId(object),
      "priceId"
    ),
    status,
    currentPeriodStart: normalizedTimestamp(object.currentPeriodStart, object.current_period_start, "current_period_start"),
    currentPeriodEnd: normalizedTimestamp(object.currentPeriodEnd, object.current_period_end, "current_period_end"),
    cancelAtPeriodEnd: object.cancelAtPeriodEnd === true || object.cancel_at_period_end === true
  });
}

function safeInternalResult(input) {
  return deepFreeze(safeClone(input));
}

function validatedSettlementFacts(input, expectedEnvironment) {
  environmentValue(expectedEnvironment, "reconciliation_required");
  exactKeys(input, STRIPE_SETTLEMENT_FACT_KEYS, "reconciliation_required", "stripe_settlement_facts_invalid");
  if (input.version !== STRIPE_SETTLEMENT_FACTS_VERSION) {
    fail("reconciliation_required", "stripe_settlement_facts_invalid");
  }
  const eventCreated = eventCreatedValue(input.eventCreated);
  const stripeCustomerId = providerId(input.stripeCustomerId, "customerId", "reconciliation_required");
  const settlementSubscriptionId = optionalProviderId(input.settlementSubscriptionId, "subscriptionId", "reconciliation_required");
  if (!STRIPE_SETTLEMENT_EVIDENCE.has(input.evidence)) {
    fail("reconciliation_required", "stripe_settlement_facts_invalid");
  }
  if (input.evidence === "authoritative_subscription_state" && !settlementSubscriptionId) {
    fail("reconciliation_required", "stripe_settlement_facts_invalid");
  }
  if (input.evidence === "no_subscription_evidence" && settlementSubscriptionId !== null) {
    fail("reconciliation_required", "stripe_settlement_facts_invalid");
  }
  return deepFreeze({
    version: STRIPE_SETTLEMENT_FACTS_VERSION,
    eventCreated,
    stripeCustomerId,
    settlementSubscriptionId,
    evidence: input.evidence
  });
}

function privateSettlementFacts(event, ownership, options = {}) {
  return validatedSettlementFacts({
    version: STRIPE_SETTLEMENT_FACTS_VERSION,
    eventCreated: event.eventCreated,
    stripeCustomerId: ownership.binding.customerId,
    settlementSubscriptionId: options.settlementSubscriptionId ?? null,
    evidence: options.evidence
  }, event.environment);
}

function privateLifecycleOutcome(decision, settlementFacts) {
  return deepFreeze({
    decision: safeInternalResult(decision),
    settlementFacts
  });
}

export function createStripeBillingLifecycle(options = {}) {
  exactKeys(options, new Set(["configuration", "pricing", "gateway", "repository", "clock", "generateEventId"]), "configuration_unavailable", "lifecycle_option_unknown");
  const pricing = pricingDependencies(options.pricing);
  const configuration = normalizedConfiguration(options.configuration, pricing);
  const gateway = requireMethods(options.gateway, GATEWAY_METHODS, "stripe_gateway");
  const repository = requireMethods(options.repository, REPOSITORY_METHODS, "stripe_repository");
  const clock = options.clock;
  const generateEventId = options.generateEventId;
  if (typeof clock !== "function" || typeof generateEventId !== "function") {
    fail("configuration_unavailable", "lifecycle_clock_or_id_generator_missing");
  }
  const gatewayConfiguration = deepFreeze({
    version: configuration.version,
    environment: configuration.environment,
    secretKeyPresent: true
  });

  async function repositoryCall(method, input) {
    try {
      return await repository[method](deepFreeze(safeClone(input)));
    } catch (error) {
      throw repositoryFailure(error, method);
    }
  }

  async function gatewayCall(method, input) {
    try {
      return await gateway[method](deepFreeze(safeClone({
        ...input,
        configuration: gatewayConfiguration,
        environment: configuration.environment
      })));
    } catch (error) {
      throw providerFailure(error, method);
    }
  }

  async function markCheckoutReconciliationRequired(reservation, resultCode) {
    await repositoryCall("markCheckoutReconciliationRequired", {
      workspaceId: reservation.workspaceId,
      environment: configuration.environment,
      idempotencyKey: reservation.idempotencyKey,
      lifecycleStatus: "failed",
      resultCode,
      safeResult: { status: "reconciliation_required", resultCode }
    });
  }

  function checkoutResultFromReservation(reservation, duplicate) {
    if (reservation.sessionId) {
      const url = providerNavigationUrl(reservation.safeResult?.url, "checkout");
      return safeInternalResult({
        ok: true,
        status: duplicate ? "reused" : "created",
        resultCode: duplicate ? "checkout_reused" : "checkout_created",
        environment: configuration.environment,
        planId: reservation.requestedPlanId,
        checkoutSessionId: providerId(reservation.sessionId, "checkoutSessionId", "repository_unavailable"),
        url,
        duplicate
      });
    }
    const ambiguous = /_ambiguous$/u.test(reservation.resultCode || "");
    return safeInternalResult({
      ok: false,
      status: "reconciliation_required",
      resultCode: boundedResultCode(reservation.resultCode, "checkout_reconciliation_required"),
      classification: ambiguous ? "ambiguous_provider_creation" : "reconciliation_required",
      retryable: false,
      environment: configuration.environment,
      planId: reservation.requestedPlanId,
      duplicate: true
    });
  }

  async function prepareCheckout(operation = {}) {
    exactKeys(operation, OPERATION_KEYS);
    const context = trustedContext(operation.context, ["successUrl", "cancelUrl"]);
    const request = exactKeys(operation.request || {}, CHECKOUT_REQUEST_KEYS);
    const plan = planFromResolver(pricing, configuration, request.planId);
    const idempotencyKey = requiredText(request.idempotencyKey, "invalid_request", "checkout_idempotency_key_invalid");
    if (idempotencyKey.length < 16) fail("invalid_request", "checkout_idempotency_key_invalid");
    const successUrl = applicationUrl(context.successUrl, "success_url", configuration);
    const cancelUrl = applicationUrl(context.cancelUrl, "cancel_url", configuration);
    const reservation = await repositoryCall("reserveCheckout", {
      workspaceId: context.workspaceId,
      environment: configuration.environment,
      idempotencyKey,
      requestedPlanId: plan.planId
    });
    if (!isPlainObject(reservation)) fail("repository_unavailable", "checkout_reservation_invalid");
    const normalizedReservation = {
      workspaceId: workspaceIdValue(reservation.workspaceId, "repository_unavailable"),
      environment: environmentValue(reservation.environment, "repository_unavailable"),
      idempotencyKey: requiredText(reservation.idempotencyKey, "repository_unavailable"),
      requestedPlanId: requiredText(reservation.requestedPlanId, "repository_unavailable"),
      lifecycleStatus: requiredText(reservation.lifecycleStatus || "reserved", "repository_unavailable"),
      resultCode: reservation.resultCode || null,
      sessionId: reservation.sessionId || null,
      safeResult: isPlainObject(reservation.safeResult) ? safeClone(reservation.safeResult) : {},
      isNew: reservation.isNew === true
    };
    if (normalizedReservation.workspaceId !== context.workspaceId
      || normalizedReservation.environment !== configuration.environment
      || normalizedReservation.idempotencyKey !== idempotencyKey
      || normalizedReservation.requestedPlanId !== plan.planId) {
      fail("idempotency_conflict", "checkout_reservation_conflict");
    }
    if (!normalizedReservation.isNew) return checkoutResultFromReservation(normalizedReservation, true);

    let binding = normalizeBinding(await repositoryCall("getBindingByWorkspace", {
      workspaceId: context.workspaceId,
      environment: configuration.environment
    }), { workspaceId: context.workspaceId, environment: configuration.environment });
    if (binding?.subscriptionId) fail("idempotency_conflict", "current_subscription_exists");
    let customerId = binding?.customerId || null;
    if (!customerId) {
      let customer;
      try {
        customer = validateGatewayEnvironment(await gatewayCall("createCustomer", {
          workspaceId: context.workspaceId,
          idempotencyKey: `customer:${configuration.environment}:${context.workspaceId}`
        }), configuration.environment, "customer_response_invalid");
        customerId = providerId(customer.customerId || customer.id, "customerId");
        const eventCreated = Math.floor(Number(clock()) / 1000);
        const eventId = providerId(generateEventId("customer"), "eventId", "configuration_unavailable");
        const reconciled = await repositoryCall("reconcileBinding", {
          workspaceId: context.workspaceId,
          environment: configuration.environment,
          customerId,
          subscriptionId: null,
          priceId: null,
          planId: null,
          subscriptionStatus: "not_started",
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          eventCreated,
          eventId
        });
        if (reconciled?.workspaceId !== context.workspaceId || reconciled?.environment !== configuration.environment) {
          fail("repository_unavailable", "customer_binding_reconciliation_invalid");
        }
      } catch (error) {
        const safe = classifyStripeBillingError(error);
        await markCheckoutReconciliationRequired(normalizedReservation, safe.resultCode);
        if (safe.classification === "ambiguous_provider_creation") {
          return checkoutResultFromReservation({
            ...normalizedReservation,
            resultCode: "customer_creation_ambiguous"
          }, true);
        }
        throw error;
      }
    }

    let session;
    try {
      session = validateGatewayEnvironment(await gatewayCall("createCheckoutSession", {
        workspaceId: context.workspaceId,
        customerId,
        planId: plan.planId,
        priceId: plan.priceId,
        successUrl,
        cancelUrl,
        idempotencyKey
      }), configuration.environment, "checkout_response_invalid");
    } catch (error) {
      const safe = classifyStripeBillingError(error);
      await markCheckoutReconciliationRequired(normalizedReservation, safe.resultCode);
      if (safe.classification === "ambiguous_provider_creation") {
        return checkoutResultFromReservation({
          ...normalizedReservation,
          resultCode: "checkout_creation_ambiguous"
        }, true);
      }
      throw error;
    }
    const sessionId = providerId(session.checkoutSessionId || session.id, "checkoutSessionId");
    const url = providerNavigationUrl(session.url, "checkout");
    const bound = await repositoryCall("bindCheckoutSession", {
      workspaceId: context.workspaceId,
      environment: configuration.environment,
      idempotencyKey,
      requestedPlanId: plan.planId,
      sessionId,
      lifecycleStatus: "created",
      resultCode: "checkout_created",
      safeResult: { status: "created", resultCode: "checkout_created", planId: plan.planId, url }
    });
    if (!isPlainObject(bound)
      || bound.workspaceId !== context.workspaceId
      || bound.environment !== configuration.environment
      || bound.sessionId !== sessionId) {
      fail("repository_unavailable", "checkout_binding_invalid");
    }
    return checkoutResultFromReservation({
      ...normalizedReservation,
      requestedPlanId: plan.planId,
      sessionId,
      safeResult: { url }
    }, false);
  }

  async function preparePortal(operation = {}) {
    exactKeys(operation, OPERATION_KEYS);
    const context = trustedContext(operation.context, ["returnUrl"]);
    const request = exactKeys(operation.request || {}, PORTAL_REQUEST_KEYS);
    const idempotencyKey = requiredText(request.idempotencyKey, "invalid_request", "portal_idempotency_key_invalid");
    if (idempotencyKey.length < 16) fail("invalid_request", "portal_idempotency_key_invalid");
    const returnUrl = applicationUrl(context.returnUrl, "return_url", configuration);
    const binding = normalizeBinding(await repositoryCall("getBindingByWorkspace", {
      workspaceId: context.workspaceId,
      environment: configuration.environment
    }), { workspaceId: context.workspaceId, environment: configuration.environment });
    if (!binding) fail("reconciliation_required", "stripe_customer_binding_missing");
    const session = validateGatewayEnvironment(await gatewayCall("createPortalSession", {
      customerId: binding.customerId,
      returnUrl,
      idempotencyKey
    }), configuration.environment, "portal_response_invalid");
    return safeInternalResult({
      ok: true,
      status: "created",
      resultCode: "portal_created",
      environment: configuration.environment,
      url: providerNavigationUrl(session.url, "portal")
    });
  }

  async function resolveOwnership(event) {
    const workspaces = new Set();
    let checkout = null;
    let byCustomer = null;
    let bySubscription = null;
    let byWorkspace = null;
    if (event.checkoutSessionId) {
      checkout = await repositoryCall("getCheckoutBySession", {
        environment: configuration.environment,
        sessionId: event.checkoutSessionId
      });
      if (checkout) {
        const checkoutWorkspace = workspaceIdValue(checkout.workspaceId, "repository_unavailable");
        if (checkout.environment !== configuration.environment) fail("ownership_mismatch", "checkout_environment_mismatch");
        workspaces.add(checkoutWorkspace);
        byWorkspace = normalizeBinding(await repositoryCall("getBindingByWorkspace", {
          workspaceId: checkoutWorkspace,
          environment: configuration.environment
        }), { workspaceId: checkoutWorkspace, environment: configuration.environment });
        if (!byWorkspace) fail("reconciliation_required", "checkout_customer_binding_missing");
        workspaces.add(byWorkspace.workspaceId);
      }
    }
    if (event.customerId) {
      byCustomer = normalizeBinding(await repositoryCall("getBindingByCustomer", {
        environment: configuration.environment,
        customerId: event.customerId
      }), { environment: configuration.environment });
      if (byCustomer) workspaces.add(byCustomer.workspaceId);
    }
    if (event.subscriptionId) {
      bySubscription = normalizeBinding(await repositoryCall("getBindingBySubscription", {
        environment: configuration.environment,
        subscriptionId: event.subscriptionId
      }), { environment: configuration.environment });
      if (bySubscription) workspaces.add(bySubscription.workspaceId);
    }
    if (workspaces.size > 1) fail("ownership_mismatch", "durable_billing_ownership_conflict");
    const workspaceId = [...workspaces][0] || null;
    if (!workspaceId) return null;
    const binding = bySubscription || byCustomer || byWorkspace;
    if (!binding) fail("reconciliation_required", "durable_billing_binding_missing");
    if (event.customerId && event.customerId !== binding.customerId) {
      fail("ownership_mismatch", "stripe_customer_ownership_mismatch");
    }
    if (event.metadataWorkspaceId && workspaceIdValue(event.metadataWorkspaceId) !== workspaceId) {
      fail("ownership_mismatch", "stripe_metadata_workspace_mismatch");
    }
    if (checkout?.requestedPlanId && event.metadataPlanId && checkout.requestedPlanId !== event.metadataPlanId) {
      fail("ownership_mismatch", "checkout_plan_mismatch");
    }
    return deepFreeze({ workspaceId, binding, checkout: checkout ? safeClone(checkout) : null });
  }

  function subscriptionReconcileInput(subscription, event, ownership) {
    if (subscription.customerId !== ownership.binding.customerId) {
      fail("ownership_mismatch", "stripe_customer_ownership_mismatch");
    }
    const terminal = TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status);
    let planId = null;
    let priceId = null;
    let subscriptionId = null;
    let currentPeriodStart = null;
    let currentPeriodEnd = null;
    let cancelAtPeriodEnd = false;
    if (!terminal) {
      subscriptionId = subscription.subscriptionId;
      priceId = subscription.priceId;
      if (!priceId) fail("unsupported_plan", "stripe_price_not_configured");
      planId = priceToPlan(configuration, priceId);
      currentPeriodStart = subscription.currentPeriodStart;
      currentPeriodEnd = subscription.currentPeriodEnd;
      if ((currentPeriodStart === null) !== (currentPeriodEnd === null)) {
        fail("provider_terminal_failure", "subscription_period_invalid");
      }
      if (currentPeriodStart && Date.parse(currentPeriodEnd) <= Date.parse(currentPeriodStart)) {
        fail("provider_terminal_failure", "subscription_period_invalid");
      }
      cancelAtPeriodEnd = subscription.cancelAtPeriodEnd;
    }
    const corroboratingPlanId = terminal ? ownership.binding.planId : planId;
    if (event.metadataPlanId && event.metadataPlanId !== corroboratingPlanId) {
      fail("ownership_mismatch", "stripe_metadata_plan_mismatch");
    }
    if (ownership.checkout?.requestedPlanId && planId && ownership.checkout.requestedPlanId !== planId) {
      fail("ownership_mismatch", "checkout_plan_mismatch");
    }
    return deepFreeze({
      workspaceId: ownership.workspaceId,
      environment: configuration.environment,
      customerId: ownership.binding.customerId,
      subscriptionId,
      priceId,
      planId,
      subscriptionStatus: subscription.status,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      eventCreated: event.eventCreated,
      eventId: event.eventId
    });
  }

  async function lifecycleDecision(event, ownership) {
    if (["charge.refunded", "charge.dispute.created", "charge.dispute.closed"].includes(event.eventType)) {
      if (event.metadataPlanId && event.metadataPlanId !== ownership.binding.planId) {
        fail("ownership_mismatch", "stripe_metadata_plan_mismatch");
      }
      return privateLifecycleOutcome(
        {
          ok: true,
          status: "review_required",
          resultCode: `${event.incident}_requires_b2_review`,
          eventType: event.eventType,
          environment: configuration.environment,
          workspaceId: ownership.workspaceId,
          eventId: event.eventId,
          entitlementActionRequired: true,
          desiredState: { kind: "incident_review", incident: event.incident }
        },
        privateSettlementFacts(event, ownership, {
          evidence: event.subscriptionId
            ? "non_authoritative_subscription_context"
            : "no_subscription_evidence"
        })
      );
    }

    let subscription;
    if (event.eventType.startsWith("customer.subscription.")) {
      const status = event.eventType === "customer.subscription.deleted" ? "canceled" : event.subscriptionStatus;
      if (!SUBSCRIPTION_STATUSES.has(status)) fail("provider_terminal_failure", "subscription_status_invalid");
      subscription = deepFreeze({
        customerId: providerId(event.customerId, "customerId"),
        subscriptionId: providerId(event.subscriptionId, "subscriptionId"),
        priceId: event.priceId,
        status,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd
      });
    } else {
      if (!event.subscriptionId) {
        return privateLifecycleOutcome(
          {
            ok: true,
            status: "no_transition",
            resultCode: "subscription_not_established",
            eventType: event.eventType,
            environment: configuration.environment,
            workspaceId: ownership.workspaceId,
            eventId: event.eventId,
            entitlementActionRequired: false,
            desiredState: { kind: "no_transition" }
          },
          privateSettlementFacts(event, ownership, { evidence: "no_subscription_evidence" })
        );
      }
      subscription = subscriptionStateFromObject(await gatewayCall("retrieveSubscription", {
        subscriptionId: event.subscriptionId
      }), configuration.environment);
      if (subscription.subscriptionId !== event.subscriptionId) {
        fail("ownership_mismatch", "stripe_subscription_ownership_mismatch");
      }
    }
    const settlementSubscriptionId = subscription.subscriptionId;
    const input = subscriptionReconcileInput(subscription, event, ownership);
    const reconciled = await repositoryCall("reconcileBinding", input);
    if (!isPlainObject(reconciled)
      || reconciled.workspaceId !== ownership.workspaceId
      || reconciled.environment !== configuration.environment
      || !["created", "current_subscription_updated", "current_subscription_replaced", "current_subscription_cleared", "replayed_or_stale"].includes(reconciled.resultCode)) {
      fail("repository_unavailable", "binding_reconciliation_result_invalid");
    }
    const stale = reconciled.resultCode === "replayed_or_stale" || reconciled.applied === false;
    const paymentSignal = event.eventType === "invoice.paid"
      ? "paid"
      : event.eventType === "invoice.payment_failed"
        ? "failed"
        : event.paymentStatus || "provider_state";
    return privateLifecycleOutcome(
      {
        ok: true,
        status: stale ? "stale" : "reconciled",
        resultCode: reconciled.resultCode,
        classification: stale ? "stale_event" : undefined,
        eventType: event.eventType,
        environment: configuration.environment,
        workspaceId: ownership.workspaceId,
        eventId: event.eventId,
        planId: input.planId,
        subscriptionStatus: input.subscriptionStatus,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        applied: !stale,
        subscriptionReplaced: reconciled.subscriptionReplaced === true,
        entitlementActionRequired: !stale,
        desiredState: {
          kind: "subscription_state",
          paymentSignal,
          planId: input.planId,
          subscriptionStatus: input.subscriptionStatus,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd
        }
      },
      privateSettlementFacts(event, ownership, {
        settlementSubscriptionId,
        evidence: stale
          ? "non_authoritative_subscription_context"
          : "authoritative_subscription_state"
      })
    );
  }

  async function verifyWebhook(input) {
    if (!isPlainObject(input)) fail("invalid_request", "webhook_request_invalid");
    const expectedEnvironment = environmentValue(input.expectedEnvironment, "invalid_request");
    if (expectedEnvironment !== configuration.environment) {
      fail("provider_verification_failure", "webhook_environment_mismatch");
    }
    if (!(input.rawBody instanceof Uint8Array)) fail("invalid_request", "webhook_raw_bytes_required");
    const signatureHeader = requiredText(input.signatureHeader, "provider_verification_failure", "webhook_signature_required", 4096);
    let verified;
    try {
      verified = await gateway.verifyWebhookEvent(deepFreeze({
        rawBody: new Uint8Array(input.rawBody),
        signatureHeader,
        webhookSecret: configuration.webhookSecret,
        environment: configuration.environment,
        configuration: gatewayConfiguration
      }));
    } catch {
      throw lifecycleError("provider_verification_failure", "webhook_signature_invalid");
    }
    return normalizeStripeBillingEvent(verified, configuration.environment);
  }

  async function handleWebhook(input = {}) {
    const event = await verifyWebhook(input);
    if (!event.supported) {
      return safeInternalResult({
        ok: true,
        status: "ignored",
        resultCode: "event_type_ignored",
        eventType: event.eventType,
        environment: configuration.environment,
        entitlementActionRequired: false
      });
    }
    const ownership = await resolveOwnership(event);
    if (!ownership) {
      return safeInternalResult({
        ok: true,
        status: "ownership_unresolved",
        resultCode: "durable_ownership_not_found",
        eventType: event.eventType,
        environment: configuration.environment,
        entitlementActionRequired: false
      });
    }
    const claim = await repositoryCall("claimWebhookEvent", {
      workspaceId: ownership.workspaceId,
      environment: configuration.environment,
      eventId: event.eventId,
      eventType: event.eventType,
      staleAfterSeconds: configuration.webhookClaimStaleAfterSeconds
    });
    const validClaim = isPlainObject(claim) && (
      (claim.claimed === true
        && claim.duplicate === false
        && ["claimed", "reclaimed"].includes(claim.resultCode))
      || (claim.claimed === false
        && claim.duplicate === true
        && ["already_claimed", "already_complete"].includes(claim.resultCode))
    );
    if (!validClaim) {
      fail("reconciliation_required", "webhook_claim_ambiguous");
    }
    if (!claim.claimed) {
      if (!claim.duplicate) fail("reconciliation_required", "webhook_claim_ambiguous");
      if (claim.resultCode === "already_complete") {
        const recorded = await repositoryCall("getWebhookResult", {
          workspaceId: ownership.workspaceId,
          environment: configuration.environment,
          eventId: event.eventId,
          eventType: event.eventType
        });
        return safeInternalResult({
          ...toSafeStripeBillingResult(recorded || {}),
          ok: true,
          status: "replayed",
          resultCode: "already_complete",
          classification: "duplicate_event",
          duplicate: true,
          eventType: event.eventType,
          environment: configuration.environment,
          workspaceId: ownership.workspaceId,
          eventId: event.eventId,
          entitlementActionRequired: false
        });
      }
      return safeInternalResult({
        ok: true,
        status: "in_progress",
        resultCode: "already_claimed",
        classification: "duplicate_event",
        duplicate: true,
        eventType: event.eventType,
        environment: configuration.environment,
        workspaceId: ownership.workspaceId,
        eventId: event.eventId,
        entitlementActionRequired: false
      });
    }

    try {
      const outcome = await lifecycleDecision(event, ownership);
      const decision = outcome.decision;
      const settlementFacts = validatedSettlementFacts(outcome.settlementFacts, configuration.environment);
      const safeResult = toSafeStripeBillingResult(decision);
      await repositoryCall("completeWebhookEvent", {
        workspaceId: ownership.workspaceId,
        environment: configuration.environment,
        eventId: event.eventId,
        eventType: event.eventType,
        resultCode: decision.resultCode,
        safeResult,
        settlementFacts
      });
      return decision;
    } catch (error) {
      const safeError = classifyStripeBillingError(error);
      try {
        await repositoryCall("failWebhookEvent", {
          workspaceId: ownership.workspaceId,
          environment: configuration.environment,
          eventId: event.eventId,
          eventType: event.eventType,
          resultCode: safeError.resultCode,
          retryable: safeError.retryable
        });
      } catch {
        // The original sanitized lifecycle failure remains authoritative.
      }
      throw error instanceof StripeBillingLifecycleError
        ? error
        : lifecycleError("provider_terminal_failure", "webhook_processing_failed");
    }
  }

  return deepFreeze({
    environment: configuration.environment,
    configuration: validateStripeBillingConfiguration(options.configuration, pricing),
    prepareCheckout,
    preparePortal,
    handleWebhook
  });
}
