const classificationLabels = Object.freeze({
  currently_enforced: "Currently enforced",
  currently_measured_not_enforced: "Measured, not plan-enforced",
  available_not_tier_gated: "Available, not tier-gated",
  planned: "Planned",
  unsupported: "Unsupported"
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function allowance(id, label, display, classification, detail, policy = {}) {
  return {
    id,
    label,
    display,
    classification,
    detail,
    ...policy
  };
}

function capability(id, label, classification, detail) {
  return { id, label, classification, detail };
}

function support(label, queuePriority, detail) {
  return {
    label,
    classification: "planned",
    queuePriority,
    serviceLevelAgreement: null,
    guaranteedResponseTime: null,
    detail
  };
}

const sharedCapabilities = [
  capability("publishing-calendar", "Publishing calendar", "available_not_tier_gated", "Calendar and scheduling workflows are available; provider publishing still depends on each connected provider's approval and permissions."),
  capability("approval-workflow", "Approval workflow", "available_not_tier_gated", "Human review and approval controls are available across current plans."),
  capability("response-management", "Response management", "available_not_tier_gated", "The response inbox is available where connected providers supply supported comment or message data."),
  capability("core-analytics", "Core analytics", "available_not_tier_gated", "Current provider and manual evidence views are available; history length is not yet differentiated by plan."),
  capability("commerce-context", "Supported commerce connections", "available_not_tier_gated", "Supported commerce context is available only after the customer connects and authorizes the relevant provider."),
  capability("workspace-isolation", "Workspace tenant isolation", "currently_enforced", "Authentication and workspace boundaries isolate customer records and provider credentials.")
];

function plan({ id, name, monthlyPriceCents, description, intendedCustomer, workspaceAllowance, userAllowance, connectionAllowance, extraCapabilities = [], planSupport }) {
  return {
    id,
    name,
    billingInterval: "month",
    currency: "usd",
    priceType: "list",
    monthlyPriceCents,
    description,
    intendedCustomer,
    allowances: [
      workspaceAllowance,
      userAllowance,
      connectionAllowance,
      allowance("intelligence-credits", "Intelligence Credits", "Allowance pending cost validation", "currently_measured_not_enforced", "AI requests and tokens are measured, but plan-specific credit allowances are not yet defined or enforced. Requests remain subject to server safety and cost controls.", { serverBounded: true }),
      allowance("media-storage", "Media storage", "Allowance pending cost validation", "currently_measured_not_enforced", "Media assets are counted and per-file upload size is enforced; aggregate storage is not yet plan-gated and remains subject to server limits.", { serverBounded: true }),
      allowance("automation", "Automation capacity", "Allowance pending cost validation", "currently_measured_not_enforced", "Worker jobs are measured, but plan-specific automation allowances are not yet enforced and remain subject to server limits.", { serverBounded: true })
    ],
    capabilities: [...sharedCapabilities, ...extraCapabilities],
    support: planSupport,
    plannedAddOnIds: ["additional-workspace", "additional-user", "connection-pack", "intelligence-credit-pack", "additional-storage", "automation-capacity"]
  };
}

export const PRICING_CONFIGURATION = deepFreeze({
  version: "2026-08-02",
  defaultPlanId: "business",
  currency: "usd",
  billingInterval: "month",
  priceType: "list",
  positioning: "Social Cues brings publishing, responses, campaign coordination, connected business data, media workflows, and audience intelligence into one workspace.",
  classificationLabels,
  plans: [
    plan({
      id: "business",
      name: "Business",
      monthlyPriceCents: 9900,
      description: "Operate one brand from a coordinated workspace.",
      intendedCustomer: "One business managing its own brand.",
      workspaceAllowance: allowance("workspaces", "Workspaces", "1 workspace", "currently_measured_not_enforced", "Workspace ownership is enforced; the package count is not yet enforced.", { limit: 1, unit: "workspace" }),
      userAllowance: allowance("users", "Users", "Up to 2 users", "currently_measured_not_enforced", "Workspace membership is measured; the package count is not yet enforced.", { limit: 2, unit: "user" }),
      connectionAllowance: allowance("connections", "Connected accounts", "Up to 10 social and business accounts", "currently_measured_not_enforced", "Connected accounts are measured; the package count is not yet enforced.", { limit: 10, unit: "connected-account" }),
      planSupport: support("Standard support", "standard", "The launch support policy is pending operational confirmation; no response-time or availability guarantee is offered.")
    }),
    plan({
      id: "growth",
      name: "Growth",
      monthlyPriceCents: 17900,
      description: "Coordinate a larger team, more campaigns, and higher operating volume.",
      intendedCustomer: "A business with a team, multiple campaigns, or higher operating volume.",
      workspaceAllowance: allowance("workspaces", "Workspaces", "1 workspace", "currently_measured_not_enforced", "Workspace ownership is enforced; the package count is not yet enforced.", { limit: 1, unit: "workspace" }),
      userAllowance: allowance("users", "Users", "Up to 5 users", "currently_measured_not_enforced", "Workspace membership is measured; the package count is not yet enforced.", { limit: 5, unit: "user" }),
      connectionAllowance: allowance("connections", "Connected accounts", "Up to 25 social and business accounts", "currently_measured_not_enforced", "Connected accounts are measured; the package count is not yet enforced.", { limit: 25, unit: "connected-account" }),
      extraCapabilities: [
        capability("team-roles", "Team roles and approvals", "available_not_tier_gated", "Workspace roles and approval controls exist, but expanded role behavior is not yet plan-gated."),
        capability("analytics-history", "Longer analytics history", "planned", "A plan-specific history window has not been implemented."),
        capability("commerce-reporting", "Commerce-informed campaign reporting", "available_not_tier_gated", "Commerce context and campaign evidence are available where a supported provider is connected; access is not yet plan-gated.")
      ],
      planSupport: support("Priority support", "priority", "Priority means queue priority only; no response-time or availability guarantee is offered.")
    }),
    plan({
      id: "agency",
      name: "Agency",
      monthlyPriceCents: 24900,
      description: "Planned package for coordinating separate client environments without mixing customer data.",
      intendedCustomer: "A consultant or small agency managing separate client environments.",
      workspaceAllowance: allowance("workspaces", "Client workspaces", "Up to 3 isolated client workspaces", "planned", "The current production app enforces tenant isolation but does not yet provide packaged multi-client workspace management.", { limit: 3, unit: "workspace" }),
      userAllowance: allowance("users", "Users", "5-8 users, pending cost validation", "planned", "A final user allowance and its enforcement are not yet approved.", { minimum: 5, maximum: 8, unit: "user" }),
      connectionAllowance: allowance("connections", "Connected accounts", "Allowance pending cost validation", "currently_measured_not_enforced", "Connected accounts are measured by workspace; the Agency package count is not yet defined or enforced."),
      extraCapabilities: [
        capability("client-approvals", "Client approval workflows", "available_not_tier_gated", "Approval workflows are available within an isolated workspace; agency-level oversight is not yet implemented."),
        capability("workspace-attributed-usage", "Workspace-attributed usage", "currently_measured_not_enforced", "Usage records carry workspace attribution, but Agency package limits are not enforced."),
        capability("agency-oversight", "Multi-client agency oversight", "planned", "A production agency console for multiple client workspaces is not yet available."),
        capability("branded-reports", "Branded report export", "planned", "Exports exist, but customer branding and Agency-specific report controls are not yet available.")
      ],
      planSupport: support("Agency support", null, "Agency support terms are pending operational confirmation; no response-time or availability guarantee is offered.")
    })
  ],
  addOns: [
    { id: "additional-workspace", name: "Additional workspace", status: "planned", price: null },
    { id: "additional-user", name: "Additional user", status: "planned", price: null },
    { id: "connection-pack", name: "Connection pack", status: "planned", price: null },
    { id: "intelligence-credit-pack", name: "Intelligence Credit pack", status: "planned", price: null },
    { id: "additional-storage", name: "Additional storage", status: "planned", price: null },
    { id: "automation-capacity", name: "Additional automation capacity", status: "planned", price: null }
  ],
  services: [
    { id: "guided-setup", name: "Guided Setup", status: "configurable", price: null, description: "Work with Social Cues to configure an authorized workspace and its initial operating workflow." },
    { id: "guided-pilot", name: "Guided Pilot", status: "configurable", price: null, description: "Work with Social Cues to configure, run, and evaluate a focused campaign or workflow. The purpose is to collect evidence, identify what worked, identify what did not, and determine practical next steps. Results vary." },
    { id: "custom-implementation", name: "Custom Implementation", status: "configurable", price: null, description: "Scope implementation support for an approved operational requirement." }
  ],
  providers: [
    { id: "vizard", name: "Vizard", status: "planned", availability: "unavailable", disclosure: "Vizard connection management is not a complete customer-facing Vizard workflow. Vizard submit, processing, ingestion, review, and publishing remain unavailable. Future use will require the customer's own Vizard account, and Vizard bills its own processing charges." }
  ],
  agencyDataPolicy: "Client data remains isolated by workspace and is never combined.",
  thirdPartyChargesDisclosure: "Social Cues subscription charges do not include fees from customer-owned providers. Each provider bills its own usage under the customer's agreement with that provider.",
  referralProgram: { status: "not_published" }
});

export function resolvePricingPlan(planId) {
  const normalizedPlanId = String(planId || "").trim().toLowerCase();
  const matchedPlan = PRICING_CONFIGURATION.plans.find(planItem => planItem.id === normalizedPlanId);
  if (!matchedPlan) return deepFreeze({ ok: false, reason: "unknown-plan", planId: normalizedPlanId });
  return deepFreeze({ ok: true, plan: matchedPlan });
}
