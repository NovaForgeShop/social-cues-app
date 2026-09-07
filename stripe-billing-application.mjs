import { PRICING_CONFIGURATION, resolvePricingPlan } from "./pricing-packaging.mjs";
import { createStripeBillingLifecycle } from "./stripe-billing-lifecycle.mjs";
import { createStripeBillingGateway } from "./stripe-billing-gateway.mjs";
import { createStripeBillingRepository } from "./stripe-billing-repository.mjs";
import { STRIPE_BILLING_RELEASE_STAGE } from "./stripe-billing-configuration.mjs";

const HELD_CAPABILITIES = Object.freeze({
  checkoutAvailable: false,
  portalAvailable: false,
  webhookProcessingAvailable: false
});

function frozen(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) frozen(item);
  return Object.freeze(value);
}

function safeReadiness(state, mode, configured, databaseReady = false) {
  return frozen({
    ok: ["disabled", "database_ready_activation_held", "ready_for_later_test_activation"].includes(state),
    state,
    mode,
    configured,
    databaseReady,
    releaseStage: STRIPE_BILLING_RELEASE_STAGE,
    ...HELD_CAPABILITIES
  });
}

function heldResult(operation) {
  return frozen({
    ok: false,
    status: "activation_held",
    resultCode: `${operation}_activation_held`,
    releaseStage: STRIPE_BILLING_RELEASE_STAGE,
    retryable: false,
    ...HELD_CAPABILITIES
  });
}

function safeWorkspaceBinding(binding) {
  if (!binding) {
    return frozen({
      connected: false,
      planId: null,
      subscriptionStatus: "not_started",
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false
    });
  }
  const allowedPlans = new Set(["business", "growth", "agency"]);
  const allowedStatuses = new Set([
    "not_started", "incomplete", "incomplete_expired", "trialing", "active",
    "past_due", "canceled", "unpaid", "paused"
  ]);
  return frozen({
    connected: true,
    planId: allowedPlans.has(binding.planId) ? binding.planId : null,
    subscriptionStatus: allowedStatuses.has(binding.subscriptionStatus) ? binding.subscriptionStatus : "not_started",
    currentPeriodStart: typeof binding.currentPeriodStart === "string" ? binding.currentPeriodStart : null,
    currentPeriodEnd: typeof binding.currentPeriodEnd === "string" ? binding.currentPeriodEnd : null,
    cancelAtPeriodEnd: binding.cancelAtPeriodEnd === true
  });
}

export function createStripeBillingApplication(options = {}) {
  const configuration = options.configuration;
  if (!configuration || typeof configuration !== "object" || typeof configuration.state !== "string") {
    throw new TypeError("stripe_billing_configuration_required");
  }

  let repository = null;
  let lifecycle = null;
  let compositionComplete = false;
  if (configuration.state === "configured-held" && configuration.ok === true && configuration.internal) {
    try {
      const gatewayFactory = options.gatewayFactory || createStripeBillingGateway;
      const repositoryFactory = options.repositoryFactory || createStripeBillingRepository;
      const lifecycleFactory = options.lifecycleFactory || createStripeBillingLifecycle;
      const gateway = gatewayFactory({
        configuration: configuration.internal.gatewayConfiguration,
        request: options.gatewayRequest,
        timeoutMs: options.gatewayTimeoutMs,
        now: options.clock
      });
      repository = repositoryFactory({
        request: options.repositoryRequest,
        now: options.clock
      });
      lifecycle = lifecycleFactory({
        configuration: configuration.internal.lifecycleConfiguration,
        pricing: options.pricing || {
          version: PRICING_CONFIGURATION.version,
          resolvePlan: resolvePricingPlan
        },
        gateway,
        repository,
        clock: options.clock || Date.now,
        generateEventId: options.generateEventId || (() => "evt_readiness_only_000000")
      });
      compositionComplete = Boolean(lifecycle);
    } catch {
      repository = null;
      lifecycle = null;
      compositionComplete = false;
    }
  }

  async function getReadiness() {
    if (configuration.state === "disabled") return safeReadiness("disabled", "disabled", false);
    if (["misconfigured", "unsupported"].includes(configuration.state)) {
      return safeReadiness(configuration.readinessState || "configuration_invalid", configuration.mode, false);
    }
    if (!compositionComplete || !repository) {
      return safeReadiness("configuration_supported_but_incomplete", configuration.mode, false);
    }
    let database;
    try {
      database = await repository.probeReadiness();
    } catch {
      database = { ready: false, state: "database_unavailable" };
    }
    if (!database?.ready) {
      const state = database?.state === "database_migration_missing"
        ? "database_migration_missing"
        : "database_unavailable";
      return safeReadiness(state, configuration.mode, true);
    }
    return configuration.mode === "test"
      ? safeReadiness("ready_for_later_test_activation", configuration.mode, true, true)
      : safeReadiness("database_ready_activation_held", configuration.mode, true, true);
  }

  async function getWorkspaceBillingStatus(workspaceId) {
    const readiness = await getReadiness();
    if (!readiness.databaseReady || !repository) {
      return frozen({
        ok: false,
        state: readiness.state,
        releaseStage: STRIPE_BILLING_RELEASE_STAGE,
        billing: safeWorkspaceBinding(null),
        ...HELD_CAPABILITIES
      });
    }
    try {
      const binding = await repository.getBindingByWorkspace({
        workspaceId,
        environment: configuration.mode
      });
      return frozen({
        ok: true,
        state: readiness.state,
        releaseStage: STRIPE_BILLING_RELEASE_STAGE,
        billing: safeWorkspaceBinding(binding),
        ...HELD_CAPABILITIES
      });
    } catch {
      return frozen({
        ok: false,
        state: "database_unavailable",
        releaseStage: STRIPE_BILLING_RELEASE_STAGE,
        billing: safeWorkspaceBinding(null),
        ...HELD_CAPABILITIES
      });
    }
  }

  async function prepareCheckoutHeld() {
    return heldResult("checkout");
  }

  async function preparePortalHeld() {
    return heldResult("portal");
  }

  async function handleWebhookHeld() {
    return heldResult("webhook");
  }

  return frozen({
    releaseStage: STRIPE_BILLING_RELEASE_STAGE,
    getReadiness,
    getWorkspaceBillingStatus,
    prepareCheckoutHeld,
    preparePortalHeld,
    handleWebhookHeld
  });
}
