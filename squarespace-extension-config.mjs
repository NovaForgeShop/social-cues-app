function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const squarespaceExtensionConfig = deepFreeze({
  provider: "squarespace",
  application: {
    displayName: "Social Cues",
    description:
      "Social Cues helps merchants connect their own Squarespace website, select commerce information, create social campaigns, check inventory before promotion, and retain approval before public publishing or mutation.",
    homeUrl: "https://socialcuesapp.com",
    termsUrl: "https://socialcuesapp.com/terms",
    privacyUrl: "https://socialcuesapp.com/privacy",
    supportEmail: "mr.barton@socialcuesapp.com",
    iconAsset: "sc-icon-512.png"
  },
  portalRegistration: {
    section: "Developer Apps",
    state: "DEMO",
    stateLabel: "Demo Mode",
    createActionLabel: "Create",
    reviewActionLabel: "SUBMIT FOR REVIEW",
    reviewSubmitted: false,
    reviewPending: false,
    credentialsIssued: true,
    credentialsPending: false,
    iconConfigured: false,
    legalReviewBlocker:
      "The current Privacy Policy does not specifically describe Squarespace contacts, orders, transactions, analytics, marketing preferences, or commerce PII."
  },
  routes: {
    redirectUri: "https://socialcuesapp.com/api/oauth/squarespace/callback",
    initiateUrl: "https://socialcuesapp.com/api/oauth/squarespace/start",
    statusUrl: "https://socialcuesapp.com/api/oauth/squarespace/status"
  },
  oauth: {
    authorizeEndpoint: "https://login.squarespace.com/api/1/login/oauth/provider/authorize",
    tokenEndpoint: "https://login.squarespace.com/api/1/login/oauth/provider/tokens",
    accessType: "offline",
    scopes: [
      "website.products.read",
      "website.inventory.read",
      "website.orders.read",
      "website.transactions.read",
      "website.contacts.read",
      "website.discounts.read"
    ]
  },
  api: {
    baseUrl: "https://api.squarespace.com",
    userAgent: "SocialCues/0.3.0 (+https://socialcuesapp.com)",
    rateLimitPerMinute: 300,
    versions: {
      website: "1.0",
      products: "v2",
      inventory: "1.0",
      orders: "1.0",
      transactions: "1.0",
      contacts: "v1",
      analytics: "v1",
      discounts: "v1",
      webhooks: "1.0"
    },
    paths: {
      authenticatedMember: "/1.0/authorization/member",
      authenticatedWebsite: "/1.0/authorization/website",
      storePages: "/1.0/commerce/store_pages",
      products: "/v2/commerce/products",
      inventory: "/1.0/commerce/inventory",
      orders: "/1.0/commerce/orders",
      transactions: "/1.0/commerce/transactions",
      contacts: "/v1/contacts",
      contactQuery: "/v1/contacts/query",
      analyticsTransactionSummaries: "/v1/analytics/transaction-summaries",
      discounts: "/v1/commerce/discounts",
      webhookSubscriptions: "/1.0/webhook_subscriptions"
    }
  },
  webhooks: {
    subscriptionsSupported: true,
    subscriptionsCreatedInThisPhase: false,
    contactTopicScopeBlocker:
      "Current Squarespace documentation requires website.contacts for contact and address webhook topics; this read-only alpha requests only website.contacts.read.",
    intendedTopics: [
      "extension.uninstall",
      "order.create",
      "order.update",
      "contact.create",
      "contact.update",
      "contact.delete",
      "address.create",
      "address.update",
      "address.delete"
    ],
    productionLaws: [
      "Create subscriptions per connected Squarespace website using that website's OAuth token.",
      "Encrypt every subscription secret and map it to exactly one Social Cues workspace and website.",
      "Treat delivery as at least once and make duplicate notification IDs idempotent.",
      "Expect out-of-order events and provider retries after unsuccessful deliveries.",
      "Reconcile event payloads through the Squarespace API before high-impact actions.",
      "An extension.uninstall event disconnects only the mapped workspace connection.",
      "Preserve exact raw request bytes until signature verification finishes."
    ]
  },
  tenantAndPrivacyLaws: [
    "One Squarespace OAuth connection maps to exactly one Social Cues workspace.",
    "One OAuth token belongs to exactly one Squarespace website.",
    "No shared customer credential or global Squarespace API key fallback exists.",
    "Never resolve a token using only a provider website ID supplied by a request.",
    "Authorize the Social Cues workspace before resolving its encrypted provider token.",
    "Store future tokens only in normalized encrypted provider-token storage, never workspace_models.model.",
    "Scope contacts, orders, transactions, analytics, products, inventory, discounts, cursors, and webhook events to one workspace.",
    "Do not create a cross-workspace cache.",
    "Disconnect and uninstall disable only the mapped account.",
    "Treat the provider's marketing opt-in value as authoritative and never infer consent from order history.",
    "Do not pass contact PII to AI generation when aggregate commerce metrics are sufficient.",
    "Do not use raw addresses, phone numbers, or email addresses in campaign-generation prompts."
  ]
});
