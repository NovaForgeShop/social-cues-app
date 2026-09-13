const CANONICAL_PLAN_IDS = Object.freeze(["business", "growth", "agency"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const ALPHA_DISCOUNT_POLICY = deepFreeze({
  id: "alpha-discount",
  version: "2026-09-13",
  label: "Alpha discount: 20% off forever",
  percentOff: 20,
  duration: "forever",
  appliesTo: "subscription",
  applicablePlanIds: CANONICAL_PLAN_IDS,
  accountScoped: true,
  reusableAfterCancellation: true,
  grants: {
    appAccess: false,
    subscription: false,
    plan: false,
    tier: false,
    features: false,
    moves: false,
    role: false,
    appFeeWaiver: false,
    freePeriod: false
  }
});

const LEGACY_ENTITLEMENT_FIELDS = Object.freeze([
  "promoCode",
  "promoLabel",
  "daysFree",
  "monthsFree",
  "alphaHonorDiscountPercent",
  "alphaPremiumPercent",
  "deactivatesBeforeAlpha",
  "memberOnly"
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isLegacyAlphaEntitlement(entitlement = {}) {
  const source = text(entitlement.source).toLowerCase();
  const access = text(entitlement.access).toLowerCase();
  const paymentStatus = text(entitlement.paymentStatus).toLowerCase();
  return source === "promo-code"
    || access === "highest-tier-test"
    || paymentStatus === "promo-paid"
    || Boolean(text(entitlement.promoCode))
    || LEGACY_ENTITLEMENT_FIELDS.some(field => Object.prototype.hasOwnProperty.call(entitlement, field));
}

function inactiveEntitlement() {
  return {
    access: "unpaid",
    source: "none",
    active: false,
    fullAccess: false,
    tier: "",
    subscriptionPaid: false,
    appFeePaid: false,
    paymentStatus: "unpaid",
    selectedPlan: "",
    expiresAt: null,
    billingStartsAfter: null,
    grantedAt: null,
    grantedReason: ""
  };
}

function withoutLegacyAlphaFields(entitlement = {}) {
  const sanitized = { ...entitlement };
  for (const field of LEGACY_ENTITLEMENT_FIELDS) delete sanitized[field];
  return sanitized;
}

export function createAlphaDiscountEligibility(options = {}) {
  const eligibleAt = text(options.eligibleAt) || null;
  return {
    policyId: ALPHA_DISCOUNT_POLICY.id,
    policyVersion: ALPHA_DISCOUNT_POLICY.version,
    label: ALPHA_DISCOUNT_POLICY.label,
    eligible: true,
    status: "eligible",
    percentOff: ALPHA_DISCOUNT_POLICY.percentOff,
    duration: ALPHA_DISCOUNT_POLICY.duration,
    appliesTo: ALPHA_DISCOUNT_POLICY.appliesTo,
    applicablePlanIds: [...ALPHA_DISCOUNT_POLICY.applicablePlanIds],
    accountScoped: true,
    reusableAfterCancellation: true,
    source: text(options.source) || "alpha-code",
    eligibleAt
  };
}

export function normalizeAlphaDiscountAccount(account = {}, options = {}) {
  const normalized = {
    ...account,
    entitlement: { ...(account?.entitlement || {}) }
  };
  const legacyEvidence = isLegacyAlphaEntitlement(normalized.entitlement)
    || text(normalized.role).toLowerCase() === "alpha tester";
  const existingEligible = normalized.alphaDiscount?.eligible === true;
  const eligible = options.eligible === false
    ? false
    : options.eligible === true || existingEligible || legacyEvidence;

  if (isLegacyAlphaEntitlement(normalized.entitlement)) {
    const source = text(normalized.entitlement.source).toLowerCase();
    if (source === "stripe" || source === "owner-allowlist") {
      normalized.entitlement = withoutLegacyAlphaFields(normalized.entitlement);
    } else {
      normalized.entitlement = inactiveEntitlement();
    }
  } else {
    normalized.entitlement = withoutLegacyAlphaFields(normalized.entitlement);
  }

  if (eligible) {
    normalized.alphaDiscount = createAlphaDiscountEligibility({
      eligibleAt: normalized.alphaDiscount?.eligibleAt
        || options.eligibleAt
        || account?.entitlement?.grantedAt
        || account?.createdAt,
      source: normalized.alphaDiscount?.source || options.source || (legacyEvidence ? "legacy-alpha-promo" : "alpha-code")
    });
    if (text(normalized.role).toLowerCase() === "alpha tester") normalized.role = "Member";
  } else {
    delete normalized.alphaDiscount;
  }

  return normalized;
}

export function alphaDiscountEligible(account = {}) {
  return normalizeAlphaDiscountAccount(account).alphaDiscount?.eligible === true;
}

export function publicAlphaDiscountEligibility(account = {}) {
  const eligibility = normalizeAlphaDiscountAccount(account).alphaDiscount;
  return deepFreeze({
    policyId: ALPHA_DISCOUNT_POLICY.id,
    policyVersion: ALPHA_DISCOUNT_POLICY.version,
    label: ALPHA_DISCOUNT_POLICY.label,
    eligible: eligibility?.eligible === true,
    status: eligibility?.eligible === true ? "eligible" : "not_redeemed",
    percentOff: ALPHA_DISCOUNT_POLICY.percentOff,
    duration: ALPHA_DISCOUNT_POLICY.duration,
    appliesTo: ALPHA_DISCOUNT_POLICY.appliesTo,
    applicablePlanIds: [...ALPHA_DISCOUNT_POLICY.applicablePlanIds],
    accountScoped: true,
    reusableAfterCancellation: true,
    eligibleAt: eligibility?.eligibleAt || null,
    grants: { ...ALPHA_DISCOUNT_POLICY.grants }
  });
}
