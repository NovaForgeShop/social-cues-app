import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ALPHA_DISCOUNT_POLICY,
  alphaDiscountEligible,
  createAlphaDiscountEligibility,
  normalizeAlphaDiscountAccount,
  publicAlphaDiscountEligibility
} from "./alpha-discount.mjs";

const moduleUrl = new URL("./alpha-discount.mjs", import.meta.url);

test("Alpha policy is exact, immutable, and grants no product entitlement", () => {
  assert.equal(ALPHA_DISCOUNT_POLICY.label, "Alpha discount: 20% off forever");
  assert.equal(ALPHA_DISCOUNT_POLICY.percentOff, 20);
  assert.equal(ALPHA_DISCOUNT_POLICY.duration, "forever");
  assert.equal(ALPHA_DISCOUNT_POLICY.appliesTo, "subscription");
  assert.deepEqual(ALPHA_DISCOUNT_POLICY.applicablePlanIds, ["business", "growth", "agency"]);
  assert.equal(ALPHA_DISCOUNT_POLICY.accountScoped, true);
  assert.equal(ALPHA_DISCOUNT_POLICY.reusableAfterCancellation, true);
  assert.deepEqual(new Set(Object.values(ALPHA_DISCOUNT_POLICY.grants)), new Set([false]));
  assert.equal(Object.isFrozen(ALPHA_DISCOUNT_POLICY), true);
  assert.equal(Object.isFrozen(ALPHA_DISCOUNT_POLICY.grants), true);
});

test("request-controlled discount terms cannot override the canonical policy", () => {
  const eligibility = createAlphaDiscountEligibility({
    percentOff: 99,
    duration: "once",
    applicablePlanIds: ["fake-paid-plan"],
    grants: { appAccess: true },
    eligibleAt: "2026-09-13T00:00:00.000Z"
  });
  assert.equal(eligibility.percentOff, 20);
  assert.equal(eligibility.duration, "forever");
  assert.deepEqual(eligibility.applicablePlanIds, ["business", "growth", "agency"]);
  assert.equal("grants" in eligibility, false);
});

test("legacy Alpha access is normalized into discount-only account eligibility", () => {
  const legacyAccount = {
    id: "legacy-alpha-user",
    role: "Alpha tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    entitlement: {
      access: "highest-tier-test",
      source: "promo-code",
      promoCode: "PRIVATE-CODE",
      active: true,
      fullAccess: true,
      daysFree: 120,
      monthsFree: 4,
      expiresAt: "2026-05-01T00:00:00.000Z",
      billingStartsAfter: "2026-05-01T00:00:00.000Z",
      selectedPlan: "Social Cues highest tier tester access",
      tier: "highest",
      subscriptionPaid: true,
      appFeePaid: true,
      paymentStatus: "promo-paid",
      alphaHonorDiscountPercent: 10,
      alphaPremiumPercent: 25,
      deactivatesBeforeAlpha: false,
      grantedAt: "2026-01-01T00:00:00.000Z",
      grantedReason: "120-day no-charge highest-tier test account"
    }
  };
  const normalized = normalizeAlphaDiscountAccount(legacyAccount);
  assert.equal(normalized.role, "Member");
  assert.equal(normalized.entitlement.active, false);
  assert.equal(normalized.entitlement.access, "unpaid");
  assert.equal(normalized.entitlement.source, "none");
  assert.equal(normalized.entitlement.subscriptionPaid, false);
  assert.equal(normalized.entitlement.appFeePaid, false);
  assert.equal(normalized.entitlement.expiresAt, null);
  assert.equal(normalized.alphaDiscount.percentOff, 20);
  assert.equal(normalized.alphaDiscount.duration, "forever");
  assert.equal(normalized.alphaDiscount.eligibleAt, "2026-01-01T00:00:00.000Z");
  assert.equal(JSON.stringify(normalized).includes("PRIVATE-CODE"), false);
  assert.equal(alphaDiscountEligible(normalized), true);
});

test("ordinary Stripe lifecycle changes preserve Alpha eligibility without changing access truth", () => {
  const eligible = normalizeAlphaDiscountAccount({
    alphaDiscount: createAlphaDiscountEligibility({ eligibleAt: "2026-09-01T00:00:00.000Z" }),
    entitlement: {
      access: "business",
      source: "stripe",
      active: true,
      fullAccess: true,
      subscriptionPaid: true,
      appFeePaid: true,
      paymentStatus: "paid",
      selectedPlan: "business"
    }
  });
  assert.equal(eligible.entitlement.active, true);
  assert.equal(eligible.entitlement.source, "stripe");
  const canceled = normalizeAlphaDiscountAccount({
    ...eligible,
    entitlement: {
      access: "unpaid",
      source: "stripe",
      active: false,
      subscriptionPaid: false,
      appFeePaid: false,
      paymentStatus: "canceled",
      selectedPlan: "business"
    }
  });
  assert.equal(canceled.entitlement.active, false);
  assert.equal(canceled.alphaDiscount.eligible, true);
  assert.equal(canceled.alphaDiscount.percentOff, 20);
  assert.equal(canceled.alphaDiscount.duration, "forever");
});

test("public eligibility is safe for eligible and unredeemed accounts", () => {
  const eligible = publicAlphaDiscountEligibility({
    alphaDiscount: createAlphaDiscountEligibility({ eligibleAt: "2026-09-01T00:00:00.000Z" }),
    entitlement: {}
  });
  const unredeemed = publicAlphaDiscountEligibility({ entitlement: {} });
  assert.equal(eligible.eligible, true);
  assert.equal(unredeemed.eligible, false);
  assert.equal(eligible.label, "Alpha discount: 20% off forever");
  assert.deepEqual(new Set(Object.values(eligible.grants)), new Set([false]));
  assert.equal(Object.isFrozen(eligible), true);
  assert.equal("code" in eligible, false);
  assert.equal("promoCode" in eligible, false);
});

test("Alpha domain is pure and provider-hermetic", async () => {
  const source = await readFile(moduleUrl, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /process\.env|fetch\s*\(|node:(?:http|https|net|tls)|stripe\.com|supabase/i);
});
