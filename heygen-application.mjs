import crypto from "node:crypto";
import {
  classifyHeyGenTools,
  heyGenReadiness
} from "./heygen-integration.mjs";
import { createHeyGenPkce } from "./heygen-oauth-client.mjs";

export class HeyGenApplicationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "HeyGenApplicationError";
    this.code = code;
    this.status = status;
  }
}

function appError(code, message, status = 400) {
  return new HeyGenApplicationError(code, message, status);
}

function clean(value = "", max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function safeMetadata(metadata = {}) {
  return {
    resource: metadata.resource,
    issuer: metadata.issuer,
    authorizationEndpoint: metadata.authorizationEndpoint,
    tokenEndpoint: metadata.tokenEndpoint,
    registrationEndpoint: metadata.registrationEndpoint || null,
    revocationEndpoint: metadata.revocationEndpoint || null,
    scopesSupported: [...(metadata.scopesSupported || [])],
    tokenEndpointAuthMethods: [...(metadata.tokenEndpointAuthMethods || [])]
  };
}

export function createHeyGenApplication({
  configuration,
  oauthClient,
  mcpClientFactory,
  stateManager,
  protectToken,
  unprotectToken,
  persistStateLedger = async () => {},
  clock = () => new Date(),
  createId = prefix => prefix + "-" + crypto.randomBytes(12).toString("base64url")
} = {}) {
  if (!configuration?.safeReadiness || !configuration?.internal) throw new TypeError("HeyGen configuration is required");
  if (!oauthClient || typeof mcpClientFactory !== "function" || !stateManager) throw new TypeError("HeyGen OAuth and MCP clients are required");
  if (typeof protectToken !== "function" || typeof unprotectToken !== "function") throw new TypeError("HeyGen token protection is required");

  function readiness({ account = null, durableRepositoryReady = true } = {}) {
    return heyGenReadiness({ configuration, account, durableRepositoryReady });
  }

  async function beginOAuth({ ledger, actorId, workspaceId, scopes = [] } = {}) {
    if (configuration.safeReadiness.state !== "oauth_discovery_required") {
      throw appError(configuration.safeReadiness.state, "HeyGen OAuth remains unavailable until domain approval and client registration are complete.", 503);
    }
    const metadata = await oauthClient.discover();
    const pkce = createHeyGenPkce();
    const state = stateManager.issue(ledger, {
      actorId,
      workspaceId,
      verifier: pkce.verifier,
      metadata
    });
    await persistStateLedger({ ledger, actorId, workspaceId, reason: "heygen-oauth-state-issued" });
    return {
      authorizationUrl: oauthClient.authorizationUrl(metadata, {
        clientId: configuration.internal.clientId,
        state,
        codeChallenge: pkce.challenge,
        scopes
      }),
      state,
      callbackUrl: configuration.safeReadiness.callbackUrl,
      metadata: safeMetadata(metadata)
    };
  }

  async function completeOAuth({ ledger, actorId, workspaceId, state, code } = {}) {
    const consumed = stateManager.consume(ledger, { actorId, workspaceId, state });
    await persistStateLedger({ ledger, actorId, workspaceId, reason: "heygen-oauth-state-consumed" });
    const token = await oauthClient.exchangeCode(consumed.metadata, {
      code,
      verifier: consumed.verifier,
      clientId: configuration.internal.clientId,
      clientSecret: configuration.internal.clientSecret
    });
    if (String(token.tokenType || "Bearer").toLowerCase() !== "bearer") {
      throw appError("heygen_token_type_invalid", "HeyGen returned an unsupported access-token type.", 502);
    }
    const mcp = mcpClientFactory(token.accessToken);
    const { identity, tools: advertisedTools } = await mcp.getCurrentUser();
    const capabilities = classifyHeyGenTools(advertisedTools);
    if (!capabilities.some(item => item.id === "current_user")) {
      throw appError("heygen_identity_capability_missing", "HeyGen did not advertise an account-identity capability.", 502);
    }
    const now = clock();
    return {
      account: {
        id: createId("acct-heygen"),
        platform: "heygen",
        oauthProvider: "heygen",
        providerAccountId: identity.accountId,
        name: identity.displayName || "HeyGen",
        displayName: identity.displayName || "HeyGen",
        handle: identity.displayName || "HeyGen",
        status: "connected",
        connectedAt: now.toISOString(),
        credentialUpdatedAt: now.toISOString(),
        ownerUserId: actorId,
        workspaceId,
        tokenType: "Bearer",
        tokenExpiresAt: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000).toISOString() : null,
        credential: protectToken(token.accessToken),
        refreshCredential: token.refreshToken ? protectToken(token.refreshToken) : null,
        scopes: String(token.scope || "").split(/\s+/).filter(Boolean),
        profile: {
          plan: identity.plan || "",
          credits: identity.credits,
          advertisedTools: advertisedTools.slice(0, 100).map(tool => ({ name: clean(tool.name, 160) })),
          capabilities: capabilities.map(item => ({ id: item.id, label: item.label, toolName: item.toolName })),
          oauthMetadata: safeMetadata(consumed.metadata),
          billingRelationship: "customer-owned-heygen-plan"
        },
        connectionEvidence: "Authenticated HeyGen current-user identity and advertised MCP capabilities verified."
      },
      capabilities
    };
  }

  async function cancelOAuth({ ledger, actorId, workspaceId, state } = {}) {
    stateManager.consume(ledger, { actorId, workspaceId, state });
    await persistStateLedger({ ledger, actorId, workspaceId, reason: "heygen-oauth-state-cancelled" });
    return { ok: true };
  }

  async function refreshAccount(account) {
    if (!account || account.platform !== "heygen" || account.oauthProvider !== "heygen") {
      throw appError("heygen_account_required", "Connect HeyGen before refreshing access.", 409);
    }
    const metadata = account.profile?.oauthMetadata;
    const refreshToken = unprotectToken(account.refreshCredential);
    const token = await oauthClient.refresh(metadata, {
      refreshToken,
      clientId: configuration.internal.clientId,
      clientSecret: configuration.internal.clientSecret
    });
    const mcp = mcpClientFactory(token.accessToken);
    const { identity, tools: advertisedTools } = await mcp.getCurrentUser();
    if (String(identity.accountId) !== String(account.providerAccountId)) {
      throw appError("heygen_account_changed", "HeyGen refreshed a different account. Reconnect explicitly.", 409);
    }
    const now = clock();
    const capabilities = classifyHeyGenTools(advertisedTools);
    return {
      ...account,
      status: "connected",
      credential: protectToken(token.accessToken),
      refreshCredential: token.refreshToken ? protectToken(token.refreshToken) : account.refreshCredential,
      credentialUpdatedAt: now.toISOString(),
      tokenExpiresAt: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000).toISOString() : account.tokenExpiresAt || null,
      scopes: String(token.scope || "").split(/\s+/).filter(Boolean),
      profile: {
        ...(account.profile || {}),
        plan: identity.plan || "",
        credits: identity.credits,
        advertisedTools: advertisedTools.slice(0, 100).map(tool => ({ name: clean(tool.name, 160) })),
        capabilities: capabilities.map(item => ({ id: item.id, label: item.label, toolName: item.toolName }))
      },
      connectionEvidence: "HeyGen access refreshed and current-user identity reverified."
    };
  }

  async function disconnect(account) {
    if (!account) return { remoteRevocation: { attempted: false, state: "remote_revocation_unavailable" } };
    const token = unprotectToken(account.credential);
    const remoteRevocation = token
      ? await oauthClient.revoke(account.profile?.oauthMetadata, {
        token,
        clientId: configuration.internal.clientId,
        clientSecret: configuration.internal.clientSecret
      })
      : { attempted: false, state: "remote_revocation_unavailable" };
    return { remoteRevocation };
  }

  async function invokeAccountAction(account, { action, args = {}, operationId } = {}) {
    if (!account || account.platform !== "heygen" || account.oauthProvider !== "heygen") {
      throw appError("heygen_account_required", "Connect HeyGen before using video tools.", 409);
    }
    const accessToken = unprotectToken(account.credential);
    if (!accessToken) throw appError("heygen_token_unavailable", "Reconnect HeyGen before using video tools.", 409);
    const mcp = mcpClientFactory(accessToken);
    const invocation = await mcp.callAction(action, { ...args, operationId });
    return {
      outcome: invocation.outcome,
      capability: {
        id: invocation.capability.id,
        toolName: invocation.capability.toolName
      }
    };
  }

  return Object.freeze({
    readiness,
    beginOAuth,
    cancelOAuth,
    completeOAuth,
    refreshAccount,
    disconnect,
    invokeAccountAction
  });
}

export function sanitizeHeyGenApplicationError(error) {
  return Object.freeze({
    ok: false,
    code: error instanceof HeyGenApplicationError ? error.code : clean(error?.code || "heygen_unavailable", 100),
    error: error instanceof HeyGenApplicationError ? error.message : "HeyGen is temporarily unavailable.",
    status: error instanceof HeyGenApplicationError ? error.status : Number(error?.status || 503)
  });
}
