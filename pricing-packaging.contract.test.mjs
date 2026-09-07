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

const { PRICING_CONFIGURATION, resolvePricingPlan } = pricingModule;

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
      { id: "business", name: "Business", monthlyPriceCents: 9900, currency: "usd", billingInterval: "month", priceType: "list" },
      { id: "growth", name: "Growth", monthlyPriceCents: 17900, currency: "usd", billingInterval: "month", priceType: "list" },
      { id: "agency", name: "Agency", monthlyPriceCents: 24900, currency: "usd", billingInterval: "month", priceType: "list" }
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
  for (const planId of ["", "Business - $99", "founder-audit", "campaign-build", "pro", "price_12345678901234"]) {
    const result = resolvePricingPlan(planId);
    assert.equal(result.ok, false, planId);
    assert.equal(result.reason, "unknown-plan", planId);
    assert.equal("plan" in result, false, planId);
  }
});

test("catalog and resolver results are deeply immutable", () => {
  assertDeepFrozen(PRICING_CONFIGURATION);
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

test("AI and reasoning execution remain bounded without an invented entitlement", () => {
  for (const plan of PRICING_CONFIGURATION.plans) {
    const intelligence = plan.allowances.find(item => item.id === "intelligence-credits");
    assert.equal(intelligence.serverBounded, true);
    assert.equal(intelligence.classification, "currently_measured_not_enforced");
    assert.equal("limit" in intelligence, false);
    assert.match(intelligence.detail, /server safety and cost controls/i);
    assert.equal(plan.allowances.find(item => item.id === "media-storage").serverBounded, true);
    assert.equal(plan.allowances.find(item => item.id === "automation").serverBounded, true);
  }
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
  assert.equal(PRICING_CONFIGURATION.agencyDataPolicy, "Client data remains isolated by workspace and is never combined.");
});

test("Guided Pilot stays neutral, unpriced, and free of outcome promises", () => {
  const pilot = PRICING_CONFIGURATION.services.find(service => service.id === "guided-pilot");
  assert.equal(pilot.name, "Guided Pilot");
  assert.equal(pilot.price, null);
  assert.match(pilot.description, /collect evidence/i);
  assert.match(pilot.description, /Results vary\./);
  assert.doesNotMatch(`${pilot.name} ${pilot.description}`, /prove|validate|guarantee|success|profit|return on investment/i);
});
