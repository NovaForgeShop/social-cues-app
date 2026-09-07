import crypto from "node:crypto";
import { STRIPE_BILLING_API_VERSION } from "./stripe-billing-configuration.mjs";

const STRIPE_API_ORIGIN = "https://api.stripe.com";
const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";
const STRIPE_PORTAL_ORIGIN = "https://billing.stripe.com";
const PROVIDER_ID = Object.freeze({
  customer: /^cus_[A-Za-z0-9]{6,248}$/u,
  checkout: /^cs_[A-Za-z0-9_]{6,247}$/u,
  subscription: /^sub_[A-Za-z0-9]{6,248}$/u,
  price: /^price_[A-Za-z0-9]{6,246}$/u
});

export class StripeBillingGatewayError extends Error {
  constructor(code, classification = "provider_terminal_failure") {
    super(code);
    this.name = "StripeBillingGatewayError";
    this.code = code;
    this.classification = classification;
  }
}

function fail(code, classification) {
  throw new StripeBillingGatewayError(code, classification);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, code, maximum = 2048) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(code);
  return value.trim();
}

function providerId(value, kind, code) {
  const normalized = text(value, code, 255);
  if (!PROVIDER_ID[kind].test(normalized)) fail(code);
  return normalized;
}

function environmentValue(value) {
  if (!['test', 'live'].includes(value)) fail("gateway_environment_invalid", "configuration_unavailable");
  return value;
}

function providerEnvironment(livemode, expected) {
  const actual = livemode === true ? "live" : livemode === false ? "test" : null;
  if (actual !== expected) fail("provider_environment_mismatch");
  return actual;
}

function navigationUrl(value, expectedOrigin, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (parsed.origin !== expectedOrigin || parsed.username || parsed.password || parsed.hash) fail(code);
  return parsed.toString();
}

function safeJson(value, code) {
  if (plainObject(value)) return value;
  if (typeof value !== "string" || value.length > 262144) fail(code);
  try {
    const parsed = JSON.parse(value);
    if (!plainObject(parsed)) fail(code);
    return parsed;
  } catch {
    fail(code);
  }
}

function subscriptionProjection(payload, environment) {
  const customerId = providerId(typeof payload.customer === "string" ? payload.customer : payload.customer?.id, "customer", "subscription_response_invalid");
  const subscriptionId = providerId(payload.id, "subscription", "subscription_response_invalid");
  const priceCandidate = payload.items?.data?.[0]?.price;
  const priceId = providerId(typeof priceCandidate === "string" ? priceCandidate : priceCandidate?.id, "price", "subscription_response_invalid");
  return Object.freeze({
    environment: providerEnvironment(payload.livemode, environment),
    customerId,
    subscriptionId,
    priceId,
    status: text(payload.status, "subscription_response_invalid", 40).toLowerCase(),
    current_period_start: payload.current_period_start ?? null,
    current_period_end: payload.current_period_end ?? null,
    cancel_at_period_end: payload.cancel_at_period_end === true
  });
}

function signatureParts(header) {
  const segments = text(header, "webhook_signature_required", 4096).split(",");
  let timestamp = null;
  const signatures = [];
  for (const segment of segments) {
    const separator = segment.indexOf("=");
    if (separator <= 0) fail("webhook_signature_malformed", "provider_verification_failure");
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!value) fail("webhook_signature_malformed", "provider_verification_failure");
    if (name === "t") {
      if (timestamp !== null) fail("webhook_signature_duplicate_timestamp", "provider_verification_failure");
      timestamp = value;
    } else if (name === "v1") {
      if (signatures.includes(value)) fail("webhook_signature_duplicate", "provider_verification_failure");
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length !== 1) fail("webhook_signature_components_invalid", "provider_verification_failure");
  if (!/^\d{1,12}$/u.test(timestamp) || !/^[a-f0-9]{64}$/u.test(signatures[0])) {
    fail("webhook_signature_malformed", "provider_verification_failure");
  }
  return { timestamp, signature: signatures[0] };
}

function timingSafeHexEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createStripeBillingGateway(options = {}) {
  if (typeof options.request !== "function") fail("gateway_request_transport_missing", "configuration_unavailable");
  const configuration = options.configuration;
  if (!plainObject(configuration)) fail("gateway_configuration_invalid", "configuration_unavailable");
  const environment = environmentValue(configuration.environment);
  const secretKey = text(configuration.secretKey, "gateway_secret_key_missing", 255);
  const webhookSecret = text(configuration.webhookSecret, "gateway_webhook_secret_missing", 255);
  if (configuration.apiVersion !== STRIPE_BILLING_API_VERSION) fail("gateway_api_version_invalid", "configuration_unavailable");
  const timeoutMs = Number(options.timeoutMs ?? 10000);
  const timestampToleranceSeconds = Number(options.timestampToleranceSeconds ?? 300);
  const now = typeof options.now === "function" ? options.now : Date.now;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail("gateway_timeout_invalid", "configuration_unavailable");
  if (!Number.isInteger(timestampToleranceSeconds) || timestampToleranceSeconds < 1 || timestampToleranceSeconds > 3600) {
    fail("gateway_signature_tolerance_invalid", "configuration_unavailable");
  }

  async function stripeRequest(pathname, { method = "POST", form = null, idempotencyKey = "" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": STRIPE_BILLING_API_VERSION
    };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = text(idempotencyKey, "idempotency_key_invalid", 255);
    try {
      const response = await options.request(`${STRIPE_API_ORIGIN}${pathname}`, {
        method,
        headers,
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: controller.signal
      });
      if (!plainObject(response) || !Number.isInteger(response.status)) fail("provider_response_invalid");
      if (response.status < 200 || response.status >= 300) {
        const classification = response.status >= 500 || response.status === 429
          ? "provider_retryable_failure"
          : "provider_terminal_failure";
        fail("stripe_request_rejected", classification);
      }
      return safeJson(response.body, "provider_response_invalid");
    } catch (error) {
      if (error instanceof StripeBillingGatewayError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") fail("stripe_request_timeout", "ambiguous_provider_creation");
      fail("stripe_request_failed", method === "GET" ? "provider_retryable_failure" : "ambiguous_provider_creation");
    } finally {
      clearTimeout(timer);
    }
  }

  async function createCustomer(input = {}) {
    const workspaceId = text(input.workspaceId, "customer_workspace_invalid", 80);
    const payload = await stripeRequest("/v1/customers", {
      form: {
        "metadata[workspace_id]": workspaceId,
        "metadata[source]": "social-cues"
      },
      idempotencyKey: input.idempotencyKey
    });
    return Object.freeze({
      environment: providerEnvironment(payload.livemode, environment),
      customerId: providerId(payload.id, "customer", "customer_response_invalid")
    });
  }

  async function createCheckoutSession(input = {}) {
    const customerId = providerId(input.customerId, "customer", "checkout_customer_invalid");
    const priceId = providerId(input.priceId, "price", "checkout_price_invalid");
    const planId = text(input.planId, "checkout_plan_invalid", 40);
    const workspaceId = text(input.workspaceId, "checkout_workspace_invalid", 80);
    const successUrl = text(input.successUrl, "checkout_success_url_invalid");
    const cancelUrl = text(input.cancelUrl, "checkout_cancel_url_invalid");
    const payload = await stripeRequest("/v1/checkout/sessions", {
      form: {
        mode: "subscription",
        customer: customerId,
        success_url: successUrl,
        cancel_url: cancelUrl,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "metadata[workspace_id]": workspaceId,
        "metadata[plan_id]": planId,
        "subscription_data[metadata][workspace_id]": workspaceId,
        "subscription_data[metadata][plan_id]": planId
      },
      idempotencyKey: input.idempotencyKey
    });
    return Object.freeze({
      environment: providerEnvironment(payload.livemode, environment),
      checkoutSessionId: providerId(payload.id, "checkout", "checkout_response_invalid"),
      url: navigationUrl(payload.url, STRIPE_CHECKOUT_ORIGIN, "checkout_url_invalid")
    });
  }

  async function createPortalSession(input = {}) {
    const payload = await stripeRequest("/v1/billing_portal/sessions", {
      form: {
        customer: providerId(input.customerId, "customer", "portal_customer_invalid"),
        return_url: text(input.returnUrl, "portal_return_url_invalid")
      },
      idempotencyKey: input.idempotencyKey
    });
    return Object.freeze({
      environment,
      url: navigationUrl(payload.url, STRIPE_PORTAL_ORIGIN, "portal_url_invalid")
    });
  }

  async function retrieveSubscription(input = {}) {
    const subscriptionId = providerId(input.subscriptionId, "subscription", "subscription_id_invalid");
    const payload = await stripeRequest(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "GET" });
    return subscriptionProjection(payload, environment);
  }

  async function verifyWebhookEvent(input = {}) {
    if (!(input.rawBody instanceof Uint8Array)) fail("webhook_raw_bytes_required", "provider_verification_failure");
    if (input.environment !== environment || input.webhookSecret !== webhookSecret) {
      fail("webhook_environment_invalid", "provider_verification_failure");
    }
    const { timestamp, signature } = signatureParts(input.signatureHeader);
    const timestampSeconds = Number(timestamp);
    const ageSeconds = Math.abs(Number(now()) / 1000 - timestampSeconds);
    if (!Number.isFinite(ageSeconds) || ageSeconds > timestampToleranceSeconds) {
      fail("webhook_signature_timestamp_invalid", "provider_verification_failure");
    }
    const signedPayload = Buffer.concat([
      Buffer.from(`${timestamp}.`, "utf8"),
      Buffer.from(input.rawBody)
    ]);
    const expected = crypto.createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
    if (!timingSafeHexEqual(signature, expected)) fail("webhook_signature_invalid", "provider_verification_failure");
    const parsed = safeJson(Buffer.from(input.rawBody).toString("utf8"), "webhook_payload_invalid");
    providerEnvironment(parsed.livemode, environment);
    return parsed;
  }

  return Object.freeze({
    createCustomer,
    createCheckoutSession,
    createPortalSession,
    verifyWebhookEvent,
    retrieveSubscription
  });
}
