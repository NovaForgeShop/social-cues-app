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
  repository = null,
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
    const issued = repository
      ? stateManager.issueRecord({
        actorId,
        workspaceId,
        verifier: pkce.verifier,
        metadata
      })
      : null;
    const state = issued?.state || stateManager.issue(ledger, {
      actorId,
      workspaceId,
      verifier: pkce.verifier,
      metadata
    });
    if (repository) {
      await repository.issueOAuthState({
        actorId,
        workspaceId,
        stateDigest: issued.record.stateHash,
        protectedVerifier: issued.record.protectedVerifier,
        metadata: issued.record.metadata,
        issuedAt: new Date(issued.record.issuedAt).toISOString(),
        expiresAt: new Date(issued.record.expiresAt).toISOString()
      });
    } else {
      await persistStateLedger({ ledger, actorId, workspaceId, reason: "heygen-oauth-state-issued" });
    }
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
    let durableState = null;
    let consumed;
    if (repository) {
      const verified = stateManager.verify(state, { actorId, workspaceId });
      durableState = await repository.consumeOAuthState({ actorId, workspaceId, stateDigest: verified.stateHash });
      if (durableState.replayed) {
        return {
          account: durableState.account,
          capabilities: durableState.capabilities || durableState.account?.profile?.capabilities || [],
          replayed: true
        };
      }
      consumed = {
        metadata: durableState.metadata,
        verifier: unprotectToken(durableState.verifier)
      };
      if (!consumed.verifier) throw appError("heygen_verifier_unavailable", "HeyGen OAuth state could not be decrypted.", 503);
    } else {
      consumed = stateManager.consume(ledger, { actorId, workspaceId, state });
      await persistStateLedger({ ledger, actorId, workspaceId, reason: "heygen-oauth-state-consumed" });
    }
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
    const account = {
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
      };
    if (repository) {
      const committed = await repository.commitConnection({
        actorId,
        workspaceId,
        stateDigest: durableState.stateDigest,
        account
      });
      return {
        account: committed.account,
        capabilities: committed.account.profile?.capabilities || capabilities,
        replayed: committed.replayed === true
      };
    }
    return {
      account,
      capabilities
    };
  }

  async function cancelOAuth({ ledger, actorId, workspaceId, state } = {}) {
    if (repository) {
      const verified = stateManager.verify(state, { actorId, workspaceId });
      await repository.cancelOAuthState({ actorId, workspaceId, stateDigest: verified.stateHash });
    } else {
      stateManager.consume(ledger, { actorId, workspaceId, state });
      await persistStateLedger({ ledger, actorId, workspaceId, reason: "heygen-oauth-state-cancelled" });
    }
    return { ok: true };
  }

  async function refreshAccount(account, { actorId, workspaceId, operationId } = {}) {
    if (!account || account.platform !== "heygen" || account.oauthProvider !== "heygen") {
      throw appError("heygen_account_required", "Connect HeyGen before refreshing access.", 409);
    }
    const requestFingerprint = crypto.createHash("sha256").update(JSON.stringify({ action: "refresh", accountId: account.id })).digest("base64url");
    let operation = null;
    let sourceAccount = account;
    if (repository) {
      operation = await repository.beginAccountOperation({ action: "refresh", actorId, workspaceId, operationId, requestFingerprint });
      if (operation.outcome === "completed") return operation.account;
      if (operation.outcome === "in_progress") throw appError("heygen_operation_in_progress", "That HeyGen refresh is already in progress.", 409);
      if (operation.outcome === "failed") throw appError("heygen_refresh_retry_required", "Start a new HeyGen refresh attempt.", 409);
      sourceAccount = operation.account;
    }
    try {
      const metadata = sourceAccount.profile?.oauthMetadata;
      const refreshToken = unprotectToken(sourceAccount.refreshCredential);
      const token = await oauthClient.refresh(metadata, {
        refreshToken,
        clientId: configuration.internal.clientId,
        clientSecret: configuration.internal.clientSecret
      });
      const mcp = mcpClientFactory(token.accessToken);
      const { identity, tools: advertisedTools } = await mcp.getCurrentUser();
      if (String(identity.accountId) !== String(sourceAccount.providerAccountId)) {
        throw appError("heygen_account_changed", "HeyGen refreshed a different account. Reconnect explicitly.", 409);
      }
      const now = clock();
      const capabilities = classifyHeyGenTools(advertisedTools);
      const refreshed = {
        ...sourceAccount,
        status: "connected",
        credential: protectToken(token.accessToken),
        refreshCredential: token.refreshToken ? protectToken(token.refreshToken) : sourceAccount.refreshCredential,
        credentialUpdatedAt: now.toISOString(),
        tokenExpiresAt: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000).toISOString() : sourceAccount.tokenExpiresAt || null,
        scopes: String(token.scope || "").split(/\s+/).filter(Boolean),
        profile: {
          ...(sourceAccount.profile || {}),
          plan: identity.plan || "",
          credits: identity.credits,
          advertisedTools: advertisedTools.slice(0, 100).map(tool => ({ name: clean(tool.name, 160) })),
          capabilities: capabilities.map(item => ({ id: item.id, label: item.label, toolName: item.toolName }))
        },
        connectionEvidence: "HeyGen access refreshed and current-user identity reverified."
      };
      if (!repository) return refreshed;
      return (await repository.completeRefresh({ actorId, workspaceId, operationId, requestFingerprint, account: refreshed })).account;
    } catch (error) {
      if (repository && operation?.outcome === "acquired") {
        await repository.failAccountOperation({ actorId, workspaceId, action: "refresh", operationId, requestFingerprint, failureCode: error?.code || "heygen_refresh_failed" }).catch(() => null);
      }
      throw error;
    }
  }

  async function disconnect(account, { actorId, workspaceId, operationId } = {}) {
    if (!account && !repository) return { remoteRevocation: { attempted: false, state: "remote_revocation_unavailable" } };
    const requestFingerprint = crypto.createHash("sha256").update(JSON.stringify({ action: "disconnect" })).digest("base64url");
    let operation = null;
    let sourceAccount = account;
    if (repository) {
      operation = await repository.beginAccountOperation({ action: "disconnect", actorId, workspaceId, operationId, requestFingerprint });
      if (operation.outcome === "completed") return { remoteRevocation: operation.safeResult.remoteRevocation || { attempted: false, state: "remote_revocation_unavailable" }, replayed: true };
      if (operation.outcome === "in_progress") throw appError("heygen_operation_in_progress", "That HeyGen disconnect is already in progress.", 409);
      if (operation.outcome === "failed") throw appError("heygen_disconnect_retry_required", "Start a new HeyGen disconnect attempt.", 409);
      sourceAccount = operation.account;
    }
    try {
      const token = unprotectToken(sourceAccount?.credential);
      let remoteRevocation = { attempted: false, state: "remote_revocation_unavailable" };
      if (token) {
        try {
          remoteRevocation = await oauthClient.revoke(sourceAccount.profile?.oauthMetadata, {
            token,
            clientId: configuration.internal.clientId,
            clientSecret: configuration.internal.clientSecret
          });
        } catch {
          remoteRevocation = { attempted: true, state: "remote_revocation_failed" };
        }
      }
      if (repository) {
        await repository.completeDisconnect({ actorId, workspaceId, operationId, requestFingerprint, safeResult: { remoteRevocation } });
      }
      return { remoteRevocation, replayed: false };
    } catch (error) {
      if (repository && operation?.outcome === "acquired") {
        await repository.failAccountOperation({ actorId, workspaceId, action: "disconnect", operationId, requestFingerprint, failureCode: error?.code || "heygen_disconnect_failed" }).catch(() => null);
      }
      throw error;
    }
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
