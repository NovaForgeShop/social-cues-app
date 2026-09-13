import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("./pricing-packaging.mjs", import.meta.url);
const externalRequestAttempts = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (...args) => {
  externalRequestAttempts.push(args);
  throw new Error("Pricing module import attempted an external request.");
};

let pricingModule;
try {
  pricingModule = await import(`${moduleUrl.href}?pricing-contract`);
} finally {
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete globalThis.fetch;
}

const {
  MOVE_METERING_CONFIGURATION,
  OPENAI_COST_ACCOUNTING_DEFAULTS,
  PRICING_CONFIGURATION,
  resolvePricingPlan
} = pricingModule;

function assertDeepFrozen(value, path = "catalog") {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
  for (const [key, nested] of Object.entries(value)) assertDeepFrozen(nested, `${path}.${key}`);
}

test("pricing module import is dependency-free and makes zero external requests", async () => {
  const moduleSource = await readFile(moduleUrl, "utf8");
  assert.equal(externalRequestAttempts.length, 0);
  assert.doesNotMatch(moduleSource, /^\s*import\s/m);
  assert.doesNotMatch(moduleSource, /process\.env|Deno\.env|Bun\.env/i);
  assert.doesNotMatch(moduleSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(?:http|https|net|tls)|https?:\/\//i);
  assert.doesNotMatch(moduleSource, /server\.mjs|supabase|browser|document\.|window\.|localStorage/i);
});

test("canonical plan IDs, order, prices, interval, and currency are exact", () => {
  assert.equal(PRICING_CONFIGURATION.defaultPlanId, "business");
  assert.equal(PRICING_CONFIGURATION.currency, "usd");
  assert.equal(PRICING_CONFIGURATION.billingInterval, "month");
  assert.equal(PRICING_CONFIGURATION.priceType, "list");
  assert.deepEqual(
    PRICING_CONFIGURATION.plans.map(({ id, name, monthlyPriceCents, currency, billingInterval, priceType }) => ({ id, name, monthlyPriceCents, currency, billingInterval, priceType })),
    [
      { id: "business", name: "Business", monthlyPriceCents: 5000, currency: "usd", billingInterval: "month", priceType: "list" },
      { id: "growth", name: "Growth", monthlyPriceCents: 10000, currency: "usd", billingInterval: "month", priceType: "list" },
      { id: "agency", name: "Agency", monthlyPriceCents: 15000, currency: "usd", billingInterval: "month", priceType: "list" }
    ]
  );
});

test("commercial identifiers are unique and add-on references are canonical", () => {
  const groups = [PRICING_CONFIGURATION.plans, PRICING_CONFIGURATION.addOns, PRICING_CONFIGURATION.services, PRICING_CONFIGURATION.providers];
  const commercialIds = groups.flatMap(group => group.map(item => item.id));
  assert.equal(new Set(commercialIds).size, commercialIds.length);
  const addOnIds = new Set(PRICING_CONFIGURATION.addOns.map(item => item.id));
  for (const plan of PRICING_CONFIGURATION.plans) {
    assert.equal(new Set(plan.plannedAddOnIds).size, plan.plannedAddOnIds.length);
    for (const addOnId of plan.plannedAddOnIds) assert.equal(addOnIds.has(addOnId), true, `${plan.id}:${addOnId}`);
  }
});

test("unknown and retired plan identifiers fail closed", () => {
  assert.deepEqual(resolvePricingPlan("business"), { ok: true, plan: PRICING_CONFIGURATION.plans[0] });
  for (const planId of ["", "Business - $50", "Business - $99", "founder-audit", "campaign-build", "pro", "price_12345678901234"]) {
    const result = resolvePricingPlan(planId);
    assert.equal(result.ok, false, planId);
    assert.equal(result.reason, "unknown-plan", planId);
    assert.equal("plan" in result, false, planId);
  }
});

test("catalog and resolver results are deeply immutable", () => {
  assertDeepFrozen(PRICING_CONFIGURATION);
  assertDeepFrozen(MOVE_METERING_CONFIGURATION, "moveMetering");
  assertDeepFrozen(OPENAI_COST_ACCOUNTING_DEFAULTS, "costAccounting");
  assertDeepFrozen(resolvePricingPlan("business"), "resolvedPlan");
  assertDeepFrozen(resolvePricingPlan("unknown"), "unknownPlan");
  assert.throws(() => PRICING_CONFIGURATION.plans.push({ id: "injected" }), TypeError);
  assert.throws(() => {
    PRICING_CONFIGURATION.plans[0].monthlyPriceCents = 1;
  }, TypeError);
});

test("catalog contains no Stripe price IDs, payment links, or browser price authority", async () => {
  const moduleSource = await readFile(moduleUrl, "utf8");
  const catalog = JSON.stringify(PRICING_CONFIGURATION);
  assert.doesNotMatch(catalog, /price_[A-Za-z0-9]|stripePrice|paymentLink|checkoutUrl|buy\.stripe\.com/i);
  assert.doesNotMatch(catalog, /founding|promotion|annual|coupon|discount/i);
  assert.doesNotMatch(moduleSource, /STRIPE_PRICE_|stripePriceIds|paymentLink|checkout|resolveApprovedCheckoutPlan/i);
  assert.equal(PRICING_CONFIGURATION.plans.every(plan => Number.isInteger(plan.monthlyPriceCents)), true);
});

test("allowance policy values are finite, nonnegative, and provisional", () => {
  let numericPolicyValues = 0;
  for (const plan of PRICING_CONFIGURATION.plans) {
    for (const item of plan.allowances) {
      for (const field of ["limit", "minimum", "maximum"]) {
        if (!(field in item)) continue;
        numericPolicyValues += 1;
        assert.equal(Number.isFinite(item[field]), true, `${plan.id}:${item.id}:${field}`);
        assert.equal(item[field] >= 0, true, `${plan.id}:${item.id}:${field}`);
      }
      assert.notEqual(item.classification, "currently_enforced", `${plan.id}:${item.id}`);
    }
  }
  assert.equal(numericPolicyValues > 0, true);
  assert.doesNotMatch(JSON.stringify(PRICING_CONFIGURATION), /unlimited|unbounded|infinite/i);
});

test("plan allowances publish the exact Move package without claiming enforcement", () => {
  assert.deepEqual(
    PRICING_CONFIGURATION.plans.map(plan => {
      const moves = plan.allowances.find(item => item.id === "moves");
      return {
        planId: plan.id,
        display: moves.display,
        limit: moves.limit,
        classification: moves.classification,
        period: moves.period,
        pooled: moves.pooled
      };
    }),
    [
      { planId: "business", display: "250 Moves / month", limit: 250, classification: "planned", period: "billing_cycle", pooled: false },
      { planId: "growth", display: "750 Moves / month", limit: 750, classification: "planned", period: "billing_cycle", pooled: false },
      { planId: "agency", display: "1,500 Moves / month", limit: 1500, classification: "planned", period: "billing_cycle", pooled: true }
    ]
  );
  for (const plan of PRICING_CONFIGURATION.plans) {
    const moves = plan.allowances.find(item => item.id === "moves");
    assert.equal(moves.serverBounded, true);
    assert.match(moves.detail, /deduction and plan enforcement are not active/i);
    assert.match(moves.detail, /server safety and cost controls/i);
    assert.equal(plan.allowances.find(item => item.id === "media-storage").serverBounded, true);
    assert.equal(plan.allowances.find(item => item.id === "automation").serverBounded, true);
  }
});

test("Business and Growth package limits are exact while Agency expansion remains planned", () => {
  const allowanceSummary = planId => {
    const plan = PRICING_CONFIGURATION.plans.find(item => item.id === planId);
    return Object.fromEntries(plan.allowances
      .filter(item => ["workspaces", "users", "connections"].includes(item.id))
      .map(item => [item.id, { display: item.display, limit: item.limit ?? null, classification: item.classification }]));
  };
  assert.deepEqual(allowanceSummary("business"), {
    workspaces: { display: "1 workspace", limit: 1, classification: "currently_measured_not_enforced" },
    users: { display: "Up to 2 users", limit: 2, classification: "currently_measured_not_enforced" },
    connections: { display: "Up to 10 social and business accounts", limit: 10, classification: "currently_measured_not_enforced" }
  });
  assert.deepEqual(allowanceSummary("growth"), {
    workspaces: { display: "1 workspace", limit: 1, classification: "currently_measured_not_enforced" },
    users: { display: "Up to 5 users", limit: 5, classification: "currently_measured_not_enforced" },
    connections: { display: "Up to 25 social and business accounts", limit: 25, classification: "currently_measured_not_enforced" }
  });
  assert.deepEqual(allowanceSummary("agency"), {
    workspaces: { display: "Multi-client workspace management planned", limit: null, classification: "planned" },
    users: { display: "Allowance planned", limit: null, classification: "planned" },
    connections: { display: "Allowance planned", limit: null, classification: "planned" }
  });
});

test("Move semantics distinguish meaningful results from zero-Move activity", () => {
  assert.equal(MOVE_METERING_CONFIGURATION.unit, "move");
  assert.equal(MOVE_METERING_CONFIGURATION.definition, "One Move is one meaningful AI or automated result.");
  assert.equal(MOVE_METERING_CONFIGURATION.enforcementStatus, "not_active");
  assert.deepEqual(
    MOVE_METERING_CONFIGURATION.zeroMoveActivities.map(({ id, moves }) => ({ id, moves })),
    [
      { id: "manual-editing", moves: 0 },
      { id: "approvals", moves: 0 },
      { id: "dashboards", moves: 0 },
      { id: "ordinary-workspace-activity", moves: 0 }
    ]
  );
  assert.deepEqual(
    MOVE_METERING_CONFIGURATION.weights.map(({ id, moves, unit }) => ({ id, moves, unit })),
    [
      { id: "text-campaign-generation", moves: 1, unit: "completed_result" },
      { id: "audience-brief", moves: 1, unit: "completed_result" },
      { id: "automation-execution", moves: 1, unit: "completed_execution" },
      { id: "image-generation", moves: 5, unit: "generated_image" },
      { id: "rendered-video-minute", moves: 25, unit: "rendered_minute" }
    ]
  );
});

test("future Move weights are visibly planned and not represented as live metering", () => {
  for (const id of ["image-generation", "rendered-video-minute"]) {
    const weight = MOVE_METERING_CONFIGURATION.weights.find(item => item.id === id);
    assert.equal(weight.availability, "planned", id);
    assert.equal(weight.meteringStatus, "planned", id);
    assert.match(weight.detail, /future-only/i, id);
    assert.match(weight.detail, /not currently available or metered/i, id);
  }
  for (const id of ["text-campaign-generation", "audience-brief", "automation-execution"]) {
    const weight = MOVE_METERING_CONFIGURATION.weights.find(item => item.id === id);
    assert.equal(weight.availability, "available", id);
    assert.equal(weight.meteringStatus, "not_active", id);
    assert.match(weight.detail, /after Move balance enforcement is activated/i, id);
  }
});

test("Move packs and rollover terms are exact while purchase execution stays unavailable", () => {
  assert.deepEqual(
    MOVE_METERING_CONFIGURATION.packs.map(({ id, moves, priceCents, currency, status, purchase }) => ({ id, moves, priceCents, currency, status, purchase })),
    [
      { id: "move-pack-100", moves: 100, priceCents: 1000, currency: "usd", status: "planned", purchase: { available: false, status: "unavailable" } },
      { id: "move-pack-500", moves: 500, priceCents: 4000, currency: "usd", status: "planned", purchase: { available: false, status: "unavailable" } },
      { id: "move-pack-1500", moves: 1500, priceCents: 10000, currency: "usd", status: "planned", purchase: { available: false, status: "unavailable" } }
    ]
  );
  assert.deepEqual(MOVE_METERING_CONFIGURATION.includedMoves, { resetCadence: "billing_cycle", rollover: false });
  assert.deepEqual(MOVE_METERING_CONFIGURATION.purchasedMoves, {
    purchaseExecutionAvailable: false,
    purchaseStatus: "planned",
    expirationMonths: 12,
    requiresActiveSubscription: true
  });
});

test("gpt-4.1-mini currency accounting uses microUSD per million tokens and preserves safety caps", () => {
  assert.deepEqual(OPENAI_COST_ACCOUNTING_DEFAULTS, {
    provider: "openai",
    model: "gpt-4.1-mini",
    currency: "usd",
    rateUnit: "microUSD_per_million_tokens",
    inputCostPerMillionMicroUsd: 400_000,
    outputCostPerMillionMicroUsd: 1_600_000,
    safetyCaps: {
      scope: "workspace",
      dailyRequests: 40,
      monthlyRequests: 500,
      monthlyTokens: 1_500_000
    }
  });
});

test("support metadata promises no SLA, guaranteed response time, or continuous coverage", () => {
  for (const plan of PRICING_CONFIGURATION.plans) {
    assert.equal(plan.support.classification, "planned");
    assert.equal(plan.support.serviceLevelAgreement, null);
    assert.equal(plan.support.guaranteedResponseTime, null);
    assert.doesNotMatch(`${plan.support.label} ${plan.support.detail}`, /24\s*\/\s*7|around-the-clock|guaranteed response|respond within|unlimited support/i);
    assert.match(plan.support.detail, /no response-time or availability guarantee/i);
  }
  const growth = PRICING_CONFIGURATION.plans.find(plan => plan.id === "growth");
  assert.equal(growth.support.label, "Priority support");
  assert.equal(growth.support.queuePriority, "priority");
  assert.match(growth.support.detail, /queue priority only/i);
});

test("Vizard is explicitly planned and unavailable across the catalog", () => {
  const vizard = PRICING_CONFIGURATION.providers.find(provider => provider.id === "vizard");
  assert.equal(vizard.status, "planned");
  assert.equal(vizard.availability, "unavailable");
  assert.match(vizard.disclosure, /not a complete customer-facing Vizard workflow/i);
  assert.match(vizard.disclosure, /submit, processing, ingestion, review, and publishing remain unavailable/i);
  assert.match(vizard.disclosure, /customer's own Vizard account/i);
  assert.match(vizard.disclosure, /Vizard bills its own processing charges/i);
  for (const plan of PRICING_CONFIGURATION.plans) {
    assert.equal(plan.capabilities.some(item => /vizard/i.test(`${item.id} ${item.label} ${item.detail}`)), false, plan.id);
  }
});

test("planned capabilities and agency isolation remain truthfully labeled", () => {
  const growth = PRICING_CONFIGURATION.plans.find(plan => plan.id === "growth");
  const agency = PRICING_CONFIGURATION.plans.find(plan => plan.id === "agency");
  assert.equal(growth.capabilities.find(item => item.id === "analytics-history").classification, "planned");
  assert.equal(agency.capabilities.find(item => item.id === "agency-oversight").classification, "planned");
  assert.equal(agency.capabilities.find(item => item.id === "branded-reports").classification, "planned");
  assert.deepEqual(
    agency.allowances.filter(item => ["workspaces", "users", "connections"].includes(item.id)).map(item => item.classification),
    ["planned", "planned", "planned"]
  );
  assert.match(agency.allowances.find(item => item.id === "workspaces").display, /planned/i);
  assert.equal(PRICING_CONFIGURATION.agencyDataPolicy, "Client data remains isolated by workspace and is never combined.");
});

test("guided setup and onboarding are universal rather than a plan, pilot, or add-on", () => {
  assert.deepEqual(PRICING_CONFIGURATION.standardExperiences, [{
    id: "guided-setup",
    label: "Guided setup and onboarding",
    classification: "available_not_tier_gated",
    detail: "Guided setup and onboarding are included for every Social Cues user on Business, Growth, and Agency."
  }]);
  for (const plan of PRICING_CONFIGURATION.plans) {
    assert.deepEqual(plan.capabilities.find(item => item.id === "guided-setup"), PRICING_CONFIGURATION.standardExperiences[0]);
  }
  assert.equal(PRICING_CONFIGURATION.services.some(service => /guided|pilot/i.test(`${service.id} ${service.name}`)), false);
  assert.equal(PRICING_CONFIGURATION.addOns.some(addOn => /guided|pilot/i.test(`${addOn.id} ${addOn.name}`)), false);
  assert.deepEqual(PRICING_CONFIGURATION.services.map(service => service.id), ["custom-implementation"]);
});
