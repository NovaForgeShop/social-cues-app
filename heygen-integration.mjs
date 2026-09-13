export const HEYGEN_MCP_ENDPOINT = "https://mcp.heygen.com/mcp/v1/";
export const HEYGEN_INTEGRATION_MODE = "mcp-oauth";
export const HEYGEN_OAUTH_CALLBACK = "https://socialcuesapp.com/api/oauth/heygen/callback";
export const HEYGEN_RELEASE_STAGE = "domain-approval-gated";

const trueValues = new Set(["1", "true", "yes", "approved", "whitelisted"]);

function text(value = "") {
  return String(value ?? "").trim();
}

function truthy(value = "") {
  return trueValues.has(text(value).toLowerCase());
}

function sameCanonicalEndpoint(value = "") {
  try {
    const candidate = new URL(value);
    const canonical = new URL(HEYGEN_MCP_ENDPOINT);
    return candidate.protocol === "https:"
      && candidate.username === ""
      && candidate.password === ""
      && candidate.search === ""
      && candidate.hash === ""
      && candidate.origin === canonical.origin
      && candidate.pathname.replace(/\/+$/, "/") === canonical.pathname;
  } catch {
    return false;
  }
}

export function resolveHeyGenConfiguration(env = {}) {
  const endpoint = text(env.HEYGEN_MCP_URL) || HEYGEN_MCP_ENDPOINT;
  const mode = text(env.HEYGEN_INTEGRATION_MODE) || HEYGEN_INTEGRATION_MODE;
  const domainWhitelisted = truthy(env.HEYGEN_DOMAIN_WHITELISTED);
  const clientId = text(env.HEYGEN_OAUTH_CLIENT_ID);
  const clientSecret = text(env.HEYGEN_OAUTH_CLIENT_SECRET);
  const endpointValid = sameCanonicalEndpoint(endpoint);
  const modeValid = mode === HEYGEN_INTEGRATION_MODE;
  const secureTokenStorage = !env.VERCEL || Boolean(text(env.OAUTH_TOKEN_ENCRYPTION_KEY));
  const missingEnv = [];
  if (!secureTokenStorage) missingEnv.push("OAUTH_TOKEN_ENCRYPTION_KEY");
  if (!domainWhitelisted) missingEnv.push("HEYGEN_DOMAIN_WHITELISTED");
  if (!clientId) missingEnv.push("HEYGEN_OAUTH_CLIENT_ID");

  const state = !endpointValid
    ? "mcp_endpoint_invalid"
    : !modeValid
      ? "integration_mode_invalid"
      : !secureTokenStorage
        ? "token_encryption_missing"
      : !domainWhitelisted
        ? "domain_approval_pending"
        : !clientId
          ? "oauth_registration_pending"
          : "oauth_discovery_required";

  return Object.freeze({
    internal: Object.freeze({ endpoint, clientId, clientSecret }),
    safeReadiness: Object.freeze({
      provider: "heygen",
      releaseStage: HEYGEN_RELEASE_STAGE,
      state,
      readyToDiscover: state === "oauth_discovery_required",
      endpoint: endpointValid ? HEYGEN_MCP_ENDPOINT : null,
      endpointValid,
      integrationMode: mode,
      modeValid,
      secureTokenStorage,
      domain: "socialcuesapp.com",
      domainWhitelisted,
      callbackUrl: HEYGEN_OAUTH_CALLBACK,
      oauthRegistration: clientId ? "configured" : "pending-provider-instructions",
      oauthClientType: clientSecret ? "confidential" : clientId ? "public-pkce" : "unavailable",
      customerCredentialModel: "customer-owned OAuth account and HeyGen credits",
      socialCuesResellsCredits: false,
      missingEnv: Object.freeze(missingEnv)
    })
  });
}

const capabilityDefinitions = Object.freeze({
  current_user: Object.freeze({
    label: "Account identity",
    names: Object.freeze(["get_current_user", "current_user"]),
    mutates: false,
    allowedArguments: Object.freeze([])
  }),
  prompt_to_video: Object.freeze({
    label: "Video Agent prompt-to-video",
    names: Object.freeze(["video_agent", "generate_video", "create_video_from_prompt"]),
    mutates: true,
    allowedArguments: Object.freeze(["prompt", "title", "brandKitId", "operationId"])
  }),
  revise_video: Object.freeze({
    label: "Video Agent chat revision",
    names: Object.freeze(["revise_video", "video_agent_revision", "chat_video_revision"]),
    mutates: true,
    allowedArguments: Object.freeze(["prompt", "sessionId", "sourceAssetId", "parentVersionId", "operationId"])
  }),
  session_resources: Object.freeze({
    label: "Session resources",
    names: Object.freeze(["get_session_resources", "list_session_resources"]),
    mutates: false,
    allowedArguments: Object.freeze(["sessionId", "sourceAssetId"])
  }),
  create_variant: Object.freeze({
    label: "Session video variant",
    names: Object.freeze(["create_video_variant", "generate_video_variant"]),
    mutates: true,
    allowedArguments: Object.freeze(["prompt", "sessionId", "sourceAssetId", "parentVersionId", "operationId"])
  }),
  avatar_video: Object.freeze({
    label: "Avatar or image video",
    names: Object.freeze(["generate_avatar_video", "create_avatar_video", "create_image_video"]),
    mutates: true,
    allowedArguments: Object.freeze(["prompt", "avatarId", "imageAssetId", "voiceId", "title", "operationId"])
  }),
  template_video: Object.freeze({
    label: "Template video",
    names: Object.freeze(["generate_template_video", "create_video_from_template"]),
    mutates: true,
    allowedArguments: Object.freeze(["templateId", "prompt", "title", "voiceId", "operationId"])
  }),
  list_voices: Object.freeze({
    label: "Voice catalog",
    names: Object.freeze(["list_voices", "get_voices"]),
    mutates: false,
    allowedArguments: Object.freeze(["locale"])
  }),
  replace_audio: Object.freeze({
    label: "Lip-sync or audio replacement",
    names: Object.freeze(["replace_video_audio", "lip_sync_video", "replace_audio"]),
    mutates: true,
    allowedArguments: Object.freeze(["sourceAssetId", "audioAssetId", "voiceId", "parentVersionId", "operationId"])
  }),
  translate_video: Object.freeze({
    label: "Video translation",
    names: Object.freeze(["translate_video", "video_translate"]),
    mutates: true,
    allowedArguments: Object.freeze(["sourceAssetId", "locale", "glossaryId", "parentVersionId", "operationId"])
  }),
  remove_fillers: Object.freeze({
    label: "Filler-word removal",
    names: Object.freeze(["remove_filler_words", "remove_fillers"]),
    mutates: true,
    allowedArguments: Object.freeze(["sourceAssetId", "parentVersionId", "operationId"])
  }),
  brand_resources: Object.freeze({
    label: "Brand kits and glossaries",
    names: Object.freeze(["list_brand_kits", "get_brand_kits", "list_glossaries", "get_glossaries"]),
    mutates: false,
    allowedArguments: Object.freeze(["locale"])
  }),
  job_status: Object.freeze({
    label: "Generation status",
    names: Object.freeze(["get_video_status", "get_generation_status", "get_job_status"]),
    mutates: false,
    allowedArguments: Object.freeze(["providerJobId", "sessionId", "operationId"])
  })
});

export const HEYGEN_CAPABILITY_DEFINITIONS = capabilityDefinitions;
export const HEYGEN_MEDIA_ACTIONS = Object.freeze(Object.keys(capabilityDefinitions)
  .filter(action => capabilityDefinitions[action].mutates));

function safeToolName(tool = {}) {
  return text(tool.name).slice(0, 160);
}

export function classifyHeyGenTools(tools = []) {
  const advertised = Array.isArray(tools) ? tools : [];
  const byName = new Map(advertised
    .filter(tool => tool && typeof tool === "object" && safeToolName(tool))
    .map(tool => [safeToolName(tool), tool]));
  const capabilities = [];
  for (const [id, definition] of Object.entries(capabilityDefinitions)) {
    const name = definition.names.find(candidate => byName.has(candidate));
    if (!name) continue;
    const tool = byName.get(name);
    capabilities.push(Object.freeze({
      id,
      label: definition.label,
      toolName: name,
      mutates: definition.mutates,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null
    }));
  }
  return Object.freeze(capabilities);
}

function accountConnection(account = null) {
  return Boolean(account
    && account.platform === "heygen"
    && account.oauthProvider === "heygen"
    && account.status === "connected"
    && account.providerAccountId
    && account.tokenStored !== false);
}

function creditState(account = null) {
  const credits = account?.profile?.credits;
  const rawRemaining = credits?.remaining;
  const hasRemaining = rawRemaining !== null && rawRemaining !== undefined && rawRemaining !== "" && Number.isFinite(Number(rawRemaining));
  const remaining = hasRemaining ? Number(rawRemaining) : null;
  if (credits?.available === false || (hasRemaining && remaining <= 0)) {
    return { state: "depleted", available: false, remaining };
  }
  if (credits?.available === true || (hasRemaining && remaining > 0)) {
    return { state: "available", available: true, remaining };
  }
  return { state: "unverified", available: false, remaining: null };
}

export function heyGenReadiness({ configuration, account = null, tools = null, durableRepositoryReady = true } = {}) {
  const safe = configuration?.safeReadiness || resolveHeyGenConfiguration({}).safeReadiness;
  const connected = accountConnection(account);
  const oauthIssuerVerified = Boolean(account?.profile?.oauthMetadata?.issuer);
  const capabilities = classifyHeyGenTools(tools || account?.profile?.advertisedTools || []);
  const credits = creditState(account);
  const identityTool = capabilities.some(item => item.id === "current_user");
  const generationTools = capabilities.filter(item => HEYGEN_MEDIA_ACTIONS.includes(item.id));
  const generationState = !connected
    ? "account_not_connected"
    : !identityTool
      ? "identity_capability_missing"
      : !credits.available
        ? credits.state === "depleted" ? "credits_depleted" : "credits_unverified"
        : !generationTools.length
          ? "generation_capability_missing"
          : !durableRepositoryReady
            ? "durable_repository_pending"
            : "ready";

  return Object.freeze({
    ok: true,
    provider: "heygen",
    releaseStage: safe.releaseStage,
    endpoint: safe.endpoint,
    callbackUrl: safe.callbackUrl,
    integrationMode: safe.integrationMode,
    customerCredentialModel: safe.customerCredentialModel,
    socialCuesResellsCredits: false,
    secureTokenStorage: Object.freeze({ ready: safe.secureTokenStorage }),
    durableRepository: Object.freeze({
      ready: Boolean(durableRepositoryReady),
      state: durableRepositoryReady ? "ready" : "writes_held"
    }),
    domainApproval: Object.freeze({ state: safe.domainWhitelisted ? "approved" : "pending", approved: safe.domainWhitelisted }),
    oauthDiscovery: Object.freeze({
      state: oauthIssuerVerified ? "verified" : safe.readyToDiscover ? "required" : "unavailable",
      verified: oauthIssuerVerified
    }),
    oauthRegistration: Object.freeze({ state: safe.oauthRegistration, configured: safe.oauthRegistration === "configured" }),
    authenticatedAccount: Object.freeze({ state: connected ? "connected" : "not_connected", connected }),
    credits: Object.freeze(credits),
    supportedTools: capabilities.map(item => ({ id: item.id, label: item.label, mutates: item.mutates })),
    generation: Object.freeze({ state: generationState, ready: generationState === "ready" }),
    connectRoute: safe.readyToDiscover ? "/api/oauth/heygen/start" : null,
    reconnectRoute: connected ? "/api/oauth/heygen/start" : null,
    disconnectRoute: connected ? "/api/heygen/disconnect" : null,
    refreshRoute: connected ? "/api/heygen/refresh" : null,
    missingEnv: [...safe.missingEnv]
  });
}

export function heyGenIntakeProjection() {
  return Object.freeze({
    submissionAuthorized: false,
    fields: Object.freeze([
      Object.freeze({ id: "operator_legal_name", value: null, state: "operator-input-required" }),
      Object.freeze({ id: "work_email", value: "mr.barton@socialcuesapp.com", state: "resolved" }),
      Object.freeze({ id: "company_name", value: "Social Cues App LLC", state: "legal-name-confirmation-required" }),
      Object.freeze({ id: "platform_description", value: "Social Cues is an AI-assisted social media management platform for small businesses, creators, marketers, and agencies. Users plan campaigns, generate and edit content, approve assets, schedule and publish through connected social accounts, and measure results.", state: "resolved" }),
      Object.freeze({ id: "integration_description", value: "Connect each user's own HeyGen account by OAuth to generate and revise videos with HeyGen Video Agent, avatars, voices, lip-sync, filler-word removal, and translation. Social Cues will version, preview, approve, schedule, and publish the resulting assets. Customers will not handle API keys. Production domain: socialcuesapp.com.", state: "resolved" }),
      Object.freeze({ id: "company_country", value: null, state: "legal-country-required" })
    ])
  });
}
