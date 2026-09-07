import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const modulePath = new URL("./stripe-billing-lifecycle.mjs", import.meta.url);
const pricingPath = new URL("./pricing-packaging.mjs", import.meta.url);
const moduleSource = await readFile(modulePath, "utf8");

let assertions = 0;
let scenarios = 0;
let mutationRejections = 0;
let fakeGatewayCalls = 0;
let fakeRepositoryCalls = 0;
let providerRequests = 0;
let productionRequests = 0;
let externalRequests = 0;
let secretsExposed = 0;
let entitlementMutations = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  externalRequests += 1;
  const target = String(input?.url || input || "");
  if (/stripe|provider/iu.test(target)) providerRequests += 1;
  if (!/localhost|127\.0\.0\.1|\[::1\]/u.test(target)) productionRequests += 1;
  throw new Error("B1 contract blocked an external request");
};

const billingModule = await import(`${modulePath.href}?contract=${Date.now()}`);
const { PRICING_CONFIGURATION, resolvePricingPlan } = await import(pricingPath.href);
const {
  STRIPE_BILLING_EVENT_TYPES,
  STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION,
  classifyStripeBillingError,
  createStripeBillingLifecycle,
  normalizeStripeBillingEvent,
  toSafeStripeBillingResult,
  validateStripeBillingConfiguration
} = billingModule;

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_C = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_A = "cus_customerA0001";
const CUSTOMER_B = "cus_customerB0001";
const SUBSCRIPTION_A = "sub_subscriptionA0001";
const SUBSCRIPTION_B = "sub_subscriptionB0001";
const SUBSCRIPTION_C = "sub_subscriptionC0001";
const SESSION_A = "cs_test_sessionA0001";
const PRICE_BUSINESS = "price_testbusiness0001";
const PRICE_GROWTH = "price_testgrowth000001";
const PRICE_AGENCY = "price_testagency000001";
const LIVE_PRICE_BUSINESS = "price_livebusiness0001";
const WEBHOOK_SECRET = ["whsec", "synthetic", "contract", "only", "0001"].join("_");
const RAW_PROVIDER_SECRET = "raw_provider_secret_contract_only";
const SIGNATURE = "t=1700000000,v1=synthetic-valid-signature";
const NOW_SECONDS = 1_700_000_000;
const NOW_MILLISECONDS = NOW_SECONDS * 1000;
const SETTLEMENT_FACTS_VERSION = "stripe-entitlement-settlement.v1";
const AUTHORITATIVE_SUBSCRIPTION_STATE = "authoritative_subscription_state";
const NON_AUTHORITATIVE_SUBSCRIPTION_CONTEXT = "non_authoritative_subscription_context";
const NO_SUBSCRIPTION_EVIDENCE = "no_subscription_evidence";
const encoder = new TextEncoder();

const pricing = Object.freeze({
  version: PRICING_CONFIGURATION.version,
  resolvePlan: resolvePricingPlan
});

const canonicalPriceMap = Object.freeze({
  business: PRICE_BUSINESS,
  growth: PRICE_GROWTH,
  agency: PRICE_AGENCY
});

const baseConfiguration = Object.freeze({
  version: STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION,
  pricingVersion: PRICING_CONFIGURATION.version,
  environment: "test",
  secretKeyPresent: true,
  webhookSecret: WEBHOOK_SECRET,
  priceIdsByPlan: canonicalPriceMap,
  applicationOrigin: "https://socialcuesapp.com",
  allowHttpLoopbackForTests: false,
  webhookClaimStaleAfterSeconds: 300
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function expect(condition, message) {
  assertions += 1;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function match(actual, pattern, message) {
  assertions += 1;
  assert.match(actual, pattern, message);
}

function doesNotMatch(actual, pattern, message) {
  assertions += 1;
  assert.doesNotMatch(actual, pattern, message);
}

async function expectError(action, classification, resultCode) {
  let captured = null;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  expect(Boolean(captured), `expected ${classification} rejection`);
  const safe = classifyStripeBillingError(captured);
  equal(safe.classification, classification, "safe error classification mismatch");
  if (resultCode) equal(safe.resultCode, resultCode, "safe error result code mismatch");
  assertSafeValue(safe, "classified error");
  return safe;
}

async function scenario(name, action) {
  scenarios += 1;
  try {
    await action();
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function mutation(name, action) {
  await action();
  mutationRejections += 1;
  expect(Boolean(name), "mutation name is required");
}

function assertSafeValue(value, label) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    WEBHOOK_SECRET,
    RAW_PROVIDER_SECRET,
    SIGNATURE,
    "private-person@example.test",
    CUSTOMER_A,
    CUSTOMER_B,
    SUBSCRIPTION_A,
    SUBSCRIPTION_B,
    SUBSCRIPTION_C
  ]) {
    if (serialized.includes(forbidden)) {
      secretsExposed += 1;
      assert.fail(`${label} exposed protected material`);
    }
    assertions += 1;
  }
  for (const forbiddenKey of [
    "webhookSecret",
    "secretKey",
    "rawBody",
    "authorization",
    "paymentMethod",
    "customerEmail",
    "settlementFacts",
    "stripeCustomerId",
    "settlementSubscriptionId"
  ]) {
    if (serialized.includes(`\"${forbiddenKey}\"`)) {
      secretsExposed += 1;
      assert.fail(`${label} exposed a forbidden field`);
    }
    assertions += 1;
  }
}

function assertFrozen(value, label) {
  expect(Object.isFrozen(value), `${label} must be frozen`);
}

function compareEventTuple(leftCreated, leftId, rightCreated, rightId) {
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  return leftId.localeCompare(rightId);
}

function createStrictRepository({ timeline = [], hooks = {}, nowSeconds = NOW_SECONDS } = {}) {
  const bindings = new Map();
  const customerOwners = new Map();
  const subscriptionOwners = new Map();
  const checkouts = new Map();
  const checkoutSessions = new Map();
  const claims = new Map();
  const calls = [];
  const state = { nowSeconds };

  const bindingKey = (environment, workspaceId) => `${environment}:${workspaceId}`;
  const providerKey = (environment, providerId) => `${environment}:${providerId}`;
  const checkoutKey = input => `${input.environment}:${input.workspaceId}:${input.idempotencyKey}`;
  const eventKey = input => `${input.environment}:${input.eventId}`;

  function record(method, input) {
    const copied = clone(input);
    calls.push({ method, input: copied });
    timeline.push(`repository:${method}`);
    fakeRepositoryCalls += 1;
    return hooks[method]?.(copied, repository, state, input);
  }

  function bindingResult(binding, resultCode, applied, subscriptionReplaced = false) {
    return {
      workspaceId: binding.workspaceId,
      environment: binding.environment,
      planId: binding.planId,
      subscriptionStatus: binding.subscriptionStatus,
      currentPeriodStart: binding.currentPeriodStart,
      currentPeriodEnd: binding.currentPeriodEnd,
      cancelAtPeriodEnd: binding.cancelAtPeriodEnd,
      applied,
      resultCode,
      subscriptionReplaced
    };
  }

  function seedBinding({
    workspaceId = WORKSPACE_A,
    environment = "test",
    customerId = CUSTOMER_A,
    subscriptionId = null,
    priceId = null,
    planId = null,
    subscriptionStatus = "not_started",
    currentPeriodStart = null,
    currentPeriodEnd = null,
    cancelAtPeriodEnd = false,
    latestEventCreated = NOW_SECONDS - 100,
    latestEventId = "evt_seed000001"
  } = {}) {
    const customerKey = providerKey(environment, customerId);
    const existingCustomerOwner = customerOwners.get(customerKey);
    if (existingCustomerOwner && existingCustomerOwner !== workspaceId) throw new Error("customer already bound");
    const binding = {
      workspaceId,
      environment,
      customerId,
      subscriptionId,
      priceId,
      planId,
      subscriptionStatus,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      latestEventCreated,
      latestEventId
    };
    bindings.set(bindingKey(environment, workspaceId), binding);
    customerOwners.set(customerKey, workspaceId);
    if (subscriptionId) subscriptionOwners.set(providerKey(environment, subscriptionId), workspaceId);
    return clone(binding);
  }

  function seedCheckout({
    workspaceId = WORKSPACE_A,
    environment = "test",
    idempotencyKey = "checkout-key-seeded-0001",
    requestedPlanId = "business",
    sessionId = SESSION_A,
    lifecycleStatus = "created",
    resultCode = "checkout_created",
    safeResult = { status: "created", resultCode: "checkout_created", planId: "business", url: "https://checkout.stripe.com/c/pay/seeded" }
  } = {}) {
    const checkout = {
      workspaceId,
      environment,
      idempotencyKey,
      requestedPlanId,
      sessionId,
      lifecycleStatus,
      resultCode,
      safeResult: clone(safeResult),
      isNew: false
    };
    checkouts.set(checkoutKey(checkout), checkout);
    if (sessionId) checkoutSessions.set(providerKey(environment, sessionId), checkout);
    return clone(checkout);
  }

  function seedClaim({
    workspaceId = WORKSPACE_A,
    environment = "test",
    eventId,
    eventType,
    status = "processing",
    attempts = 1,
    receivedAt = nowSeconds,
    resultCode = "claimed",
    safeResult = {}
  }) {
    claims.set(eventKey({ environment, eventId }), {
      workspaceId,
      environment,
      eventId,
      eventType,
      status,
      attempts,
      receivedAt,
      resultCode,
      safeResult: clone(safeResult)
    });
  }

  const repository = {
    calls,
    state,
    bindings,
    checkouts,
    claims,
    seedBinding,
    seedCheckout,
    seedClaim,
    async getBindingByWorkspace(input) {
      const override = record("getBindingByWorkspace", input);
      if (override !== undefined) return override;
      return clone(bindings.get(bindingKey(input.environment, input.workspaceId)) || null);
    },
    async getBindingByCustomer(input) {
      const override = record("getBindingByCustomer", input);
      if (override !== undefined) return override;
      const owner = customerOwners.get(providerKey(input.environment, input.customerId));
      return owner ? clone(bindings.get(bindingKey(input.environment, owner))) : null;
    },
    async getBindingBySubscription(input) {
      const override = record("getBindingBySubscription", input);
      if (override !== undefined) return override;
      const owner = subscriptionOwners.get(providerKey(input.environment, input.subscriptionId));
      return owner ? clone(bindings.get(bindingKey(input.environment, owner))) : null;
    },
    async getCheckoutBySession(input) {
      const override = record("getCheckoutBySession", input);
      if (override !== undefined) return override;
      return clone(checkoutSessions.get(providerKey(input.environment, input.sessionId)) || null);
    },
    async reserveCheckout(input) {
      const override = record("reserveCheckout", input);
      if (override !== undefined) return override;
      const key = checkoutKey(input);
      const existing = checkouts.get(key);
      if (existing) return { ...clone(existing), isNew: false };
      const checkout = {
        ...clone(input),
        sessionId: null,
        lifecycleStatus: "reserved",
        resultCode: "reserved",
        safeResult: {},
        isNew: true
      };
      checkouts.set(key, checkout);
      return clone(checkout);
    },
    async bindCheckoutSession(input) {
      const override = record("bindCheckoutSession", input);
      if (override !== undefined) return override;
      const key = checkoutKey(input);
      const checkout = checkouts.get(key);
      if (!checkout || checkout.requestedPlanId !== input.requestedPlanId) throw new Error("checkout reservation mismatch");
      if (checkout.sessionId && checkout.sessionId !== input.sessionId) throw new Error("checkout session immutable");
      Object.assign(checkout, clone(input), { isNew: false });
      checkoutSessions.set(providerKey(input.environment, input.sessionId), checkout);
      return clone(checkout);
    },
    async markCheckoutReconciliationRequired(input) {
      const override = record("markCheckoutReconciliationRequired", input);
      if (override !== undefined) return override;
      const checkout = checkouts.get(checkoutKey(input));
      if (!checkout) throw new Error("checkout reservation missing");
      Object.assign(checkout, clone(input), { isNew: false });
      return clone(checkout);
    },
    async claimWebhookEvent(input) {
      const override = record("claimWebhookEvent", input);
      if (override !== undefined) return override;
      const key = eventKey(input);
      const existing = claims.get(key);
      if (!existing) {
        const claim = { ...clone(input), status: "processing", attempts: 1, receivedAt: state.nowSeconds, resultCode: "claimed", safeResult: {} };
        claims.set(key, claim);
        return { claimed: true, duplicate: false, eventStatus: "processing", eventAttempts: 1, resultCode: "claimed" };
      }
      if (existing.workspaceId !== input.workspaceId || existing.environment !== input.environment || existing.eventType !== input.eventType) {
        throw new Error("webhook claim conflict");
      }
      if (existing.status === "complete") {
        return { claimed: false, duplicate: true, eventStatus: "complete", eventAttempts: existing.attempts, resultCode: "already_complete" };
      }
      if (existing.status === "processing" && existing.receivedAt >= state.nowSeconds - input.staleAfterSeconds) {
        return { claimed: false, duplicate: true, eventStatus: "processing", eventAttempts: existing.attempts, resultCode: "already_claimed" };
      }
      existing.status = "processing";
      existing.attempts += 1;
      existing.receivedAt = state.nowSeconds;
      existing.resultCode = "reclaimed";
      existing.safeResult = {};
      return { claimed: true, duplicate: false, eventStatus: "processing", eventAttempts: existing.attempts, resultCode: "reclaimed" };
    },
    async getWebhookResult(input) {
      const override = record("getWebhookResult", input);
      if (override !== undefined) return override;
      return clone(claims.get(eventKey(input))?.safeResult || null);
    },
    async completeWebhookEvent(input) {
      const override = record("completeWebhookEvent", input);
      if (override !== undefined) return override;
      const claim = claims.get(eventKey(input));
      if (!claim || claim.workspaceId !== input.workspaceId || claim.eventType !== input.eventType) throw new Error("webhook completion conflict");
      claim.status = "complete";
      claim.resultCode = input.resultCode;
      claim.safeResult = clone(input.safeResult);
      return { completed: true };
    },
    async failWebhookEvent(input) {
      const override = record("failWebhookEvent", input);
      if (override !== undefined) return override;
      const claim = claims.get(eventKey(input));
      if (!claim) throw new Error("webhook failure claim missing");
      claim.status = "failed";
      claim.resultCode = input.resultCode;
      claim.retryable = input.retryable;
      return { failed: true };
    },
    async reconcileBinding(input) {
      const override = record("reconcileBinding", input);
      if (override !== undefined) return override;
      const key = bindingKey(input.environment, input.workspaceId);
      const existing = bindings.get(key);
      const customerOwner = customerOwners.get(providerKey(input.environment, input.customerId));
      if (customerOwner && customerOwner !== input.workspaceId) throw new Error("customer already bound");
      if (!existing) {
        const created = {
          ...clone(input),
          latestEventCreated: input.eventCreated,
          latestEventId: input.eventId
        };
        bindings.set(key, created);
        customerOwners.set(providerKey(input.environment, input.customerId), input.workspaceId);
        if (input.subscriptionId) subscriptionOwners.set(providerKey(input.environment, input.subscriptionId), input.workspaceId);
        return bindingResult(created, "created", true, false);
      }
      if (existing.customerId !== input.customerId) throw new Error("customer change rejected");
      if (compareEventTuple(input.eventCreated, input.eventId, existing.latestEventCreated, existing.latestEventId) <= 0) {
        return bindingResult(existing, "replayed_or_stale", false, false);
      }
      const previousSubscriptionId = existing.subscriptionId;
      if (previousSubscriptionId) subscriptionOwners.delete(providerKey(input.environment, previousSubscriptionId));
      Object.assign(existing, clone(input), {
        latestEventCreated: input.eventCreated,
        latestEventId: input.eventId
      });
      if (input.subscriptionId) subscriptionOwners.set(providerKey(input.environment, input.subscriptionId), input.workspaceId);
      const subscriptionReplaced = previousSubscriptionId !== input.subscriptionId;
      const terminal = ["not_started", "incomplete_expired", "canceled", "unpaid"].includes(input.subscriptionStatus);
      const resultCode = terminal
        ? "current_subscription_cleared"
        : subscriptionReplaced
          ? "current_subscription_replaced"
          : "current_subscription_updated";
      return bindingResult(existing, resultCode, true, subscriptionReplaced);
    }
  };

  return repository;
}

function createStrictGateway({ timeline = [], hooks = {}, environment = "test" } = {}) {
  const calls = [];
  const subscriptions = new Map();
  const state = { checkoutCount: 0, customerCount: 0, portalCount: 0, parseCount: 0, verificationCount: 0 };

  function record(method, input) {
    const copied = clone(input);
    calls.push({ method, input: copied });
    timeline.push(`gateway:${method}`);
    fakeGatewayCalls += 1;
    return hooks[method]?.(copied, gateway, state);
  }

  const gateway = {
    calls,
    state,
    subscriptions,
    async createCustomer(input) {
      const override = await record("createCustomer", input);
      if (override !== undefined) return override;
      state.customerCount += 1;
      return { environment, customerId: `cus_generated${String(state.customerCount).padStart(6, "0")}` };
    },
    async createCheckoutSession(input) {
      const override = await record("createCheckoutSession", input);
      if (override !== undefined) return override;
      state.checkoutCount += 1;
      return {
        environment,
        checkoutSessionId: `cs_test_generated${String(state.checkoutCount).padStart(6, "0")}`,
        url: `https://checkout.stripe.com/c/pay/generated-${state.checkoutCount}`
      };
    },
    async createPortalSession(input) {
      const override = await record("createPortalSession", input);
      if (override !== undefined) return override;
      state.portalCount += 1;
      return { environment, url: `https://billing.stripe.com/p/session/generated-${state.portalCount}` };
    },
    async verifyWebhookEvent(input) {
      const override = await record("verifyWebhookEvent", input);
      if (override !== undefined) return override;
      state.verificationCount += 1;
      if (input.signatureHeader !== SIGNATURE || input.webhookSecret !== WEBHOOK_SECRET) {
        throw new Error(`${RAW_PROVIDER_SECRET}:${input.signatureHeader}`);
      }
      state.parseCount += 1;
      return JSON.parse(new TextDecoder().decode(input.rawBody));
    },
    async retrieveSubscription(input) {
      const override = await record("retrieveSubscription", input);
      if (override !== undefined) return override;
      const subscription = subscriptions.get(input.subscriptionId);
      if (!subscription) throw new Error(`${RAW_PROVIDER_SECRET}:subscription missing`);
      return clone(subscription);
    }
  };

  return gateway;
}

function mergedConfiguration(overrides = {}) {
  return {
    ...baseConfiguration,
    ...clone(overrides),
    priceIdsByPlan: overrides.priceIdsByPlan === undefined
      ? clone(canonicalPriceMap)
      : clone(overrides.priceIdsByPlan)
  };
}

function createFixture({ configuration = {}, gatewayHooks = {}, repositoryHooks = {}, repository, gateway } = {}) {
  const timeline = [];
  const strictRepository = repository || createStrictRepository({ timeline, hooks: repositoryHooks });
  const strictGateway = gateway || createStrictGateway({ timeline, hooks: gatewayHooks });
  let generatedEvent = 0;
  const service = createStripeBillingLifecycle({
    configuration: mergedConfiguration(configuration),
    pricing,
    gateway: strictGateway,
    repository: strictRepository,
    clock: () => NOW_MILLISECONDS,
    generateEventId: () => `evt_generated${String(++generatedEvent).padStart(6, "0")}`
  });
  return { service, gateway: strictGateway, repository: strictRepository, timeline };
}

function authorizedContext(workspaceId = WORKSPACE_A, overrides = {}) {
  return {
    authorization: "workspace_billing_manage",
    workspaceId,
    successUrl: "https://socialcuesapp.com/portal?checkout=success",
    cancelUrl: "https://socialcuesapp.com/portal?checkout=cancelled",
    returnUrl: "https://socialcuesapp.com/portal?billing=return",
    ...overrides
  };
}

function checkoutOperation(overrides = {}) {
  return {
    context: authorizedContext(),
    request: { planId: "business", idempotencyKey: "checkout-contract-key-0001" },
    ...clone(overrides)
  };
}

function subscriptionObject({
  id = SUBSCRIPTION_A,
  customer = CUSTOMER_A,
  priceId = PRICE_BUSINESS,
  status = "active",
  periodStart = NOW_SECONDS,
  periodEnd = NOW_SECONDS + 2_592_000,
  cancelAtPeriodEnd = false,
  environment = "test",
  metadata = {}
} = {}) {
  return {
    id,
    environment,
    customer,
    status,
    items: { data: priceId ? [{ price: { id: priceId } }] : [] },
    current_period_start: periodStart,
    current_period_end: periodEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    metadata: clone(metadata)
  };
}

function checkoutObject({
  id = SESSION_A,
  customer = CUSTOMER_A,
  subscription = SUBSCRIPTION_A,
  paymentStatus = "paid",
  environment = "test",
  workspaceId = WORKSPACE_A,
  planId = "business"
} = {}) {
  return {
    id,
    environment,
    customer,
    subscription,
    payment_status: paymentStatus,
    client_reference_id: workspaceId,
    metadata: { social_cues_workspace_id: workspaceId, plan_id: planId }
  };
}

function invoiceObject({
  id = "in_invoice000001",
  customer = CUSTOMER_A,
  subscription = SUBSCRIPTION_A,
  environment = "test"
} = {}) {
  return { id, environment, customer, subscription };
}

function incidentObject({
  id = "ch_charge000001",
  customer = CUSTOMER_A,
  environment = "test",
  amount = 1000,
  amountRefunded = 1000,
  status
} = {}) {
  return { id, environment, customer, amount, amount_refunded: amountRefunded, status };
}

function stripeEvent(type, object, { id = "evt_event000001", created = NOW_SECONDS + 10, environment = "test" } = {}) {
  return { id, type, created, environment, data: { object: clone(object) } };
}

function webhookInput(event, overrides = {}) {
  return {
    rawBody: encoder.encode(JSON.stringify(event)),
    signatureHeader: SIGNATURE,
    expectedEnvironment: event.environment,
    ...overrides
  };
}

async function deliver(fixture, event, overrides = {}) {
  return fixture.service.handleWebhook(webhookInput(event, overrides));
}

function completionCalls(fixture) {
  return fixture.repository.calls.filter(call => call.method === "completeWebhookEvent");
}

function assertPrivateSettlementAbsent(value, label) {
  const serialized = JSON.stringify(value);
  for (const key of ["settlementFacts", "stripeCustomerId", "settlementSubscriptionId"]) {
    doesNotMatch(serialized, new RegExp(`"${key}"`, "u"), `${label} exposed ${key}`);
  }
  for (const providerId of [CUSTOMER_A, CUSTOMER_B, SUBSCRIPTION_A, SUBSCRIPTION_B, SUBSCRIPTION_C]) {
    doesNotMatch(serialized, new RegExp(providerId, "u"), `${label} exposed a private provider identifier`);
  }
  assertSafeValue(value, label);
}

function assertSettlementCompletion(fixture, {
  decision,
  eventCreated,
  settlementSubscriptionId,
  evidence,
  stripeCustomerId = CUSTOMER_A,
  callIndex = completionCalls(fixture).length - 1,
  label = "webhook completion"
}) {
  const call = completionCalls(fixture)[callIndex];
  expect(Boolean(call), `${label} call is missing`);
  deepEqual(Object.keys(call.input).sort(), [
    "environment",
    "eventId",
    "eventType",
    "resultCode",
    "safeResult",
    "settlementFacts",
    "workspaceId"
  ], `${label} changed existing completion fields`);
  const facts = call.input.settlementFacts;
  deepEqual(Object.keys(facts).sort(), [
    "eventCreated",
    "evidence",
    "settlementSubscriptionId",
    "stripeCustomerId",
    "version"
  ], `${label} private fact shape changed`);
  equal(facts.version, SETTLEMENT_FACTS_VERSION, `${label} version mismatch`);
  equal(facts.eventCreated, eventCreated, `${label} eventCreated mismatch`);
  equal(facts.stripeCustomerId, stripeCustomerId, `${label} customer mismatch`);
  equal(facts.settlementSubscriptionId, settlementSubscriptionId, `${label} subscription mismatch`);
  equal(facts.evidence, evidence, `${label} evidence mismatch`);
  expect([
    AUTHORITATIVE_SUBSCRIPTION_STATE,
    NON_AUTHORITATIVE_SUBSCRIPTION_CONTEXT,
    NO_SUBSCRIPTION_EVIDENCE
  ].includes(facts.evidence), `${label} evidence is unbounded`);
  equal(call.input.resultCode, decision.resultCode, `${label} result code changed`);
  deepEqual(call.input.safeResult, toSafeStripeBillingResult(decision), `${label} safe result changed`);
  assertPrivateSettlementAbsent(call.input.safeResult, `${label} persisted safe result`);
  assertPrivateSettlementAbsent(decision, `${label} lifecycle result`);
  const serialized = JSON.stringify(call.input);
  for (const forbidden of [WEBHOOK_SECRET, RAW_PROVIDER_SECRET, SIGNATURE, "private-person@example.test"]) {
    doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `${label} exposed protected material`);
  }
  for (const forbiddenKey of ["rawBody", "rawEvent", "signatureHeader", "webhookSecret", "paymentMethod", "customerEmail", "data"]) {
    doesNotMatch(serialized, new RegExp(`"${forbiddenKey}"`, "u"), `${label} carried ${forbiddenKey}`);
  }
  return call;
}

function seedCustomerBinding(repository, options = {}) {
  return repository.seedBinding({
    workspaceId: WORKSPACE_A,
    environment: "test",
    customerId: CUSTOMER_A,
    latestEventCreated: NOW_SECONDS - 100,
    latestEventId: "evt_seed000001",
    ...options
  });
}

function sourceArchitectureViolations(source) {
  const violations = [];
  const importedSpecifiers = [...source.matchAll(/\b(?:from\s+|import\s*\()(["'])([^"']+)\1/gu)].map(matchValue => matchValue[2]);
  if (importedSpecifiers.some(specifier => !specifier.startsWith("node:"))) violations.push("non-node import");
  const policies = [
    [/\bprocess\s*\.\s*env\b/u, "process.env"],
    [/(?:\bglobalThis\s*\.\s*)?\bfetch\s*\(/u, "global fetch"],
    [/\bnew\s+Stripe\b/u, "hidden Stripe client"],
    [/api\.stripe\.com/iu, "Stripe HTTP endpoint"],
    [/\b(?:supabase|postgrest)\b/iu, "Supabase client"],
    [/billing[_-]?entitlements|activateWorkspace|revokeWorkspace|grantCredits/iu, "entitlement mutation"],
    [/social-cues-app\.html|from\s+["'][^"']*server\.mjs/u, "application import"],
    [/node:(?:http|https|net|tls|fs)(?:["'/]|$)/u, "I/O built-in"]
  ];
  for (const [pattern, name] of policies) if (pattern.test(source)) violations.push(name);
  return violations;
}

await scenario("source architecture and import purity", async () => {
  deepEqual(Object.keys(billingModule).sort(), [
    "STRIPE_BILLING_EVENT_TYPES",
    "STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION",
    "classifyStripeBillingError",
    "createStripeBillingLifecycle",
    "normalizeStripeBillingEvent",
    "toSafeStripeBillingResult",
    "validateStripeBillingConfiguration"
  ], "module export surface changed");
  deepEqual(sourceArchitectureViolations(moduleSource), [], "module crossed the pure B1 boundary");
  equal(externalRequests, 0, "module import must not request external resources");
  equal(providerRequests, 0, "module import must not request provider resources");
  equal(productionRequests, 0, "module import must not request production resources");
  equal(STRIPE_BILLING_EVENT_TYPES.length, 10, "supported event count changed");
  assertFrozen(STRIPE_BILLING_EVENT_TYPES, "event inventory");
  doesNotMatch(moduleSource, /console\.|authorization[_-]?header|payment_method|card_number/iu, "module contains unsafe logging or payment fields");
});

await scenario("configuration is exact, versioned, immutable, and public-safe", async () => {
  const input = mergedConfiguration();
  const before = clone(input);
  const result = validateStripeBillingConfiguration(input, pricing);
  deepEqual(input, before, "configuration input was mutated");
  equal(result.ok, true);
  equal(result.version, STRIPE_BILLING_LIFECYCLE_CONFIGURATION_VERSION);
  equal(result.pricingVersion, PRICING_CONFIGURATION.version);
  deepEqual(result.canonicalPlanIds, ["business", "growth", "agency"]);
  equal(result.environment, "test");
  equal(result.webhookSecretPresent, true);
  equal("webhookSecret" in result, false);
  equal("priceIdsByPlan" in result, false);
  assertFrozen(result, "validated configuration");
  assertFrozen(result.canonicalPlanIds, "canonical plan IDs");
  assertSafeValue(result, "validated configuration");

  const invalidCases = [
    [{ version: undefined }, "configuration_version_unsupported"],
    [{ version: "stripe-billing-lifecycle-v0" }, "configuration_version_unsupported"],
    [{ environment: undefined }, "stripe_environment_invalid"],
    [{ environment: "automatic" }, "stripe_environment_invalid"],
    [{ pricingVersion: "stale" }, "pricing_configuration_version_mismatch"],
    [{ secretKeyPresent: false }, "stripe_secret_key_missing"],
    [{ webhookSecret: "" }, "stripe_webhook_secret_missing"],
    [{ webhookSecret: "too-short" }, "stripe_webhook_secret_invalid"],
    [{ priceIdsByPlan: { business: PRICE_BUSINESS, growth: PRICE_GROWTH } }, "stripe_price_mapping_incomplete"],
    [{ priceIdsByPlan: { ...canonicalPriceMap, enterprise: "price_enterprise000001" } }, "stripe_price_mapping_incomplete"],
    [{ priceIdsByPlan: { ...canonicalPriceMap, growth: PRICE_BUSINESS } }, "stripe_price_mapping_duplicate"],
    [{ priceIdsByPlan: { ...canonicalPriceMap, business: "not-a-price" } }, "stripe_price_id_invalid"],
    [{ applicationOrigin: "http://socialcuesapp.com" }, "application_origin_invalid"],
    [{ applicationOrigin: "https://user:pass@socialcuesapp.com" }, "application_origin_invalid"],
    [{ applicationOrigin: "https://socialcuesapp.com/path" }, "application_origin_invalid"],
    [{ applicationOrigin: "https://socialcuesapp.com/#fragment" }, "application_origin_invalid"],
    [{ webhookClaimStaleAfterSeconds: 0 }, "webhook_claim_window_invalid"],
    [{ webhookClaimStaleAfterSeconds: 3601 }, "webhook_claim_window_invalid"],
    [{ allowHttpLoopbackForTests: "yes" }, "loopback_policy_invalid"],
    [{ apiKey: "generic-fallback" }, "configuration_field_unknown"],
    [{ stripeSecretKey: "generic-fallback" }, "configuration_field_unknown"],
    [{ paymentLink: "https://buy.stripe.com/unsafe" }, "configuration_field_unknown"]
  ];
  for (const [overrides, resultCode] of invalidCases) {
    await expectError(
      () => validateStripeBillingConfiguration(mergedConfiguration(overrides), pricing),
      "configuration_unavailable",
      resultCode
    );
  }
  await expectError(
    () => validateStripeBillingConfiguration(mergedConfiguration({
      environment: "live",
      applicationOrigin: "http://localhost:3000",
      allowHttpLoopbackForTests: true
    }), pricing),
    "configuration_unavailable",
    "loopback_policy_invalid"
  );
  const loopback = validateStripeBillingConfiguration(mergedConfiguration({
    applicationOrigin: "http://127.0.0.1:3000",
    allowHttpLoopbackForTests: true
  }), pricing);
  equal(loopback.applicationOrigin, "http://127.0.0.1:3000");

  const retiredPricing = {
    version: pricing.version,
    resolvePlan(planId) {
      return planId === "agency" ? { ok: false, reason: "retired" } : resolvePricingPlan(planId);
    }
  };
  await expectError(
    () => validateStripeBillingConfiguration(mergedConfiguration(), retiredPricing),
    "configuration_unavailable",
    "canonical_pricing_resolution_failed"
  );
});

await scenario("checkout rejects authority and browser payment mutations before effects", async () => {
  const fixture = createFixture();
  await expectError(
    () => fixture.service.prepareCheckout({
      context: { ...authorizedContext(), authorization: "workspace_view" },
      request: { planId: "business", idempotencyKey: "checkout-contract-key-0001" }
    }),
    "unauthorized_workspace",
    "workspace_billing_authorization_required"
  );
  await expectError(
    () => fixture.service.prepareCheckout({
      context: { ...authorizedContext(), workspaceId: WORKSPACE_B },
      request: { planId: "retired", idempotencyKey: "checkout-contract-key-0001" }
    }),
    "unsupported_plan",
    "canonical_plan_required"
  );
  for (const field of ["amount", "currency", "priceId", "productId", "paymentLink", "customerId", "subscriptionId", "successUrl", "cancelUrl", "workspaceId", "environment"]) {
    await expectError(
      () => fixture.service.prepareCheckout({
        context: authorizedContext(),
        request: { planId: "business", idempotencyKey: "checkout-contract-key-0001", [field]: "attacker-controlled" }
      }),
      "invalid_request",
      "invalid_request"
    );
  }
  equal(fixture.gateway.calls.length, 0, "rejected checkout input reached the gateway");
  equal(fixture.repository.calls.length, 0, "rejected checkout input reached the repository");
});

await scenario("checkout enforces exact application URL policy", async () => {
  const unsafeUrls = [
    "http://socialcuesapp.com/portal",
    "//socialcuesapp.com/portal",
    "javascript:alert(1)",
    "https://socialcuesapp.com.evil.example/portal",
    "https://evil.example/portal?next=https://socialcuesapp.com",
    "https://socialcuesapp.com/portal?next=https%3A%2F%2Fevil.example%2Fsteal",
    "https://socialcuesapp.com/portal?redirect=%2F%2Fevil.example%2Fsteal",
    "https://user:pass@socialcuesapp.com/portal",
    "https://socialcuesapp.com/portal#fragment"
  ];
  for (const unsafeUrl of unsafeUrls) {
    const fixture = createFixture();
    await expectError(
      () => fixture.service.prepareCheckout(checkoutOperation({
        context: authorizedContext(WORKSPACE_A, { successUrl: unsafeUrl })
      })),
      "invalid_request",
      "success_url_invalid"
    );
    equal(fixture.gateway.calls.length, 0);
    equal(fixture.repository.calls.length, 0);
  }
  const fixture = createFixture();
  await expectError(
    () => fixture.service.prepareCheckout(checkoutOperation({
      context: authorizedContext(WORKSPACE_A, { cancelUrl: "https://lookalike-socialcuesapp.com/portal" })
    })),
    "invalid_request",
    "cancel_url_invalid"
  );
});

await scenario("checkout reserves, binds durable customer, creates once, and returns safe data", async () => {
  const fixture = createFixture();
  const operation = checkoutOperation();
  const before = clone(operation);
  const result = await fixture.service.prepareCheckout(operation);
  deepEqual(operation, before, "checkout input was mutated");
  equal(result.ok, true);
  equal(result.status, "created");
  equal(result.planId, "business");
  match(result.checkoutSessionId, /^cs_test_/u);
  match(result.url, /^https:\/\/checkout\.stripe\.com\//u);
  equal("customerId" in result, false);
  equal("priceId" in result, false);
  equal("workspaceId" in result, false);
  assertFrozen(result, "checkout result");
  assertSafeValue(result, "checkout result");
  deepEqual(fixture.timeline, [
    "repository:reserveCheckout",
    "repository:getBindingByWorkspace",
    "gateway:createCustomer",
    "repository:reconcileBinding",
    "gateway:createCheckoutSession",
    "repository:bindCheckoutSession"
  ], "checkout call order changed");
  const checkoutCall = fixture.gateway.calls.find(call => call.method === "createCheckoutSession");
  equal(checkoutCall.input.workspaceId, WORKSPACE_A);
  equal(checkoutCall.input.planId, "business");
  equal(checkoutCall.input.priceId, PRICE_BUSINESS);
  equal(checkoutCall.input.environment, "test");
  equal(checkoutCall.input.configuration.environment, "test");
  equal("amount" in checkoutCall.input, false);
  equal("currency" in checkoutCall.input, false);
  equal("paymentLink" in checkoutCall.input, false);
  const reserveIndex = fixture.timeline.indexOf("repository:reserveCheckout");
  const createIndex = fixture.timeline.indexOf("gateway:createCheckoutSession");
  const bindIndex = fixture.timeline.indexOf("repository:bindCheckoutSession");
  expect(reserveIndex < createIndex && createIndex < bindIndex, "checkout durability order is unsafe");

  const replay = await fixture.service.prepareCheckout(operation);
  equal(replay.status, "reused");
  equal(replay.checkoutSessionId, result.checkoutSessionId);
  equal(replay.duplicate, true);
  equal(fixture.gateway.calls.filter(call => call.method === "createCheckoutSession").length, 1);
  equal(fixture.gateway.calls.filter(call => call.method === "createCustomer").length, 1);
  assertSafeValue(replay, "checkout replay");
});

await scenario("checkout idempotency conflicts and existing subscriptions fail closed", async () => {
  const fixture = createFixture();
  await fixture.service.prepareCheckout(checkoutOperation());
  await expectError(
    () => fixture.service.prepareCheckout(checkoutOperation({
      request: { planId: "growth", idempotencyKey: "checkout-contract-key-0001" }
    })),
    "idempotency_conflict",
    "checkout_reservation_conflict"
  );
  equal(fixture.gateway.calls.filter(call => call.method === "createCheckoutSession").length, 1);

  const subscribed = createFixture();
  seedCustomerBinding(subscribed.repository, {
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active"
  });
  await expectError(
    () => subscribed.service.prepareCheckout(checkoutOperation()),
    "idempotency_conflict",
    "current_subscription_exists"
  );
  equal(subscribed.gateway.calls.length, 0);
});

await scenario("ambiguous checkout creation is recorded and never retried", async () => {
  const fixture = createFixture({
    gatewayHooks: {
      createCheckoutSession() {
        const error = new Error(RAW_PROVIDER_SECRET);
        error.ambiguous = true;
        throw error;
      }
    }
  });
  seedCustomerBinding(fixture.repository);
  const first = await fixture.service.prepareCheckout(checkoutOperation());
  equal(first.ok, false);
  equal(first.status, "reconciliation_required");
  equal(first.classification, "ambiguous_provider_creation");
  equal(first.retryable, false);
  assertSafeValue(first, "ambiguous checkout result");
  const replay = await fixture.service.prepareCheckout(checkoutOperation());
  equal(replay.status, "reconciliation_required");
  equal(fixture.gateway.calls.filter(call => call.method === "createCheckoutSession").length, 1);
  equal(fixture.repository.calls.filter(call => call.method === "markCheckoutReconciliationRequired").length, 1);
  assertSafeValue(replay, "ambiguous checkout replay");
});

await scenario("ambiguous customer creation is recorded and never retried", async () => {
  const fixture = createFixture({
    gatewayHooks: {
      createCustomer() {
        const error = new Error(RAW_PROVIDER_SECRET);
        error.outcome = "ambiguous";
        throw error;
      }
    }
  });
  const first = await fixture.service.prepareCheckout(checkoutOperation());
  equal(first.status, "reconciliation_required");
  equal(first.resultCode, "customer_creation_ambiguous");
  equal(first.classification, "ambiguous_provider_creation");
  const replay = await fixture.service.prepareCheckout(checkoutOperation());
  equal(replay.status, "reconciliation_required");
  equal(fixture.gateway.calls.filter(call => call.method === "createCustomer").length, 1);
  equal(fixture.gateway.calls.filter(call => call.method === "createCheckoutSession").length, 0);
  assertSafeValue(first, "ambiguous customer result");
});

await scenario("checkout rejects malformed provider output and sanitizes failures", async () => {
  const unsafeOutputs = [
    { environment: "live", checkoutSessionId: SESSION_A, url: "https://checkout.stripe.com/c/pay/x" },
    { environment: "test", checkoutSessionId: "bad-session", url: "https://checkout.stripe.com/c/pay/x" },
    { environment: "test", checkoutSessionId: SESSION_A, url: "https://checkout.stripe.com.evil.example/c/pay/x" },
    { environment: "test", checkoutSessionId: SESSION_A, url: "http://checkout.stripe.com/c/pay/x" },
    { environment: "test", checkoutSessionId: SESSION_A, url: "https://user:pass@checkout.stripe.com/c/pay/x" },
    { environment: "test", checkoutSessionId: SESSION_A, url: "https://checkout.stripe.com/c/pay/x#fragment" }
  ];
  for (const output of unsafeOutputs) {
    const fixture = createFixture({ gatewayHooks: { createCheckoutSession: () => clone(output) } });
    seedCustomerBinding(fixture.repository);
    const safe = await expectError(
      () => fixture.service.prepareCheckout(checkoutOperation()),
      "provider_terminal_failure"
    );
    assertSafeValue(safe, "malformed checkout failure");
  }

  const retryable = createFixture({
    gatewayHooks: {
      createCheckoutSession() {
        const error = new Error(RAW_PROVIDER_SECRET);
        error.retryable = true;
        throw error;
      }
    }
  });
  seedCustomerBinding(retryable.repository);
  await expectError(
    () => retryable.service.prepareCheckout(checkoutOperation()),
    "provider_retryable_failure",
    "create_checkout_session_retryable"
  );

  const unavailable = createFixture({ repositoryHooks: { reserveCheckout: () => { throw new Error("raw SQL details"); } } });
  await expectError(
    () => unavailable.service.prepareCheckout(checkoutOperation()),
    "repository_unavailable",
    "reserve_checkout_repository_unavailable"
  );
});

await scenario("portal uses only the durable customer and one validated provider URL", async () => {
  const fixture = createFixture();
  await expectError(
    () => fixture.service.preparePortal({
      context: authorizedContext(),
      request: { idempotencyKey: "portal-contract-key-0001" }
    }),
    "reconciliation_required",
    "stripe_customer_binding_missing"
  );
  equal(fixture.gateway.calls.length, 0);

  seedCustomerBinding(fixture.repository);
  await expectError(
    () => fixture.service.preparePortal({
      context: authorizedContext(),
      request: { idempotencyKey: "portal-contract-key-0002", customerId: CUSTOMER_B }
    }),
    "invalid_request",
    "invalid_request"
  );
  const result = await fixture.service.preparePortal({
    context: authorizedContext(),
    request: { idempotencyKey: "portal-contract-key-0003" }
  });
  equal(result.ok, true);
  equal(result.status, "created");
  match(result.url, /^https:\/\/billing\.stripe\.com\//u);
  equal("customerId" in result, false);
  equal(fixture.gateway.calls.filter(call => call.method === "createPortalSession").length, 1);
  const portalCall = fixture.gateway.calls.find(call => call.method === "createPortalSession");
  equal(portalCall.input.customerId, CUSTOMER_A);
  equal(portalCall.input.environment, "test");
  assertFrozen(result, "portal result");
  assertSafeValue(result, "portal result");
});

await scenario("portal rejects unsafe return and provider navigation URLs", async () => {
  const unsafeReturn = createFixture();
  seedCustomerBinding(unsafeReturn.repository);
  await expectError(
    () => unsafeReturn.service.preparePortal({
      context: authorizedContext(WORKSPACE_A, { returnUrl: "https://socialcuesapp.com.evil.example/portal" }),
      request: { idempotencyKey: "portal-contract-key-0001" }
    }),
    "invalid_request",
    "return_url_invalid"
  );
  equal(unsafeReturn.gateway.calls.length, 0);

  for (const url of [
    "https://billing.stripe.com.evil.example/p/session/x",
    "http://billing.stripe.com/p/session/x",
    "https://user:pass@billing.stripe.com/p/session/x",
    "https://billing.stripe.com/p/session/x#fragment"
  ]) {
    const fixture = createFixture({ gatewayHooks: { createPortalSession: () => ({ environment: "test", url }) } });
    seedCustomerBinding(fixture.repository);
    await expectError(
      () => fixture.service.preparePortal({
        context: authorizedContext(),
        request: { idempotencyKey: "portal-contract-key-0001" }
      }),
      "provider_terminal_failure",
      "portal_url_invalid"
    );
  }
});

await scenario("webhook requires raw bytes, signature, and exact environment before interpretation", async () => {
  const fixture = createFixture();
  const event = stripeEvent("customer.subscription.updated", subscriptionObject());
  await expectError(
    () => fixture.service.handleWebhook({ rawBody: JSON.stringify(event), signatureHeader: SIGNATURE, expectedEnvironment: "test" }),
    "invalid_request",
    "webhook_raw_bytes_required"
  );
  await expectError(
    () => fixture.service.handleWebhook({ rawBody: encoder.encode(JSON.stringify(event)), expectedEnvironment: "test" }),
    "provider_verification_failure",
    "webhook_signature_required"
  );
  await expectError(
    () => fixture.service.handleWebhook({ rawBody: encoder.encode(JSON.stringify(event)), signatureHeader: SIGNATURE, expectedEnvironment: "live" }),
    "provider_verification_failure",
    "webhook_environment_mismatch"
  );
  equal(fixture.gateway.calls.length, 0, "invalid webhook envelope reached verifier");

  const malformed = encoder.encode(`{\"private\":\"${RAW_PROVIDER_SECRET}\"`);
  const invalidSafe = await expectError(
    () => fixture.service.handleWebhook({ rawBody: malformed, signatureHeader: "bad-signature", expectedEnvironment: "test" }),
    "provider_verification_failure",
    "webhook_signature_invalid"
  );
  equal(fixture.gateway.state.parseCount, 0, "invalid signature body was parsed");
  equal(fixture.repository.calls.length, 0, "invalid signature reached persistence");
  assertSafeValue(invalidSafe, "signature failure");
});

await scenario("verified unknown events are ignored without ownership or state calls", async () => {
  const fixture = createFixture();
  const result = await deliver(fixture, stripeEvent("customer.unrelated", { id: CUSTOMER_A, environment: "test" }));
  equal(result.status, "ignored");
  equal(result.resultCode, "event_type_ignored");
  equal(result.entitlementActionRequired, false);
  equal(fixture.gateway.state.verificationCount, 1);
  equal(fixture.gateway.state.parseCount, 1);
  equal(fixture.repository.calls.length, 0);
  assertSafeValue(result, "ignored webhook result");
});

await scenario("metadata and provider identifiers cannot establish workspace authority", async () => {
  const metadataOnly = createFixture();
  const event = stripeEvent("customer.subscription.updated", subscriptionObject({
    customer: "cus_unmapped00001",
    id: "sub_unmapped00001",
    metadata: { social_cues_workspace_id: WORKSPACE_B, plan_id: "business" }
  }));
  const result = await deliver(metadataOnly, event);
  equal(result.status, "ownership_unresolved");
  equal(result.entitlementActionRequired, false);
  equal(metadataOnly.repository.calls.some(call => call.method === "claimWebhookEvent"), false);
  equal(metadataOnly.repository.calls.some(call => call.method === "reconcileBinding"), false);

  const mismatch = createFixture();
  seedCustomerBinding(mismatch.repository);
  await expectError(
    () => deliver(mismatch, stripeEvent("customer.subscription.updated", subscriptionObject({
      metadata: { social_cues_workspace_id: WORKSPACE_B, plan_id: "business" }
    }), { id: "evt_metadata000001" })),
    "ownership_mismatch",
    "stripe_metadata_workspace_mismatch"
  );
  equal(mismatch.repository.calls.some(call => call.method === "claimWebhookEvent"), false);
});

await scenario("foreign customer, subscription, and checkout ownership conflicts are terminal", async () => {
  const foreign = createFixture();
  seedCustomerBinding(foreign.repository, {
    workspaceId: WORKSPACE_A,
    customerId: CUSTOMER_A,
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active"
  });
  seedCustomerBinding(foreign.repository, {
    workspaceId: WORKSPACE_B,
    customerId: CUSTOMER_B,
    subscriptionId: SUBSCRIPTION_B,
    priceId: PRICE_GROWTH,
    planId: "growth",
    subscriptionStatus: "active",
    latestEventId: "evt_seed000002"
  });
  await expectError(
    () => deliver(foreign, stripeEvent("customer.subscription.updated", subscriptionObject({
      id: SUBSCRIPTION_A,
      customer: CUSTOMER_B
    }), { id: "evt_foreign000001" })),
    "ownership_mismatch",
    "durable_billing_ownership_conflict"
  );

  foreign.repository.seedCheckout({
    workspaceId: WORKSPACE_A,
    sessionId: SESSION_A,
    requestedPlanId: "business"
  });
  await expectError(
    () => deliver(foreign, stripeEvent("checkout.session.completed", checkoutObject({
      id: SESSION_A,
      customer: CUSTOMER_B,
      subscription: SUBSCRIPTION_B,
      workspaceId: WORKSPACE_A,
      planId: "business"
    }), { id: "evt_foreign000002" })),
    "ownership_mismatch",
    "durable_billing_ownership_conflict"
  );
});

await scenario("private completion facts preserve active and trialing subscription evidence", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository);

  const activeEvent = stripeEvent(
    "customer.subscription.created",
    subscriptionObject(),
    { id: "evt_factsactive0001", created: NOW_SECONDS + 601 }
  );
  const activeEventBefore = clone(activeEvent);
  const active = await deliver(fixture, activeEvent);
  deepEqual(activeEvent, activeEventBefore, "active webhook input was mutated");
  equal(active.planId, "business");
  equal(active.subscriptionStatus, "active");
  equal(active.currentPeriodStart, new Date(NOW_MILLISECONDS).toISOString());
  equal(active.currentPeriodEnd, new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString());
  equal(active.cancelAtPeriodEnd, false);
  equal(active.applied, true);
  assertSettlementCompletion(fixture, {
    decision: active,
    eventCreated: NOW_SECONDS + 601,
    settlementSubscriptionId: SUBSCRIPTION_A,
    evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
    callIndex: 0,
    label: "active completion"
  });

  const trialingEvent = stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({
      status: "trialing",
      periodStart: NOW_SECONDS + 602,
      periodEnd: NOW_SECONDS + 500_000,
      cancelAtPeriodEnd: true
    }),
    { id: "evt_factstrial0001", created: NOW_SECONDS + 602 }
  );
  const trialingEventBefore = clone(trialingEvent);
  const trialing = await deliver(fixture, trialingEvent);
  deepEqual(trialingEvent, trialingEventBefore, "trialing webhook input was mutated");
  equal(trialing.planId, "business");
  equal(trialing.subscriptionStatus, "trialing");
  equal(trialing.currentPeriodStart, new Date((NOW_SECONDS + 602) * 1000).toISOString());
  equal(trialing.currentPeriodEnd, new Date((NOW_SECONDS + 500_000) * 1000).toISOString());
  equal(trialing.cancelAtPeriodEnd, true);
  equal(trialing.applied, true);
  assertSettlementCompletion(fixture, {
    decision: trialing,
    eventCreated: NOW_SECONDS + 602,
    settlementSubscriptionId: SUBSCRIPTION_A,
    evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
    callIndex: 1,
    label: "trialing completion"
  });
  equal(completionCalls(fixture).length, 2, "active and trialing events must each complete once");
});

await scenario("terminal completion preserves the authoritative subject after binding clear", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository, {
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active",
    currentPeriodStart: new Date(NOW_MILLISECONDS).toISOString(),
    currentPeriodEnd: new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString()
  });
  const event = stripeEvent(
    "customer.subscription.deleted",
    subscriptionObject({ status: "canceled", metadata: { plan_id: "business" } }),
    { id: "evt_factsterminal1", created: NOW_SECONDS + 610 }
  );
  const before = clone(event);
  const result = await deliver(fixture, event);
  deepEqual(event, before, "terminal webhook input was mutated");
  equal(result.resultCode, "current_subscription_cleared");
  equal(result.subscriptionStatus, "canceled");
  equal(result.planId, null);
  equal(result.currentPeriodStart, null);
  equal(result.currentPeriodEnd, null);
  equal(result.cancelAtPeriodEnd, false);
  equal(result.applied, true);
  const reconcile = fixture.repository.calls.find(call => call.method === "reconcileBinding");
  equal(reconcile.input.subscriptionId, null, "terminal reconciliation did not clear current subscription state");
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).subscriptionId, null);
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).customerId, CUSTOMER_A);
  const completion = assertSettlementCompletion(fixture, {
    decision: result,
    eventCreated: NOW_SECONDS + 610,
    settlementSubscriptionId: SUBSCRIPTION_A,
    evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
    label: "terminal completion"
  });
  expect(
    fixture.timeline.indexOf("repository:reconcileBinding") < fixture.timeline.indexOf("repository:completeWebhookEvent"),
    "terminal completion order changed"
  );
  equal(completion.input.settlementFacts.stripeCustomerId, CUSTOMER_A);
});

await scenario("replacement, stale original, stale terminal, and resubscription retain exact subjects", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository, {
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active",
    latestEventCreated: NOW_SECONDS + 10,
    latestEventId: "evt_factreplace0010"
  });

  const replacement = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ id: SUBSCRIPTION_B, priceId: PRICE_GROWTH }),
    { id: "evt_factreplace0030", created: NOW_SECONDS + 30 }
  ));
  equal(replacement.resultCode, "current_subscription_replaced");
  assertSettlementCompletion(fixture, {
    decision: replacement,
    eventCreated: NOW_SECONDS + 30,
    settlementSubscriptionId: SUBSCRIPTION_B,
    evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
    callIndex: 0,
    label: "replacement completion"
  });

  const staleOriginal = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ id: SUBSCRIPTION_A, priceId: PRICE_BUSINESS }),
    { id: "evt_factreplace0020", created: NOW_SECONDS + 20 }
  ));
  equal(staleOriginal.status, "stale");
  equal(staleOriginal.applied, false);
  assertSettlementCompletion(fixture, {
    decision: staleOriginal,
    eventCreated: NOW_SECONDS + 20,
    settlementSubscriptionId: SUBSCRIPTION_A,
    evidence: NON_AUTHORITATIVE_SUBSCRIPTION_CONTEXT,
    callIndex: 1,
    label: "stale original completion"
  });

  const staleTerminal = await deliver(fixture, stripeEvent(
    "customer.subscription.deleted",
    subscriptionObject({ id: SUBSCRIPTION_A, status: "canceled" }),
    { id: "evt_factreplace0025", created: NOW_SECONDS + 25 }
  ));
  equal(staleTerminal.status, "stale");
  equal(staleTerminal.applied, false);
  assertSettlementCompletion(fixture, {
    decision: staleTerminal,
    eventCreated: NOW_SECONDS + 25,
    settlementSubscriptionId: SUBSCRIPTION_A,
    evidence: NON_AUTHORITATIVE_SUBSCRIPTION_CONTEXT,
    callIndex: 2,
    label: "stale terminal completion"
  });
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).subscriptionId, SUBSCRIPTION_B);

  const resubscribed = await deliver(fixture, stripeEvent(
    "customer.subscription.created",
    subscriptionObject({ id: SUBSCRIPTION_C, priceId: PRICE_AGENCY }),
    { id: "evt_factreplace0040", created: NOW_SECONDS + 40 }
  ));
  equal(resubscribed.resultCode, "current_subscription_replaced");
  assertSettlementCompletion(fixture, {
    decision: resubscribed,
    eventCreated: NOW_SECONDS + 40,
    settlementSubscriptionId: SUBSCRIPTION_C,
    evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
    callIndex: 3,
    label: "resubscription completion"
  });
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).subscriptionId, SUBSCRIPTION_C);
});

await scenario("non-subscription events distinguish absent, contextual, and retrieved evidence", async () => {
  const cases = [
    {
      label: "checkout without subscription",
      type: "checkout.session.completed",
      object: checkoutObject({ subscription: null }),
      prepare(fixture) { fixture.repository.seedCheckout({ sessionId: SESSION_A }); },
      expectedStatus: "no_transition",
      evidence: NO_SUBSCRIPTION_EVIDENCE
    },
    {
      label: "invoice without subscription",
      type: "invoice.paid",
      object: invoiceObject({ subscription: null }),
      expectedStatus: "no_transition",
      evidence: NO_SUBSCRIPTION_EVIDENCE
    },
    {
      label: "refund without subscription",
      type: "charge.refunded",
      object: incidentObject(),
      expectedStatus: "review_required",
      evidence: NO_SUBSCRIPTION_EVIDENCE
    },
    {
      label: "dispute without subscription",
      type: "charge.dispute.created",
      object: incidentObject(),
      expectedStatus: "review_required",
      evidence: NO_SUBSCRIPTION_EVIDENCE
    },
    {
      label: "unverified dispute subscription context",
      type: "charge.dispute.created",
      object: { ...incidentObject(), subscription: SUBSCRIPTION_A },
      expectedStatus: "review_required",
      evidence: NON_AUTHORITATIVE_SUBSCRIPTION_CONTEXT
    }
  ];
  let eventOffset = 620;
  for (const item of cases) {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository);
    item.prepare?.(fixture);
    const created = NOW_SECONDS + eventOffset;
    const result = await deliver(fixture, stripeEvent(item.type, item.object, {
      id: `evt_factsnone${String(eventOffset).padStart(6, "0")}`,
      created
    }));
    equal(result.status, item.expectedStatus, `${item.label} status mismatch`);
    assertSettlementCompletion(fixture, {
      decision: result,
      eventCreated: created,
      settlementSubscriptionId: null,
      evidence: item.evidence,
      label: item.label
    });
    equal(fixture.gateway.calls.some(call => call.method === "retrieveSubscription"), false, `${item.label} retrieved provider state`);
    eventOffset += 1;
  }

  const authoritative = createFixture();
  seedCustomerBinding(authoritative.repository);
  authoritative.gateway.subscriptions.set(SUBSCRIPTION_A, {
    environment: "test",
    id: SUBSCRIPTION_A,
    customer: CUSTOMER_A,
    priceId: PRICE_BUSINESS,
    status: "active",
    currentPeriodStart: new Date(NOW_MILLISECONDS).toISOString(),
    currentPeriodEnd: new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString(),
    cancelAtPeriodEnd: false
  });
  const invoice = await deliver(authoritative, stripeEvent(
    "invoice.paid",
    invoiceObject(),
    { id: "evt_factsretrieved1", created: NOW_SECONDS + 630 }
  ));
  equal(authoritative.gateway.calls.filter(call => call.method === "retrieveSubscription").length, 1);
  assertSettlementCompletion(authoritative, {
    decision: invoice,
    eventCreated: NOW_SECONDS + 630,
    settlementSubscriptionId: SUBSCRIPTION_A,
    evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
    label: "retrieved invoice completion"
  });
});

await scenario("initial, update, cancel-at-period-end, terminal, and resubscription follow B0", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository);

  const initial = await deliver(fixture, stripeEvent(
    "customer.subscription.created",
    subscriptionObject(),
    { id: "evt_lifecycle000010", created: NOW_SECONDS + 10 }
  ));
  equal(initial.status, "reconciled");
  equal(initial.resultCode, "current_subscription_replaced");
  equal(initial.planId, "business");
  equal(initial.subscriptionStatus, "active");
  equal(initial.entitlementActionRequired, true);
  equal(initial.subscriptionReplaced, true);
  assertSafeValue(toSafeStripeBillingResult(initial), "initial lifecycle projection");

  const updated = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ periodEnd: NOW_SECONDS + 3_000_000 }),
    { id: "evt_lifecycle000020", created: NOW_SECONDS + 20 }
  ));
  equal(updated.resultCode, "current_subscription_updated");
  equal(updated.subscriptionReplaced, false);

  const cancelAtPeriodEnd = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ cancelAtPeriodEnd: true, periodEnd: NOW_SECONDS + 3_100_000 }),
    { id: "evt_lifecycle000030", created: NOW_SECONDS + 30 }
  ));
  equal(cancelAtPeriodEnd.cancelAtPeriodEnd, true);
  equal(cancelAtPeriodEnd.resultCode, "current_subscription_updated");

  const terminal = await deliver(fixture, stripeEvent(
    "customer.subscription.deleted",
    subscriptionObject({ status: "canceled", cancelAtPeriodEnd: false, metadata: { plan_id: "business" } }),
    { id: "evt_lifecycle000040", created: NOW_SECONDS + 40 }
  ));
  equal(terminal.resultCode, "current_subscription_cleared");
  equal(terminal.planId, null);
  equal(terminal.subscriptionStatus, "canceled");
  const cleared = fixture.repository.bindings.get(`test:${WORKSPACE_A}`);
  equal(cleared.customerId, CUSTOMER_A);
  equal(cleared.subscriptionId, null);
  equal(cleared.priceId, null);
  equal(cleared.planId, null);

  const resubscribed = await deliver(fixture, stripeEvent(
    "customer.subscription.created",
    subscriptionObject({ id: SUBSCRIPTION_B, priceId: PRICE_GROWTH }),
    { id: "evt_lifecycle000050", created: NOW_SECONDS + 50 }
  ));
  equal(resubscribed.resultCode, "current_subscription_replaced");
  equal(resubscribed.planId, "growth");
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).subscriptionId, SUBSCRIPTION_B);
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).customerId, CUSTOMER_A);
});

await scenario("replacement and stale original events cannot reclaim current state", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository, {
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active",
    latestEventCreated: NOW_SECONDS + 10,
    latestEventId: "evt_replace000010"
  });
  const replacement = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ id: SUBSCRIPTION_B, priceId: PRICE_GROWTH }),
    { id: "evt_replace000030", created: NOW_SECONDS + 30 }
  ));
  equal(replacement.resultCode, "current_subscription_replaced");
  equal(replacement.subscriptionReplaced, true);
  const stale = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ id: SUBSCRIPTION_A, priceId: PRICE_BUSINESS }),
    { id: "evt_replace000020", created: NOW_SECONDS + 20 }
  ));
  equal(stale.status, "stale");
  equal(stale.resultCode, "replayed_or_stale");
  equal(stale.classification, "stale_event");
  equal(stale.applied, false);
  equal(stale.entitlementActionRequired, false);
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).subscriptionId, SUBSCRIPTION_B);
});

await scenario("terminal state and same-second event-ID ordering are deterministic", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository, {
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active"
  });
  await deliver(fixture, stripeEvent(
    "customer.subscription.deleted",
    subscriptionObject({ status: "canceled" }),
    { id: "evt_order000030", created: NOW_SECONDS + 30 }
  ));
  const staleActive = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject(),
    { id: "evt_order000020", created: NOW_SECONDS + 20 }
  ));
  equal(staleActive.status, "stale");
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).subscriptionId, null);

  const firstSameSecond = await deliver(fixture, stripeEvent(
    "customer.subscription.created",
    subscriptionObject({ id: SUBSCRIPTION_B, priceId: PRICE_GROWTH }),
    { id: "evt_order000040a", created: NOW_SECONDS + 40 }
  ));
  equal(firstSameSecond.applied, true);
  const laterId = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ id: SUBSCRIPTION_B, priceId: PRICE_AGENCY }),
    { id: "evt_order000040z", created: NOW_SECONDS + 40 }
  ));
  equal(laterId.applied, true);
  equal(laterId.planId, "agency");
  const earlierId = await deliver(fixture, stripeEvent(
    "customer.subscription.updated",
    subscriptionObject({ id: SUBSCRIPTION_B, priceId: PRICE_BUSINESS }),
    { id: "evt_order000040m", created: NOW_SECONDS + 40 }
  ));
  equal(earlierId.status, "stale");
  equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).planId, "agency");
});

await scenario("plan and price resolution reject unknown, metadata-mismatched, and wrong-environment prices", async () => {
  const unknown = createFixture();
  seedCustomerBinding(unknown.repository);
  await expectError(
    () => deliver(unknown, stripeEvent("customer.subscription.created", subscriptionObject({ priceId: "price_unknown000001" }), { id: "evt_price000001" })),
    "unsupported_plan",
    "stripe_price_not_configured"
  );

  const mismatch = createFixture();
  seedCustomerBinding(mismatch.repository);
  await expectError(
    () => deliver(mismatch, stripeEvent("customer.subscription.created", subscriptionObject({
      priceId: PRICE_BUSINESS,
      metadata: { plan_id: "growth" }
    }), { id: "evt_price000002" })),
    "ownership_mismatch",
    "stripe_metadata_plan_mismatch"
  );

  const wrongEnvironmentPrice = createFixture();
  seedCustomerBinding(wrongEnvironmentPrice.repository);
  await expectError(
    () => deliver(wrongEnvironmentPrice, stripeEvent("customer.subscription.created", subscriptionObject({
      priceId: LIVE_PRICE_BUSINESS
    }), { id: "evt_price000003" })),
    "unsupported_plan",
    "stripe_price_not_configured"
  );

  const incidentMismatch = createFixture();
  seedCustomerBinding(incidentMismatch.repository, {
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active"
  });
  await expectError(
    () => deliver(incidentMismatch, stripeEvent("charge.refunded", {
      ...incidentObject(),
      metadata: { plan_id: "growth" }
    }, { id: "evt_price000004" })),
    "ownership_mismatch",
    "stripe_metadata_plan_mismatch"
  );

  const checkoutMismatch = createFixture();
  seedCustomerBinding(checkoutMismatch.repository);
  checkoutMismatch.repository.seedCheckout({ sessionId: SESSION_A, requestedPlanId: "business" });
  await expectError(
    () => deliver(checkoutMismatch, stripeEvent("checkout.session.completed", checkoutObject({
      subscription: null,
      planId: "growth"
    }), { id: "evt_price000005" })),
    "ownership_mismatch",
    "checkout_plan_mismatch"
  );
});

await scenario("checkout and invoice events retrieve authoritative subscription only after claim", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository);
  fixture.repository.seedCheckout({ workspaceId: WORKSPACE_A, sessionId: SESSION_A, requestedPlanId: "business" });
  fixture.gateway.subscriptions.set(SUBSCRIPTION_A, {
    environment: "test",
    id: SUBSCRIPTION_A,
    customer: CUSTOMER_A,
    priceId: PRICE_BUSINESS,
    status: "active",
    currentPeriodStart: new Date(NOW_MILLISECONDS).toISOString(),
    currentPeriodEnd: new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString(),
    cancelAtPeriodEnd: false
  });
  const checkout = await deliver(fixture, stripeEvent(
    "checkout.session.completed",
    checkoutObject(),
    { id: "evt_checkout000001", created: NOW_SECONDS + 10 }
  ));
  equal(checkout.status, "reconciled");
  equal(checkout.desiredState.paymentSignal, "paid");
  const claimIndex = fixture.timeline.indexOf("repository:claimWebhookEvent");
  const retrieveIndex = fixture.timeline.indexOf("gateway:retrieveSubscription");
  const reconcileIndex = fixture.timeline.lastIndexOf("repository:reconcileBinding");
  expect(claimIndex < retrieveIndex && retrieveIndex < reconcileIndex, "claim must precede provider retrieval and transition");

  fixture.gateway.subscriptions.set(SUBSCRIPTION_A, {
    ...fixture.gateway.subscriptions.get(SUBSCRIPTION_A),
    status: "past_due"
  });
  const failed = await deliver(fixture, stripeEvent(
    "invoice.payment_failed",
    invoiceObject(),
    { id: "evt_invoice000002", created: NOW_SECONDS + 20 }
  ));
  equal(failed.desiredState.paymentSignal, "failed");
  equal(failed.subscriptionStatus, "past_due");
  equal(failed.entitlementActionRequired, true);

  const paid = await deliver(fixture, stripeEvent(
    "invoice.paid",
    invoiceObject({ id: "in_invoice000002" }),
    { id: "evt_invoice000003", created: NOW_SECONDS + 30 }
  ));
  equal(paid.desiredState.paymentSignal, "paid");
});

await scenario("retrieved subscription timestamps are validated before reconciliation", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository);
  fixture.gateway.subscriptions.set(SUBSCRIPTION_A, {
    environment: "test",
    id: SUBSCRIPTION_A,
    customer: CUSTOMER_A,
    priceId: PRICE_BUSINESS,
    status: "active",
    currentPeriodStart: "not-a-timestamp",
    currentPeriodEnd: new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString(),
    cancelAtPeriodEnd: false
  });
  await expectError(
    () => deliver(fixture, stripeEvent("invoice.paid", invoiceObject(), { id: "evt_period000001" })),
    "provider_terminal_failure",
    "current_period_start_invalid"
  );
  equal(fixture.repository.calls.filter(call => call.method === "reconcileBinding").length, 0);
  equal(fixture.repository.claims.get("test:evt_period000001").status, "failed");
});

await scenario("authoritative completion rejects missing customers and substituted subscriptions", async () => {
  const missingCustomer = createFixture();
  seedCustomerBinding(missingCustomer.repository, {
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    planId: "business",
    subscriptionStatus: "active"
  });
  const missingCustomerError = await expectError(
    () => deliver(missingCustomer, stripeEvent(
      "customer.subscription.updated",
      subscriptionObject({ customer: null }),
      { id: "evt_factsmissing001", created: NOW_SECONDS + 640 }
    )),
    "provider_terminal_failure",
    "stripe_customer_id_invalid"
  );
  equal(completionCalls(missingCustomer).length, 0);
  equal(missingCustomer.repository.calls.some(call => call.method === "reconcileBinding"), false);
  assertPrivateSettlementAbsent(missingCustomerError, "missing-customer error");

  const substituted = createFixture({
    gatewayHooks: {
      retrieveSubscription() {
        return {
          environment: "test",
          id: SUBSCRIPTION_B,
          customer: CUSTOMER_A,
          priceId: PRICE_GROWTH,
          status: "active",
          currentPeriodStart: new Date(NOW_MILLISECONDS).toISOString(),
          currentPeriodEnd: new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString(),
          cancelAtPeriodEnd: false
        };
      }
    }
  });
  seedCustomerBinding(substituted.repository);
  const substitutionError = await expectError(
    () => deliver(substituted, stripeEvent(
      "invoice.paid",
      invoiceObject({ subscription: SUBSCRIPTION_A }),
      { id: "evt_factssubstitute1", created: NOW_SECONDS + 641 }
    )),
    "ownership_mismatch",
    "stripe_subscription_ownership_mismatch"
  );
  equal(completionCalls(substituted).length, 0);
  equal(substituted.repository.calls.some(call => call.method === "reconcileBinding"), false);
  equal(substituted.repository.claims.get("test:evt_factssubstitute1").status, "failed");
  assertPrivateSettlementAbsent(substitutionError, "subscription-substitution error");
});

await scenario("webhook complete replay returns stored safe result without repeating transition", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository);
  const event = stripeEvent("customer.subscription.created", subscriptionObject(), { id: "evt_replay000001" });
  const first = await deliver(fixture, event);
  equal(first.status, "reconciled");
  const reconcileCount = fixture.repository.calls.filter(call => call.method === "reconcileBinding").length;
  const retrieveCount = fixture.gateway.calls.filter(call => call.method === "retrieveSubscription").length;
  const completionCount = completionCalls(fixture).length;
  const firstCompletionFacts = clone(completionCalls(fixture)[0].input.settlementFacts);
  const replay = await deliver(fixture, event);
  equal(replay.status, "replayed");
  equal(replay.resultCode, "already_complete");
  equal(replay.duplicate, true);
  equal(replay.classification, "duplicate_event");
  equal(replay.entitlementActionRequired, false);
  equal(fixture.repository.calls.filter(call => call.method === "reconcileBinding").length, reconcileCount);
  equal(fixture.gateway.calls.filter(call => call.method === "retrieveSubscription").length, retrieveCount);
  equal(completionCalls(fixture).length, completionCount, "replay completed the event twice");
  deepEqual(completionCalls(fixture)[0].input.settlementFacts, firstCompletionFacts, "replay altered the original private facts");
  assertPrivateSettlementAbsent(replay, "webhook replay result");
  assertSafeValue(replay, "webhook replay result");
});

await scenario("private completion input is immutable and repository return values cannot leak", async () => {
  let topLevelMutationRejected = false;
  let nestedMutationRejected = false;
  const fixture = createFixture({
    repositoryHooks: {
      completeWebhookEvent(_copied, _repository, _state, original) {
        expect(Object.isFrozen(original), "completion request was not frozen");
        expect(Object.isFrozen(original.settlementFacts), "private settlement facts were not frozen");
        try {
          original.resultCode = "hostile_result";
        } catch {
          topLevelMutationRejected = true;
        }
        try {
          original.settlementFacts.version = "hostile-version";
        } catch {
          nestedMutationRejected = true;
        }
        return {
          completed: true,
          settlementFacts: clone(original.settlementFacts),
          stripeCustomerId: CUSTOMER_A,
          settlementSubscriptionId: SUBSCRIPTION_A
        };
      }
    }
  });
  seedCustomerBinding(fixture.repository);
  const result = await deliver(fixture, stripeEvent(
    "customer.subscription.created",
    subscriptionObject(),
    { id: "evt_factsimmutable1", created: NOW_SECONDS + 650 }
  ));
  equal(topLevelMutationRejected, true);
  equal(nestedMutationRejected, true);
  equal(completionCalls(fixture)[0].input.settlementFacts.version, SETTLEMENT_FACTS_VERSION);
  assertSettlementCompletion(fixture, {
    decision: result,
    eventCreated: NOW_SECONDS + 650,
    settlementSubscriptionId: SUBSCRIPTION_A,
    evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
    label: "immutable completion"
  });
  assertPrivateSettlementAbsent(result, "hostile repository return projection");
});

await scenario("concurrent claims converge without a second provider transition", async () => {
  let releaseRetrieve;
  const retrieveGate = new Promise(resolve => { releaseRetrieve = resolve; });
  let retrieveStarted;
  const started = new Promise(resolve => { retrieveStarted = resolve; });
  const fixture = createFixture({
    gatewayHooks: {
      async retrieveSubscription(input) {
        retrieveStarted();
        await retrieveGate;
        return {
          environment: "test",
          id: input.subscriptionId,
          customer: CUSTOMER_A,
          priceId: PRICE_BUSINESS,
          status: "active",
          currentPeriodStart: new Date(NOW_MILLISECONDS).toISOString(),
          currentPeriodEnd: new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString(),
          cancelAtPeriodEnd: false
        };
      }
    }
  });
  seedCustomerBinding(fixture.repository);
  const event = stripeEvent("invoice.paid", invoiceObject(), { id: "evt_concurrent0001" });
  const firstPromise = deliver(fixture, event);
  await started;
  const concurrent = await deliver(fixture, event);
  equal(concurrent.status, "in_progress");
  equal(concurrent.resultCode, "already_claimed");
  equal(concurrent.duplicate, true);
  equal(concurrent.classification, "duplicate_event");
  releaseRetrieve();
  const first = await firstPromise;
  equal(first.status, "reconciled");
  equal(fixture.gateway.calls.filter(call => call.method === "retrieveSubscription").length, 1);
  equal(fixture.repository.calls.filter(call => call.method === "reconcileBinding").length, 1);
});

await scenario("stale and failed claims are reclaimed according to B0", async () => {
  for (const [status, receivedAt, eventId] of [
    ["processing", NOW_SECONDS - 301, "evt_reclaim000001"],
    ["failed", NOW_SECONDS, "evt_reclaim000002"]
  ]) {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository);
    fixture.repository.seedClaim({
      workspaceId: WORKSPACE_A,
      eventId,
      eventType: "customer.subscription.updated",
      status,
      receivedAt
    });
    const result = await deliver(fixture, stripeEvent(
      "customer.subscription.updated",
      subscriptionObject(),
      { id: eventId }
    ));
    equal(result.status, "reconciled");
    equal(fixture.repository.claims.get(`test:${eventId}`).attempts, 2);
    equal(fixture.repository.claims.get(`test:${eventId}`).status, "complete");
  }

  const ambiguous = createFixture({
    repositoryHooks: {
      claimWebhookEvent: () => ({ claimed: false, duplicate: false, resultCode: "unknown" })
    }
  });
  seedCustomerBinding(ambiguous.repository);
  await expectError(
    () => deliver(ambiguous, stripeEvent("customer.subscription.updated", subscriptionObject(), { id: "evt_claim000001" })),
    "reconciliation_required",
    "webhook_claim_ambiguous"
  );

  let invalidClaimIndex = 0;
  for (const invalidClaim of [
    { claimed: true, duplicate: true, resultCode: "claimed" },
    { claimed: true, duplicate: false, resultCode: "already_complete" },
    { claimed: false, duplicate: true, resultCode: "reclaimed" }
  ]) {
    const invalid = createFixture({ repositoryHooks: { claimWebhookEvent: () => invalidClaim } });
    seedCustomerBinding(invalid.repository);
    await expectError(
      () => deliver(invalid, stripeEvent("customer.subscription.updated", subscriptionObject(), { id: `evt_claiminvalid${String(++invalidClaimIndex).padStart(6, "0")}` })),
      "reconciliation_required",
      "webhook_claim_ambiguous"
    );
  }
});

await scenario("refund and dispute events produce B2 directives without entitlement mutation", async () => {
  const fixture = createFixture();
  seedCustomerBinding(fixture.repository);
  const cases = [
    ["charge.refunded", incidentObject(), "full_refund_requires_b2_review", "full_refund"],
    ["charge.refunded", incidentObject({ amountRefunded: 500 }), "partial_refund_requires_b2_review", "partial_refund"],
    ["charge.dispute.created", incidentObject(), "dispute_opened_requires_b2_review", "dispute_opened"],
    ["charge.dispute.closed", incidentObject({ status: "won" }), "dispute_resolved_requires_b2_review", "dispute_resolved"],
    ["charge.dispute.closed", incidentObject({ status: "lost" }), "dispute_lost_requires_b2_review", "dispute_lost"]
  ];
  let index = 0;
  for (const [type, object, resultCode, incident] of cases) {
    const result = await deliver(fixture, stripeEvent(type, object, {
      id: `evt_incident${String(++index).padStart(6, "0")}`,
      created: NOW_SECONDS + 100 + index
    }));
    equal(result.status, "review_required");
    equal(result.resultCode, resultCode);
    equal(result.entitlementActionRequired, true);
    equal(result.desiredState.kind, "incident_review");
    equal(result.desiredState.incident, incident);
    assertSafeValue(toSafeStripeBillingResult(result), "incident projection");
  }
  equal(entitlementMutations, 0);
  equal(fixture.repository.calls.some(call => /entitlement|access|trial|credit/iu.test(call.method)), false);
});

await scenario("safe projections exclude raw provider and tenancy material", async () => {
  const projected = toSafeStripeBillingResult({
    ok: true,
    status: "reconciled",
    resultCode: "current_subscription_updated",
    environment: "test",
    planId: "business",
    workspaceId: WORKSPACE_A,
    eventId: "evt_hidden000001",
    customerId: CUSTOMER_A,
    subscriptionId: SUBSCRIPTION_A,
    priceId: PRICE_BUSINESS,
    webhookSecret: WEBHOOK_SECRET,
    rawBody: RAW_PROVIDER_SECRET,
    rawProviderResponse: { private: RAW_PROVIDER_SECRET },
    customerEmail: "private-person@example.test",
    desiredState: {
      kind: "subscription_state",
      paymentSignal: "provider_state",
      planId: "business",
      subscriptionStatus: "active",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      private: RAW_PROVIDER_SECRET
    }
  });
  deepEqual(Object.keys(projected).sort(), [
    "desiredState",
    "environment",
    "ok",
    "planId",
    "resultCode",
    "status"
  ]);
  equal("private" in projected.desiredState, false);
  assertFrozen(projected, "safe projection");
  assertFrozen(projected.desiredState, "safe desired state");
  assertSafeValue(projected, "safe projection");

  const unknown = classifyStripeBillingError(new Error(`${RAW_PROVIDER_SECRET}:${WEBHOOK_SECRET}`));
  equal(unknown.classification, "provider_terminal_failure");
  equal(unknown.resultCode, "billing_operation_failed");
  equal("stack" in unknown, false);
  assertSafeValue(unknown, "unknown error projection");

  const hostileAllowedFields = toSafeStripeBillingResult({
    status: RAW_PROVIDER_SECRET,
    resultCode: RAW_PROVIDER_SECRET,
    classification: RAW_PROVIDER_SECRET,
    eventType: RAW_PROVIDER_SECRET,
    environment: RAW_PROVIDER_SECRET,
    planId: RAW_PROVIDER_SECRET,
    subscriptionStatus: RAW_PROVIDER_SECRET,
    currentPeriodStart: RAW_PROVIDER_SECRET,
    currentPeriodEnd: RAW_PROVIDER_SECRET,
    checkoutSessionId: RAW_PROVIDER_SECRET,
    url: `https://checkout.stripe.com.evil.example/${RAW_PROVIDER_SECRET}`,
    desiredState: { kind: "subscription_state", paymentSignal: RAW_PROVIDER_SECRET }
  });
  deepEqual(hostileAllowedFields, {});
  assertSafeValue(hostileAllowedFields, "hostile allowlisted fields");
});

await scenario("all supported event names normalize to a bounded safe envelope", async () => {
  const objects = {
    "checkout.session.completed": checkoutObject(),
    "checkout.session.async_payment_succeeded": checkoutObject(),
    "customer.subscription.created": subscriptionObject(),
    "customer.subscription.updated": subscriptionObject(),
    "customer.subscription.deleted": subscriptionObject({ status: "canceled" }),
    "invoice.paid": invoiceObject(),
    "invoice.payment_failed": invoiceObject(),
    "charge.refunded": incidentObject(),
    "charge.dispute.created": incidentObject(),
    "charge.dispute.closed": incidentObject({ status: "won" })
  };
  for (const eventType of STRIPE_BILLING_EVENT_TYPES) {
    const normalized = normalizeStripeBillingEvent(
      stripeEvent(eventType, objects[eventType], { id: `evt_normalize${String(STRIPE_BILLING_EVENT_TYPES.indexOf(eventType)).padStart(6, "0")}` }),
      "test"
    );
    equal(normalized.eventType, eventType);
    equal(normalized.environment, "test");
    equal(normalized.supported, true);
    assertFrozen(normalized, "normalized event");
    equal("rawBody" in normalized, false);
    equal("data" in normalized, false);
    equal("paymentMethod" in normalized, false);
  }
});

await scenario("mutation guards reject unsafe architectural and behavioral variants", async () => {
  await mutation("process.env read", async () => {
    expect(sourceArchitectureViolations(`${moduleSource}\nconst key = process.env.STRIPE_SECRET_KEY;`).includes("process.env"));
  });
  await mutation("global fetch", async () => {
    expect(sourceArchitectureViolations(`${moduleSource}\nfetch('https://api.stripe.com');`).includes("global fetch"));
  });
  await mutation("browser price ID", async () => {
    const fixture = createFixture();
    await expectError(() => fixture.service.prepareCheckout({
      context: authorizedContext(),
      request: { planId: "business", idempotencyKey: "mutation-checkout-key-01", priceId: PRICE_GROWTH }
    }), "invalid_request");
    equal(fixture.gateway.calls.length, 0);
  });
  await mutation("browser amount", async () => {
    const fixture = createFixture();
    await expectError(() => fixture.service.prepareCheckout({
      context: authorizedContext(),
      request: { planId: "business", idempotencyKey: "mutation-checkout-key-02", amount: 1 }
    }), "invalid_request");
    equal(fixture.gateway.calls.length, 0);
  });
  await mutation("metadata workspace authority", async () => {
    const fixture = createFixture();
    const result = await deliver(fixture, stripeEvent("customer.subscription.updated", subscriptionObject({
      customer: "cus_mutation000001",
      id: "sub_mutation000001",
      metadata: { social_cues_workspace_id: WORKSPACE_C }
    }), { id: "evt_mutation000001" }));
    equal(result.status, "ownership_unresolved");
  });
  await mutation("skipped verification", async () => {
    const fixture = createFixture({ gatewayHooks: { verifyWebhookEvent: () => { throw new Error(RAW_PROVIDER_SECRET); } } });
    seedCustomerBinding(fixture.repository);
    await expectError(() => deliver(fixture, stripeEvent("customer.subscription.updated", subscriptionObject())), "provider_verification_failure");
    equal(fixture.repository.calls.length, 0);
  });
  await mutation("parse before verification", async () => {
    const fixture = createFixture();
    await expectError(() => fixture.service.handleWebhook({
      rawBody: encoder.encode("not-json"),
      signatureHeader: "invalid",
      expectedEnvironment: "test"
    }), "provider_verification_failure", "webhook_signature_invalid");
    equal(fixture.gateway.state.parseCount, 0);
  });
  await mutation("ambiguous checkout retry", async () => {
    const fixture = createFixture({ gatewayHooks: { createCheckoutSession: () => { const error = new Error("ambiguous"); error.ambiguous = true; throw error; } } });
    seedCustomerBinding(fixture.repository);
    await fixture.service.prepareCheckout(checkoutOperation({ request: { planId: "business", idempotencyKey: "mutation-checkout-key-03" } }));
    await fixture.service.prepareCheckout(checkoutOperation({ request: { planId: "business", idempotencyKey: "mutation-checkout-key-03" } }));
    equal(fixture.gateway.calls.filter(call => call.method === "createCheckoutSession").length, 1);
  });
  await mutation("raw provider error", async () => {
    const safe = classifyStripeBillingError(new Error(RAW_PROVIDER_SECRET));
    assertSafeValue(safe, "mutated raw provider error");
  });
  await mutation("entitlement mutation", async () => {
    expect(sourceArchitectureViolations(`${moduleSource}\nrepository.updateBillingEntitlements();`).includes("entitlement mutation"));
  });
  await mutation("permanent subscription identity", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository, { subscriptionId: SUBSCRIPTION_A, priceId: PRICE_BUSINESS, planId: "business", subscriptionStatus: "active" });
    const result = await deliver(fixture, stripeEvent("customer.subscription.updated", subscriptionObject({ id: SUBSCRIPTION_B, priceId: PRICE_GROWTH }), { id: "evt_mutation000011" }));
    equal(result.resultCode, "current_subscription_replaced");
  });
  await mutation("stale event acceptance", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository, { subscriptionId: SUBSCRIPTION_A, priceId: PRICE_BUSINESS, planId: "business", subscriptionStatus: "active", latestEventCreated: NOW_SECONDS + 50, latestEventId: "evt_mutation000050" });
    const result = await deliver(fixture, stripeEvent("customer.subscription.updated", subscriptionObject({ priceId: PRICE_GROWTH }), { id: "evt_mutation000040", created: NOW_SECONDS + 40 }));
    equal(result.status, "stale");
    equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).planId, "business");
  });
  await mutation("secret leakage", async () => {
    const projected = toSafeStripeBillingResult({ rawProviderResponse: RAW_PROVIDER_SECRET, webhookSecret: WEBHOOK_SECRET, ok: false });
    assertSafeValue(projected, "mutated secret result");
  });
  await mutation("unsafe URL", async () => {
    const fixture = createFixture({ gatewayHooks: { createPortalSession: () => ({ environment: "test", url: "https://billing.stripe.com.evil.example/" }) } });
    seedCustomerBinding(fixture.repository);
    await expectError(() => fixture.service.preparePortal({ context: authorizedContext(), request: { idempotencyKey: "mutation-portal-key-01" } }), "provider_terminal_failure", "portal_url_invalid");
  });
  await mutation("eventCreated from current time", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository);
    const created = NOW_SECONDS + 701;
    const result = await deliver(fixture, stripeEvent(
      "customer.subscription.created",
      subscriptionObject(),
      { id: "evt_mutationfacts001", created }
    ));
    equal(completionCalls(fixture)[0].input.settlementFacts.eventCreated, created);
    expect(completionCalls(fixture)[0].input.settlementFacts.eventCreated !== NOW_SECONDS, "completion used lifecycle clock time");
    assertPrivateSettlementAbsent(result, "eventCreated mutation result");
  });
  await mutation("metadata-only customer identity", async () => {
    const fixture = createFixture();
    const result = await deliver(fixture, stripeEvent(
      "customer.subscription.updated",
      subscriptionObject({
        customer: "cus_mutationfacts01",
        id: "sub_mutationfacts01",
        metadata: { social_cues_workspace_id: WORKSPACE_A }
      }),
      { id: "evt_mutationfacts002" }
    ));
    equal(result.status, "ownership_unresolved");
    equal(completionCalls(fixture).length, 0);
  });
  await mutation("metadata-only subscription identity", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository);
    const object = { ...invoiceObject({ subscription: null }), metadata: { subscription_id: SUBSCRIPTION_A } };
    const result = await deliver(fixture, stripeEvent("invoice.paid", object, { id: "evt_mutationfacts003" }));
    equal(result.status, "no_transition");
    assertSettlementCompletion(fixture, {
      decision: result,
      eventCreated: NOW_SECONDS + 10,
      settlementSubscriptionId: null,
      evidence: NO_SUBSCRIPTION_EVIDENCE,
      label: "metadata-only subscription mutation"
    });
  });
  await mutation("terminal subscription captured after clear", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository, {
      subscriptionId: SUBSCRIPTION_A,
      priceId: PRICE_BUSINESS,
      planId: "business",
      subscriptionStatus: "active"
    });
    const result = await deliver(fixture, stripeEvent(
      "customer.subscription.deleted",
      subscriptionObject({ status: "canceled" }),
      { id: "evt_mutationfacts004", created: NOW_SECONDS + 704 }
    ));
    equal(fixture.repository.bindings.get(`test:${WORKSPACE_A}`).subscriptionId, null);
    assertSettlementCompletion(fixture, {
      decision: result,
      eventCreated: NOW_SECONDS + 704,
      settlementSubscriptionId: SUBSCRIPTION_A,
      evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
      label: "terminal capture mutation"
    });
  });
  await mutation("every subscription event authoritative", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository, {
      subscriptionId: SUBSCRIPTION_B,
      priceId: PRICE_GROWTH,
      planId: "growth",
      subscriptionStatus: "active",
      latestEventCreated: NOW_SECONDS + 720,
      latestEventId: "evt_mutationfacts720"
    });
    const stale = await deliver(fixture, stripeEvent(
      "customer.subscription.updated",
      subscriptionObject({ id: SUBSCRIPTION_A }),
      { id: "evt_mutationfacts710", created: NOW_SECONDS + 710 }
    ));
    equal(stale.applied, false);
    equal(completionCalls(fixture)[0].input.settlementFacts.evidence, NON_AUTHORITATIVE_SUBSCRIPTION_CONTEXT);
  });
  await mutation("event type creates authority", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository, {
      subscriptionId: SUBSCRIPTION_A,
      priceId: PRICE_BUSINESS,
      planId: "business",
      subscriptionStatus: "active"
    });
    const result = await deliver(fixture, stripeEvent(
      "charge.dispute.created",
      { ...incidentObject(), subscription: SUBSCRIPTION_A },
      { id: "evt_mutationfacts006" }
    ));
    const facts = completionCalls(fixture)[0].input.settlementFacts;
    equal(facts.evidence, NON_AUTHORITATIVE_SUBSCRIPTION_CONTEXT);
    equal(facts.settlementSubscriptionId, null);
    assertPrivateSettlementAbsent(result, "event-type authority mutation");
  });
  await mutation("settlement facts embedded in safe result", async () => {
    const projected = toSafeStripeBillingResult({
      ok: true,
      status: "reconciled",
      resultCode: "current_subscription_updated",
      settlementFacts: {
        version: SETTLEMENT_FACTS_VERSION,
        eventCreated: NOW_SECONDS,
        stripeCustomerId: CUSTOMER_A,
        settlementSubscriptionId: SUBSCRIPTION_A,
        evidence: AUTHORITATIVE_SUBSCRIPTION_STATE
      }
    });
    assertPrivateSettlementAbsent(projected, "embedded settlement facts mutation");
  });
  await mutation("repository returns private completion facts", async () => {
    const fixture = createFixture({
      repositoryHooks: {
        completeWebhookEvent(input) {
          return { completed: true, settlementFacts: input.settlementFacts };
        }
      }
    });
    seedCustomerBinding(fixture.repository);
    const result = await deliver(fixture, stripeEvent(
      "customer.subscription.created",
      subscriptionObject(),
      { id: "evt_mutationfacts008" }
    ));
    assertPrivateSettlementAbsent(result, "repository completion return mutation");
  });
  await mutation("authoritative evidence without durable customer", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository, {
      subscriptionId: SUBSCRIPTION_A,
      priceId: PRICE_BUSINESS,
      planId: "business",
      subscriptionStatus: "active"
    });
    await expectError(
      () => deliver(fixture, stripeEvent(
        "customer.subscription.updated",
        subscriptionObject({ customer: null }),
        { id: "evt_mutationfacts009" }
      )),
      "provider_terminal_failure",
      "stripe_customer_id_invalid"
    );
    equal(completionCalls(fixture).length, 0);
  });
  await mutation("replacement subscription substituted for old event", async () => {
    const fixture = createFixture({
      gatewayHooks: {
        retrieveSubscription() {
          return {
            environment: "test",
            id: SUBSCRIPTION_B,
            customer: CUSTOMER_A,
            priceId: PRICE_GROWTH,
            status: "active",
            currentPeriodStart: new Date(NOW_MILLISECONDS).toISOString(),
            currentPeriodEnd: new Date((NOW_SECONDS + 2_592_000) * 1000).toISOString(),
            cancelAtPeriodEnd: false
          };
        }
      }
    });
    seedCustomerBinding(fixture.repository);
    await expectError(
      () => deliver(fixture, stripeEvent("invoice.paid", invoiceObject(), { id: "evt_mutationfacts010" })),
      "ownership_mismatch",
      "stripe_subscription_ownership_mismatch"
    );
    equal(completionCalls(fixture).length, 0);
  });
  await mutation("replay completes twice", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository);
    const event = stripeEvent("customer.subscription.created", subscriptionObject(), { id: "evt_mutationfacts011" });
    await deliver(fixture, event);
    await deliver(fixture, event);
    equal(completionCalls(fixture).length, 1);
  });
  await mutation("raw event passed into completion", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository);
    const result = await deliver(fixture, stripeEvent(
      "customer.subscription.created",
      subscriptionObject(),
      { id: "evt_mutationfacts012" }
    ));
    assertSettlementCompletion(fixture, {
      decision: result,
      eventCreated: NOW_SECONDS + 10,
      settlementSubscriptionId: SUBSCRIPTION_A,
      evidence: AUTHORITATIVE_SUBSCRIPTION_STATE,
      label: "raw event mutation"
    });
  });
  await mutation("private identifier exposed in error", async () => {
    const fixture = createFixture();
    seedCustomerBinding(fixture.repository, {
      subscriptionId: SUBSCRIPTION_A,
      priceId: PRICE_BUSINESS,
      planId: "business",
      subscriptionStatus: "active"
    });
    const safe = await expectError(
      () => deliver(fixture, stripeEvent(
        "customer.subscription.updated",
        subscriptionObject({ customer: CUSTOMER_B }),
        { id: "evt_mutationfacts013" }
      )),
      "ownership_mismatch",
      "stripe_customer_ownership_mismatch"
    );
    assertPrivateSettlementAbsent(safe, "private identifier error mutation");
  });
});

await scenario("final boundary counters remain hermetic", async () => {
  equal(providerRequests, 0);
  equal(productionRequests, 0);
  equal(externalRequests, 0);
  equal(secretsExposed, 0);
  equal(entitlementMutations, 0);
  doesNotMatch(moduleSource, /billing[_-]?entitlements|activateWorkspace|revokeWorkspace|grantCredits/iu);
  equal(Object.prototype.hasOwnProperty.call(baseConfiguration, "apiKey"), false);
  equal(Object.prototype.hasOwnProperty.call(baseConfiguration, "paymentLink"), false);
});

globalThis.fetch = originalFetch;

console.log(JSON.stringify({
  ok: true,
  assertions,
  scenarios,
  mutationRejections,
  fakeGatewayCalls,
  fakeRepositoryCalls,
  providerRequests,
  productionRequests,
  externalRequests,
  secretsExposed,
  entitlementMutations
}));
