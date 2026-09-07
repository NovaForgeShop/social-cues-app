const BINDING_FIELDS = Object.freeze([
  "workspace_id",
  "stripe_environment",
  "stripe_customer_id",
  "stripe_subscription_id",
  "stripe_price_id",
  "plan_id",
  "subscription_status",
  "current_period_start",
  "current_period_end",
  "cancel_at_period_end",
  "latest_event_created",
  "latest_event_id",
  "created_at",
  "updated_at"
]);
const CHECKOUT_FIELDS = Object.freeze([
  "workspace_id",
  "stripe_environment",
  "stripe_session_id",
  "idempotency_key",
  "requested_plan_id",
  "lifecycle_status",
  "result_code",
  "safe_result",
  "created_at",
  "updated_at"
]);
const WEBHOOK_FIELDS = Object.freeze([
  "provider",
  "event_id",
  "event_type",
  "status",
  "attempts",
  "environment",
  "workspace_id",
  "result_code",
  "processing_result",
  "received_at",
  "processed_at"
]);
const RECONCILE_FIELDS = Object.freeze([
  "binding_id",
  "workspace_id",
  "stripe_environment",
  "plan_id",
  "subscription_status",
  "current_period_start",
  "current_period_end",
  "cancel_at_period_end",
  "applied",
  "result_code",
  "subscription_replaced",
  "created_at",
  "updated_at"
]);
const CLAIM_FIELDS = Object.freeze(["claimed", "duplicate", "event_status", "event_attempts", "result_code"]);
const EXPECTED_OPENAPI_COLUMNS = Object.freeze({
  stripe_billing_bindings: BINDING_FIELDS,
  stripe_checkout_sessions: CHECKOUT_FIELDS,
  webhook_events: WEBHOOK_FIELDS
});
const RECONCILE_RPC = "social_cues_reconcile_stripe_binding";
const CLAIM_RPC = "social_cues_claim_stripe_webhook_event";
const RECONCILE_INPUTS = Object.freeze([
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
]);
const CLAIM_INPUTS = Object.freeze([
  "p_workspace_id",
  "p_stripe_environment",
  "p_event_id",
  "p_event_type",
  "p_stale_after_seconds"
]);

export const STRIPE_BILLING_REPOSITORY_METHOD_MAP = Object.freeze({
  getBindingByWorkspace: "direct_service_role_query",
  getBindingByCustomer: "direct_service_role_query",
  getBindingBySubscription: "direct_service_role_query",
  getCheckoutBySession: "direct_service_role_query",
  reserveCheckout: "b0_unique_insert_then_exact_read",
  bindCheckoutSession: "direct_service_role_update",
  markCheckoutReconciliationRequired: "direct_service_role_update",
  claimWebhookEvent: "b0_claim_rpc",
  getWebhookResult: "direct_service_role_query",
  completeWebhookEvent: "direct_service_role_update",
  failWebhookEvent: "direct_service_role_update",
  reconcileBinding: "b0_reconcile_rpc"
});

export class StripeBillingRepositoryError extends Error {
  constructor(code, kind = "unavailable") {
    super(code);
    this.name = "StripeBillingRepositoryError";
    this.code = code;
    this.kind = kind;
  }
}

function fail(code, kind) {
  throw new StripeBillingRepositoryError(code, kind);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, code, maximum = 255) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(code, "invalid_input");
  return value.trim();
}

function workspaceId(value) {
  const normalized = requiredText(value, "workspace_id_invalid", 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
    fail("workspace_id_invalid", "invalid_input");
  }
  return normalized;
}

function environmentValue(value) {
  if (!['test', 'live'].includes(value)) fail("stripe_environment_invalid", "invalid_input");
  return value;
}

function exactObject(value, fields, code) {
  if (!plainObject(value)) fail(code, "invalid_result");
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) fail(code, "invalid_result");
  }
  return value;
}

function oneRow(value, fields, code, { optional = false } = {}) {
  if (!Array.isArray(value)) fail(code, "invalid_result");
  if (value.length === 0 && optional) return null;
  if (value.length !== 1) fail(value.length > 1 ? `${code}_ambiguous` : `${code}_missing`, value.length > 1 ? "ambiguous" : "not_found");
  return exactObject(value[0], fields, code);
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function bindingResult(row) {
  if (!row) return null;
  return Object.freeze({
    workspaceId: row.workspace_id,
    environment: row.stripe_environment,
    customerId: row.stripe_customer_id,
    subscriptionId: row.stripe_subscription_id,
    priceId: row.stripe_price_id,
    planId: row.plan_id,
    subscriptionStatus: row.subscription_status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    latestEventCreated: Number(row.latest_event_created || 0),
    latestEventId: row.latest_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function checkoutResult(row, isNew = false) {
  if (!row) return null;
  return Object.freeze({
    workspaceId: row.workspace_id,
    environment: row.stripe_environment,
    sessionId: row.stripe_session_id,
    idempotencyKey: row.idempotency_key,
    requestedPlanId: row.requested_plan_id,
    lifecycleStatus: row.lifecycle_status,
    resultCode: row.result_code,
    safeResult: plainObject(row.safe_result) ? Object.freeze({ ...row.safe_result }) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isNew
  });
}

function claimResult(row) {
  exactObject(row, CLAIM_FIELDS, "webhook_claim_result_invalid");
  return Object.freeze({
    claimed: row.claimed === true,
    duplicate: row.duplicate === true,
    eventStatus: row.event_status,
    eventAttempts: Number(row.event_attempts),
    resultCode: row.result_code
  });
}

function reconciliationResult(row, input) {
  exactObject(row, RECONCILE_FIELDS, "binding_reconciliation_result_invalid");
  return Object.freeze({
    workspaceId: row.workspace_id,
    environment: row.stripe_environment,
    customerId: input.customerId,
    subscriptionId: input.subscriptionId,
    priceId: input.priceId,
    planId: row.plan_id,
    subscriptionStatus: row.subscription_status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    applied: row.applied === true,
    resultCode: row.result_code,
    subscriptionReplaced: row.subscription_replaced === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function safeResult(value) {
  if (!plainObject(value)) fail("safe_result_invalid", "invalid_input");
  const serialized = JSON.stringify(value);
  if (serialized.length > 4096 || /secret|token|api.?key|authorization|raw|payload|customer.?id|subscription.?id|price.?id|session.?id/iu.test(serialized)) {
    fail("safe_result_invalid", "invalid_input");
  }
  return value;
}

function classifyProbeError(error) {
  const message = String(error?.message || "");
  if (/42P01|PGRST20[245]|schema cache|does not exist|not find.*(table|function)/iu.test(message)) {
    return Object.freeze({ ready: false, state: "database_migration_missing", reasonCode: "b0_contract_missing" });
  }
  return Object.freeze({ ready: false, state: "database_unavailable", reasonCode: "database_probe_failed" });
}

function exactOpenApiContract(document) {
  if (!plainObject(document?.paths)) return false;
  const reconcile = document.paths[`/rpc/${RECONCILE_RPC}`]?.post;
  const claim = document.paths[`/rpc/${CLAIM_RPC}`]?.post;
  if (!plainObject(reconcile) || !plainObject(claim)) return false;
  const reconcileDocument = JSON.stringify(reconcile);
  const claimDocument = JSON.stringify(claim);
  return RECONCILE_INPUTS.every(name => reconcileDocument.includes(`"${name}"`))
    && CLAIM_INPUTS.every(name => claimDocument.includes(`"${name}"`));
}

export function createStripeBillingRepository(options = {}) {
  if (typeof options.request !== "function") fail("repository_request_transport_missing", "configuration");
  const now = typeof options.now === "function" ? options.now : Date.now;

  async function request(pathname, requestOptions = {}) {
    try {
      return await options.request(pathname, requestOptions);
    } catch (error) {
      if (error instanceof StripeBillingRepositoryError) throw error;
      throw new StripeBillingRepositoryError("repository_request_failed", "unavailable");
    }
  }

  async function bindingLookup(filters) {
    const filterText = Object.entries(filters).map(([name, value]) => `${name}=eq.${encode(value)}`).join("&");
    const rows = await request(`/stripe_billing_bindings?${filterText}&select=${BINDING_FIELDS.join(",")}&limit=2`);
    return bindingResult(oneRow(rows, BINDING_FIELDS, "binding_lookup", { optional: true }));
  }

  async function getBindingByWorkspace(input = {}) {
    return bindingLookup({
      workspace_id: workspaceId(input.workspaceId),
      stripe_environment: environmentValue(input.environment)
    });
  }

  async function getBindingByCustomer(input = {}) {
    return bindingLookup({
      stripe_environment: environmentValue(input.environment),
      stripe_customer_id: requiredText(input.customerId, "customer_id_invalid")
    });
  }

  async function getBindingBySubscription(input = {}) {
    return bindingLookup({
      stripe_environment: environmentValue(input.environment),
      stripe_subscription_id: requiredText(input.subscriptionId, "subscription_id_invalid")
    });
  }

  async function getCheckoutBySession(input = {}) {
    const environment = environmentValue(input.environment);
    const sessionId = requiredText(input.sessionId, "checkout_session_id_invalid");
    const rows = await request(`/stripe_checkout_sessions?stripe_environment=eq.${encode(environment)}&stripe_session_id=eq.${encode(sessionId)}&select=${CHECKOUT_FIELDS.join(",")}&limit=2`);
    return checkoutResult(oneRow(rows, CHECKOUT_FIELDS, "checkout_lookup", { optional: true }));
  }

  async function checkoutByReservation(input) {
    const rows = await request(`/stripe_checkout_sessions?workspace_id=eq.${encode(input.workspaceId)}&stripe_environment=eq.${encode(input.environment)}&idempotency_key=eq.${encode(input.idempotencyKey)}&select=${CHECKOUT_FIELDS.join(",")}&limit=2`);
    return oneRow(rows, CHECKOUT_FIELDS, "checkout_reservation", { optional: true });
  }

  async function reserveCheckout(input = {}) {
    const normalized = {
      workspaceId: workspaceId(input.workspaceId),
      environment: environmentValue(input.environment),
      idempotencyKey: requiredText(input.idempotencyKey, "checkout_idempotency_key_invalid"),
      requestedPlanId: requiredText(input.requestedPlanId, "checkout_plan_invalid", 40)
    };
    const inserted = await request(`/stripe_checkout_sessions?on_conflict=workspace_id,stripe_environment,idempotency_key&select=${CHECKOUT_FIELDS.join(",")}`, {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{
        workspace_id: normalized.workspaceId,
        stripe_environment: normalized.environment,
        idempotency_key: normalized.idempotencyKey,
        requested_plan_id: normalized.requestedPlanId,
        lifecycle_status: "reserved",
        result_code: "reserved",
        safe_result: {}
      }])
    });
    if (!Array.isArray(inserted) || inserted.length > 1) fail("checkout_reservation_insert_invalid", "invalid_result");
    const row = inserted.length === 1
      ? exactObject(inserted[0], CHECKOUT_FIELDS, "checkout_reservation_insert_invalid")
      : await checkoutByReservation(normalized);
    if (!row) fail("checkout_reservation_missing", "not_found");
    if (row.workspace_id !== normalized.workspaceId
      || row.stripe_environment !== normalized.environment
      || row.idempotency_key !== normalized.idempotencyKey
      || row.requested_plan_id !== normalized.requestedPlanId) {
      fail("checkout_reservation_conflict", "conflict");
    }
    return checkoutResult(row, inserted.length === 1);
  }

  async function patchCheckout(input, changes, code) {
    const normalized = {
      workspaceId: workspaceId(input.workspaceId),
      environment: environmentValue(input.environment),
      idempotencyKey: requiredText(input.idempotencyKey, "checkout_idempotency_key_invalid")
    };
    const planFilter = input.requestedPlanId
      ? `&requested_plan_id=eq.${encode(requiredText(input.requestedPlanId, "checkout_plan_invalid", 40))}`
      : "";
    const rows = await request(`/stripe_checkout_sessions?workspace_id=eq.${encode(normalized.workspaceId)}&stripe_environment=eq.${encode(normalized.environment)}&idempotency_key=eq.${encode(normalized.idempotencyKey)}${planFilter}&select=${CHECKOUT_FIELDS.join(",")}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(changes)
    });
    return checkoutResult(oneRow(rows, CHECKOUT_FIELDS, code));
  }

  async function bindCheckoutSession(input = {}) {
    return patchCheckout(input, {
      stripe_session_id: requiredText(input.sessionId, "checkout_session_id_invalid"),
      lifecycle_status: requiredText(input.lifecycleStatus, "checkout_lifecycle_status_invalid", 40),
      result_code: requiredText(input.resultCode, "checkout_result_code_invalid", 80),
      safe_result: safeResult(input.safeResult)
    }, "checkout_binding");
  }

  async function markCheckoutReconciliationRequired(input = {}) {
    return patchCheckout(input, {
      lifecycle_status: requiredText(input.lifecycleStatus, "checkout_lifecycle_status_invalid", 40),
      result_code: requiredText(input.resultCode, "checkout_result_code_invalid", 80),
      safe_result: safeResult(input.safeResult)
    }, "checkout_reconciliation_mark");
  }

  async function claimWebhookEvent(input = {}) {
    const rows = await request(`/rpc/${CLAIM_RPC}`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        p_workspace_id: workspaceId(input.workspaceId),
        p_stripe_environment: environmentValue(input.environment),
        p_event_id: requiredText(input.eventId, "event_id_invalid"),
        p_event_type: requiredText(input.eventType, "event_type_invalid", 160),
        p_stale_after_seconds: Number(input.staleAfterSeconds)
      })
    });
    return claimResult(oneRow(rows, CLAIM_FIELDS, "webhook_claim"));
  }

  function webhookLedgerId(environment, eventId) {
    return `${environment}:${eventId}`;
  }

  async function webhookRow(input, code) {
    const normalizedWorkspace = workspaceId(input.workspaceId);
    const normalizedEnvironment = environmentValue(input.environment);
    const normalizedEventId = requiredText(input.eventId, "event_id_invalid");
    const normalizedEventType = requiredText(input.eventType, "event_type_invalid", 160);
    const rows = await request(`/webhook_events?provider=eq.stripe&environment=eq.${encode(normalizedEnvironment)}&workspace_id=eq.${encode(normalizedWorkspace)}&event_id=eq.${encode(webhookLedgerId(normalizedEnvironment, normalizedEventId))}&event_type=eq.${encode(normalizedEventType)}&select=${WEBHOOK_FIELDS.join(",")}&limit=2`);
    return oneRow(rows, WEBHOOK_FIELDS, code, { optional: true });
  }

  async function getWebhookResult(input = {}) {
    const row = await webhookRow(input, "webhook_result");
    return row && plainObject(row.processing_result) ? Object.freeze({ ...row.processing_result }) : null;
  }

  async function patchWebhook(input, changes, code) {
    const normalizedWorkspace = workspaceId(input.workspaceId);
    const normalizedEnvironment = environmentValue(input.environment);
    const normalizedEventId = requiredText(input.eventId, "event_id_invalid");
    const normalizedEventType = requiredText(input.eventType, "event_type_invalid", 160);
    const rows = await request(`/webhook_events?provider=eq.stripe&environment=eq.${encode(normalizedEnvironment)}&workspace_id=eq.${encode(normalizedWorkspace)}&event_id=eq.${encode(webhookLedgerId(normalizedEnvironment, normalizedEventId))}&event_type=eq.${encode(normalizedEventType)}&status=eq.processing&select=${WEBHOOK_FIELDS.join(",")}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(changes)
    });
    return oneRow(rows, WEBHOOK_FIELDS, code);
  }

  async function completeWebhookEvent(input = {}) {
    await patchWebhook(input, {
      status: "complete",
      processed_at: new Date(Number(now())).toISOString(),
      last_error: null,
      result_code: requiredText(input.resultCode, "webhook_result_code_invalid", 80),
      processing_result: safeResult(input.safeResult)
    }, "webhook_completion");
    return Object.freeze({ completed: true });
  }

  async function failWebhookEvent(input = {}) {
    const resultCode = requiredText(input.resultCode, "webhook_result_code_invalid", 80);
    await patchWebhook(input, {
      status: "failed",
      processed_at: new Date(Number(now())).toISOString(),
      last_error: resultCode,
      result_code: resultCode,
      processing_result: { retryable: input.retryable === true, resultCode }
    }, "webhook_failure");
    return Object.freeze({ failed: true });
  }

  async function reconcileBinding(input = {}) {
    const normalizedInput = {
      workspaceId: workspaceId(input.workspaceId),
      environment: environmentValue(input.environment),
      customerId: requiredText(input.customerId, "customer_id_invalid"),
      subscriptionId: input.subscriptionId ?? null,
      priceId: input.priceId ?? null,
      planId: input.planId ?? null,
      subscriptionStatus: requiredText(input.subscriptionStatus, "subscription_status_invalid", 40),
      currentPeriodStart: input.currentPeriodStart ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd === true,
      eventCreated: Number(input.eventCreated),
      eventId: requiredText(input.eventId, "event_id_invalid")
    };
    const rows = await request(`/rpc/${RECONCILE_RPC}`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        p_workspace_id: normalizedInput.workspaceId,
        p_stripe_environment: normalizedInput.environment,
        p_stripe_customer_id: normalizedInput.customerId,
        p_stripe_subscription_id: normalizedInput.subscriptionId,
        p_stripe_price_id: normalizedInput.priceId,
        p_plan_id: normalizedInput.planId,
        p_subscription_status: normalizedInput.subscriptionStatus,
        p_current_period_start: normalizedInput.currentPeriodStart,
        p_current_period_end: normalizedInput.currentPeriodEnd,
        p_cancel_at_period_end: normalizedInput.cancelAtPeriodEnd,
        p_event_created: normalizedInput.eventCreated,
        p_event_id: normalizedInput.eventId
      })
    });
    return reconciliationResult(oneRow(rows, RECONCILE_FIELDS, "binding_reconciliation"), normalizedInput);
  }

  async function probeReadiness() {
    try {
      const document = await request("/", { headers: { Accept: "application/openapi+json" } });
      if (!exactOpenApiContract(document)) {
        return Object.freeze({ ready: false, state: "database_migration_missing", reasonCode: "b0_contract_incomplete" });
      }
      for (const [tableName, fields] of Object.entries(EXPECTED_OPENAPI_COLUMNS)) {
        const rows = await request(`/${tableName}?select=${fields.join(",")}&limit=0`);
        if (!Array.isArray(rows) || rows.length !== 0) {
          return Object.freeze({ ready: false, state: "database_unavailable", reasonCode: "database_probe_shape_invalid" });
        }
      }
      return Object.freeze({ ready: true, state: "database_ready", reasonCode: null });
    } catch (error) {
      return classifyProbeError(error);
    }
  }

  return Object.freeze({
    getBindingByWorkspace,
    getBindingByCustomer,
    getBindingBySubscription,
    getCheckoutBySession,
    reserveCheckout,
    bindCheckoutSession,
    markCheckoutReconciliationRequired,
    claimWebhookEvent,
    getWebhookResult,
    completeWebhookEvent,
    failWebhookEvent,
    reconcileBinding,
    probeReadiness
  });
}
