import crypto from "node:crypto";

export const HEYGEN_DURABLE_CONTRACT_VERSION = "social-cues.heygen-durable.v1";
export const HEYGEN_DURABLE_INTERFACE_FINGERPRINT = "heygen-durable-v1-oauth-account-job-lineage";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const digestPattern = /^[A-Za-z0-9_-]{43}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const terminalJobStates = new Set(["completed", "failed"]);
const remoteRevocationStates = new Set([
  "remote_revocation_unavailable",
  "remote_revocation_confirmed",
  "remote_revocation_failed"
]);

export class HeyGenDurableRepositoryError extends Error {
  constructor(code, message, status = 503, kind = "unavailable") {
    super(message);
    this.name = "HeyGenDurableRepositoryError";
    this.code = code;
    this.status = status;
    this.kind = kind;
  }
}

function fail(code, message, status = 503, kind = "unavailable") {
  throw new HeyGenDurableRepositoryError(code, message, status, kind);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uuid(value, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!uuidPattern.test(normalized)) fail(code, "A verified hosted workspace identity is required.", 403, "invalid_input");
  return normalized;
}

function requiredText(value, code, maximum = 500) {
  const normalized = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!normalized || normalized.length > maximum) fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  return normalized;
}

function optionalText(value, code, maximum = 500) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, code, maximum);
}

function identifier(value, code, maximum = 500) {
  const normalized = requiredText(value, code, maximum);
  if (!identifierPattern.test(normalized)) fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  return normalized;
}

function digest(value, code) {
  const normalized = String(value || "").trim();
  if (!digestPattern.test(normalized)) fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  return normalized;
}

function timestamp(value, code) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  return new Date(parsed).toISOString();
}

function boundedObject(value, code, maximum = 16384) {
  if (!plainObject(value)) fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maximum) fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  return JSON.parse(serialized);
}

function remoteRevocation(value, code) {
  if (!plainObject(value) || Object.keys(value).sort().join(",") !== "attempted,state"
    || typeof value.attempted !== "boolean" || !remoteRevocationStates.has(value.state)
    || (value.attempted === false && value.state !== "remote_revocation_unavailable")
    || (value.attempted === true && value.state === "remote_revocation_unavailable")) {
    fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  }
  return Object.freeze({ attempted: value.attempted, state: value.state });
}

function operationSafeResult(value, code) {
  const result = boundedObject(value || {}, code, 4096);
  const keys = Object.keys(result).sort();
  if (!keys.length) return Object.freeze({});
  if (keys.join(",") === "refreshed" && result.refreshed === true) return Object.freeze({ refreshed: true });
  if (keys.join(",") === "failureCode" && typeof result.failureCode === "string"
    && result.failureCode.length <= 100 && identifierPattern.test(result.failureCode)) {
    return Object.freeze({ failureCode: result.failureCode });
  }
  if (keys.join(",") === "remoteRevocation") {
    return Object.freeze({ remoteRevocation: remoteRevocation(result.remoteRevocation, code) });
  }
  fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
}

function disconnectSafeResult(value, code) {
  const result = operationSafeResult(value, code);
  if (!result.remoteRevocation) fail(code, "HeyGen persistence input is invalid.", 400, "invalid_input");
  return result;
}

function encryptedEnvelope(value, code) {
  const envelope = boundedObject(value, code, 8192);
  const keys = Object.keys(envelope).sort();
  if (keys.join(",") !== "alg,iv,tag,value"
    || envelope.alg !== "aes-256-gcm"
    || !/^[A-Za-z0-9_-]{16}$/u.test(String(envelope.iv || ""))
    || !/^[A-Za-z0-9_-]{22}$/u.test(String(envelope.tag || ""))
    || !/^[A-Za-z0-9_-]{1,4096}$/u.test(String(envelope.value || ""))) {
    fail(code, "HeyGen encrypted credential storage is unavailable.", 503, "invalid_input");
  }
  return envelope;
}

function optionalEnvelope(value, code) {
  return value === null || value === undefined ? null : encryptedEnvelope(value, code);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function heyGenDurableFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("base64url");
}

function rpcObject(value, code) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!plainObject(candidate)) fail(code, "HeyGen durable persistence returned an invalid result.", 503, "invalid_result");
  return candidate;
}

function publicAccount(row) {
  if (!plainObject(row)) return null;
  return Object.freeze({
    id: row.id,
    platform: "heygen",
    oauthProvider: "heygen",
    providerAccountId: row.provider_account_id,
    name: row.display_name || "HeyGen",
    displayName: row.display_name || "HeyGen",
    handle: row.handle || row.display_name || "HeyGen",
    status: row.status,
    connectedAt: row.connected_at,
    credentialUpdatedAt: row.credential_updated_at || row.updated_at,
    ownerUserId: row.user_id,
    workspaceId: row.workspace_id,
    tokenType: row.token_type || "Bearer",
    tokenExpiresAt: row.expires_at || null,
    scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
    profile: plainObject(row.public_profile) ? JSON.parse(JSON.stringify(row.public_profile)) : {},
    connectionEvidence: "Durable HeyGen OAuth account and advertised MCP capabilities verified."
  });
}

function internalAccount(row, code = "heygen_account_result_invalid") {
  const account = publicAccount(row);
  if (!account) fail(code, "Connect this workspace's HeyGen account first.", 409, "not_found");
  return Object.freeze({
    ...account,
    credential: row.encrypted_token || null,
    refreshCredential: row.encrypted_refresh_token || null
  });
}

function publicJob(row) {
  if (!plainObject(row)) return null;
  return Object.freeze({
    id: row.id,
    provider: "heygen",
    action: row.action,
    operationId: row.operation_id,
    status: row.status,
    sourceAssetId: row.source_asset_id || null,
    parentVersionId: row.parent_asset_id || null,
    rootAssetId: row.root_asset_id || null,
    outputAssetId: row.output_asset_id || null,
    providerJobId: row.provider_job_id || null,
    sessionId: row.provider_session_id || null,
    capability: row.capability_id ? Object.freeze({ id: row.capability_id, toolName: row.capability_tool_name || "" }) : null,
    message: row.public_message || "",
    failureCode: row.failure_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    workspaceId: row.workspace_id,
    ownerUserId: row.requesting_user_id
  });
}

function publicVersion(row) {
  if (!plainObject(row)) return null;
  return Object.freeze({
    id: row.id,
    provider: "heygen",
    kind: row.kind || "video",
    title: row.title || "HeyGen video",
    status: row.status || "generated",
    contentType: row.content_type || "video/mp4",
    previewUrl: row.preview_url || null,
    providerResourceId: row.provider_resource_id || null,
    sourceAssetId: row.source_asset_id || null,
    parentVersionId: row.parent_asset_id || null,
    rootAssetId: row.root_asset_id || row.id,
    versionNumber: Number(row.version_number || 0),
    immutable: row.immutable === true,
    heygenSessionId: row.provider_session_id || null,
    heygenJobId: row.provider_job_id || null,
    operationId: row.operation_id,
    createdAt: row.created_at,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id
  });
}

function normalizeError(error) {
  if (error instanceof HeyGenDurableRepositoryError) return error;
  const detail = `${String(error?.code || "")} ${String(error?.message || error || "")}`;
  const mappings = [
    [/HEYGEN_NOT_AUTHORIZED/iu, "heygen_not_authorized", "This HeyGen record belongs to another workspace.", 403, "forbidden"],
    [/HEYGEN_(?:STATE_)?EXPIRED/iu, "oauth_state_expired", "HeyGen OAuth state expired.", 400, "invalid_input"],
    [/HEYGEN_STATE_(?:CONFLICT|REPLAYED|UNKNOWN|NOT_CONSUMABLE)/iu, "oauth_state_replayed", "HeyGen OAuth state was already used or is unknown.", 409, "conflict"],
    [/HEYGEN_STATE_OWNER_MISMATCH/iu, "oauth_state_owner_mismatch", "HeyGen OAuth state belongs to a different workspace.", 403, "forbidden"],
    [/HEYGEN_OPERATION_CONFLICT/iu, "heygen_operation_conflict", "That operation id was already used for different work.", 409, "conflict"],
    [/HEYGEN_OPERATION_IN_PROGRESS/iu, "heygen_operation_in_progress", "That HeyGen operation is already in progress.", 409, "conflict"],
    [/HEYGEN_ACCOUNT_REQUIRED/iu, "heygen_account_required", "Connect this workspace's HeyGen account first.", 409, "not_found"],
    [/HEYGEN_CREDITS_DEPLETED/iu, "heygen_credits_depleted", "This HeyGen account has no available generation credits.", 409, "conflict"],
    [/HEYGEN_CREDITS_UNVERIFIED/iu, "heygen_credits_unverified", "Refresh HeyGen account readiness before starting generation.", 409, "conflict"],
    [/HEYGEN_(?:SOURCE|PARENT|JOB|ASSET)_NOT_FOUND/iu, "heygen_lineage_not_found", "That HeyGen record is not available in this workspace.", 404, "not_found"],
    [/HEYGEN_(?:JOB|RESULT)_TERMINAL_CONFLICT/iu, "heygen_result_conflict", "That HeyGen job already has a different terminal result.", 409, "conflict"],
    [/PGRST20[245]|schema cache|Could not find the (?:table|function)|does not exist/iu, "heygen_durable_repository_pending", "HeyGen durable persistence is not installed.", 503, "schema_missing"]
  ];
  for (const [pattern, code, message, status, kind] of mappings) {
    if (pattern.test(detail)) return new HeyGenDurableRepositoryError(code, message, status, kind);
  }
  return new HeyGenDurableRepositoryError("heygen_durable_repository_unavailable", "HeyGen durable persistence is temporarily unavailable.", 503, "unavailable");
}

export function createHeyGenDurableRepository({ request } = {}) {
  if (typeof request !== "function") throw new TypeError("A Supabase request transport is required.");

  async function rpc(name, body) {
    try {
      return await request(`/rpc/${name}`, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async function issueOAuthState(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_oauth_state_issue", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_state_digest: digest(input.stateDigest, "heygen_state_digest_invalid"),
      p_protected_verifier: encryptedEnvelope(input.protectedVerifier, "heygen_verifier_envelope_invalid"),
      p_metadata: boundedObject(input.metadata, "heygen_metadata_invalid"),
      p_issued_at: timestamp(input.issuedAt, "heygen_state_time_invalid"),
      p_expires_at: timestamp(input.expiresAt, "heygen_state_time_invalid")
    }), "heygen_state_issue_result_invalid");
    if (result.outcome !== "issued") fail("heygen_state_issue_result_invalid", "HeyGen OAuth state could not be stored.");
    return Object.freeze({ issued: true });
  }

  async function consumeOAuthState(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_oauth_state_consume", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_state_digest: digest(input.stateDigest, "heygen_state_digest_invalid")
    }), "heygen_state_consume_result_invalid");
    if (result.outcome === "completed") {
      return Object.freeze({ replayed: true, account: internalAccount(result.account), capabilities: result.account?.public_profile?.capabilities || [] });
    }
    if (result.outcome === "expired") {
      fail("oauth_state_expired", "HeyGen OAuth state expired.", 400, "invalid_input");
    }
    if (result.outcome !== "consumed") fail("heygen_state_consume_result_invalid", "HeyGen OAuth state could not be consumed.");
    return Object.freeze({
      replayed: false,
      stateDigest: digest(result.state_digest, "heygen_state_digest_invalid"),
      verifier: encryptedEnvelope(result.protected_verifier, "heygen_verifier_envelope_invalid"),
      metadata: Object.freeze(boundedObject(result.metadata, "heygen_metadata_invalid"))
    });
  }

  async function cancelOAuthState(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_oauth_state_cancel", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_state_digest: digest(input.stateDigest, "heygen_state_digest_invalid")
    }), "heygen_state_cancel_result_invalid");
    if (result.outcome !== "cancelled") fail("heygen_state_cancel_result_invalid", "HeyGen OAuth state could not be cancelled.");
    return Object.freeze({ cancelled: true });
  }

  async function commitConnection(input = {}) {
    const account = input.account || {};
    const result = rpcObject(await rpc("social_cues_heygen_connection_commit", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_state_digest: digest(input.stateDigest, "heygen_state_digest_invalid"),
      p_connected_account_id: uuid(account.id, "heygen_account_id_invalid"),
      p_provider_account_id: requiredText(account.providerAccountId, "heygen_provider_account_invalid"),
      p_display_name: requiredText(account.displayName || account.name || "HeyGen", "heygen_display_name_invalid", 300),
      p_scopes: Array.isArray(account.scopes) ? account.scopes.map(value => requiredText(value, "heygen_scope_invalid", 200)).slice(0, 100) : [],
      p_public_profile: boundedObject(account.profile || {}, "heygen_profile_invalid"),
      p_encrypted_access_token: encryptedEnvelope(account.credential, "heygen_access_envelope_invalid"),
      p_encrypted_refresh_token: optionalEnvelope(account.refreshCredential, "heygen_refresh_envelope_invalid"),
      p_token_type: requiredText(account.tokenType || "Bearer", "heygen_token_type_invalid", 40),
      p_expires_at: account.tokenExpiresAt ? timestamp(account.tokenExpiresAt, "heygen_expiry_invalid") : null,
      p_connected_at: timestamp(account.connectedAt, "heygen_connected_time_invalid")
    }), "heygen_connection_result_invalid");
    return Object.freeze({ replayed: result.replayed === true, account: internalAccount(result.account) });
  }

  async function getAccount(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_account_context", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid")
    }), "heygen_account_context_invalid");
    return result.account ? internalAccount(result.account) : null;
  }

  async function beginAccountOperation(input = {}) {
    const action = requiredText(input.action, "heygen_operation_action_invalid", 40);
    if (!new Set(["refresh", "disconnect"]).has(action)) fail("heygen_operation_action_invalid", "HeyGen persistence input is invalid.", 400, "invalid_input");
    const result = rpcObject(await rpc("social_cues_heygen_account_operation_begin", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_action: action,
      p_operation_id: identifier(input.operationId, "heygen_operation_id_invalid"),
      p_request_fingerprint: digest(input.requestFingerprint, "heygen_operation_fingerprint_invalid")
    }), "heygen_operation_begin_result_invalid");
    if (!new Set(["acquired", "completed", "in_progress", "failed"]).has(result.outcome)) {
      fail("heygen_operation_begin_result_invalid", "HeyGen durable persistence returned an invalid result.");
    }
    return Object.freeze({
      outcome: result.outcome,
      account: result.account ? internalAccount(result.account) : null,
      safeResult: operationSafeResult(result.safe_result || {}, "heygen_operation_result_invalid")
    });
  }

  async function completeRefresh(input = {}) {
    const account = input.account || {};
    const result = rpcObject(await rpc("social_cues_heygen_refresh_complete", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_operation_id: identifier(input.operationId, "heygen_operation_id_invalid"),
      p_request_fingerprint: digest(input.requestFingerprint, "heygen_operation_fingerprint_invalid"),
      p_provider_account_id: requiredText(account.providerAccountId, "heygen_provider_account_invalid"),
      p_display_name: requiredText(account.displayName || account.name || "HeyGen", "heygen_display_name_invalid", 300),
      p_scopes: Array.isArray(account.scopes) ? account.scopes.map(value => requiredText(value, "heygen_scope_invalid", 200)).slice(0, 100) : [],
      p_public_profile: boundedObject(account.profile || {}, "heygen_profile_invalid"),
      p_encrypted_access_token: encryptedEnvelope(account.credential, "heygen_access_envelope_invalid"),
      p_encrypted_refresh_token: optionalEnvelope(account.refreshCredential, "heygen_refresh_envelope_invalid"),
      p_token_type: requiredText(account.tokenType || "Bearer", "heygen_token_type_invalid", 40),
      p_expires_at: account.tokenExpiresAt ? timestamp(account.tokenExpiresAt, "heygen_expiry_invalid") : null,
      p_credential_updated_at: timestamp(account.credentialUpdatedAt, "heygen_credential_time_invalid")
    }), "heygen_refresh_result_invalid");
    return Object.freeze({ replayed: result.replayed === true, account: internalAccount(result.account) });
  }

  async function completeDisconnect(input = {}) {
    const safeResult = disconnectSafeResult(input.safeResult, "heygen_disconnect_result_invalid");
    const result = rpcObject(await rpc("social_cues_heygen_disconnect_complete", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_operation_id: identifier(input.operationId, "heygen_operation_id_invalid"),
      p_request_fingerprint: digest(input.requestFingerprint, "heygen_operation_fingerprint_invalid"),
      p_safe_result: safeResult
    }), "heygen_disconnect_result_invalid");
    return Object.freeze({
      replayed: result.replayed === true,
      safeResult: disconnectSafeResult(result.safe_result, "heygen_disconnect_result_invalid")
    });
  }

  async function failAccountOperation(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_account_operation_fail", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_action: requiredText(input.action, "heygen_operation_action_invalid", 40),
      p_operation_id: identifier(input.operationId, "heygen_operation_id_invalid"),
      p_request_fingerprint: digest(input.requestFingerprint, "heygen_operation_fingerprint_invalid"),
      p_failure_code: requiredText(input.failureCode || "heygen_provider_failed", "heygen_failure_code_invalid", 100)
    }), "heygen_operation_failure_result_invalid");
    return Object.freeze({ failed: result.outcome === "failed" });
  }

  async function reserveJob(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_job_reserve", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_action: requiredText(input.action, "heygen_action_invalid", 80),
      p_operation_id: identifier(input.operationId, "heygen_operation_id_invalid"),
      p_request_fingerprint: digest(input.requestFingerprint, "heygen_request_fingerprint_invalid"),
      p_request_arguments: boundedObject(input.requestArguments || {}, "heygen_request_invalid"),
      p_source_asset_id: input.sourceAssetId ? uuid(input.sourceAssetId, "heygen_source_id_invalid") : null,
      p_parent_asset_id: input.parentVersionId ? uuid(input.parentVersionId, "heygen_parent_id_invalid") : null
    }), "heygen_job_reserve_result_invalid");
    return Object.freeze({
      replayed: result.replayed === true,
      job: publicJob(result.job),
      requestArguments: Object.freeze(boundedObject(result.request_arguments || input.requestArguments || {}, "heygen_request_invalid")),
      account: result.account ? internalAccount(result.account) : null
    });
  }

  async function getJobContext(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_job_context", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_job_id: uuid(input.jobId, "heygen_job_id_invalid")
    }), "heygen_job_context_invalid");
    return Object.freeze({
      job: publicJob(result.job),
      requestArguments: Object.freeze(boundedObject(result.request_arguments || {}, "heygen_request_invalid")),
      account: terminalJobStates.has(result.job?.status) ? null : internalAccount(result.account)
    });
  }

  async function transitionJob(input = {}) {
    const state = requiredText(input.state, "heygen_job_state_invalid", 40);
    if (!new Set(["processing", "failed", "completed"]).has(state)) fail("heygen_job_state_invalid", "HeyGen persistence input is invalid.", 400, "invalid_input");
    const result = rpcObject(await rpc("social_cues_heygen_job_transition", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid"),
      p_job_id: uuid(input.jobId, "heygen_job_id_invalid"),
      p_state: state,
      p_result_fingerprint: digest(input.resultFingerprint, "heygen_result_fingerprint_invalid"),
      p_provider_job_id: optionalText(input.providerJobId, "heygen_provider_job_invalid"),
      p_provider_session_id: optionalText(input.sessionId, "heygen_provider_session_invalid"),
      p_capability_id: optionalText(input.capabilityId, "heygen_capability_invalid", 120),
      p_capability_tool_name: optionalText(input.capabilityToolName, "heygen_capability_invalid", 200),
      p_provider_resource_id: optionalText(input.providerResourceId, "heygen_resource_invalid"),
      p_preview_url: optionalText(input.previewUrl, "heygen_preview_invalid", 2000),
      p_title: optionalText(input.title, "heygen_title_invalid", 200),
      p_failure_code: optionalText(input.failureCode, "heygen_failure_code_invalid", 100),
      p_public_message: optionalText(input.publicMessage, "heygen_message_invalid", 500)
    }), "heygen_job_transition_result_invalid");
    return Object.freeze({ replayed: result.replayed === true, job: publicJob(result.job), version: publicVersion(result.version) });
  }

  async function listJobs(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_jobs_list", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid")
    }), "heygen_jobs_list_invalid");
    if (!Array.isArray(result.jobs)) fail("heygen_jobs_list_invalid", "HeyGen durable persistence returned an invalid result.");
    return result.jobs.map(publicJob).filter(Boolean);
  }

  async function listVersions(input = {}) {
    const result = rpcObject(await rpc("social_cues_heygen_versions_list", {
      p_actor_user_id: uuid(input.actorId, "heygen_actor_invalid"),
      p_workspace_id: uuid(input.workspaceId, "heygen_workspace_invalid")
    }), "heygen_versions_list_invalid");
    if (!Array.isArray(result.versions)) fail("heygen_versions_list_invalid", "HeyGen durable persistence returned an invalid result.");
    return result.versions.map(publicVersion).filter(Boolean);
  }

  async function probeReadiness() {
    try {
      const result = rpcObject(await rpc("social_cues_heygen_repository_health", {}), "heygen_health_result_invalid");
      return Object.freeze({
        ready: result.contract_version === HEYGEN_DURABLE_CONTRACT_VERSION
          && result.interface_fingerprint === HEYGEN_DURABLE_INTERFACE_FINGERPRINT,
        contractVersion: result.contract_version || null,
        interfaceFingerprint: result.interface_fingerprint || null,
        state: "database_ready"
      });
    } catch (error) {
      const normalized = normalizeError(error);
      return Object.freeze({ ready: false, contractVersion: null, interfaceFingerprint: null, state: normalized.kind === "schema_missing" ? "database_migration_missing" : "database_unavailable" });
    }
  }

  return Object.freeze({
    issueOAuthState,
    consumeOAuthState,
    cancelOAuthState,
    commitConnection,
    getAccount,
    beginAccountOperation,
    completeRefresh,
    completeDisconnect,
    failAccountOperation,
    reserveJob,
    getJobContext,
    transitionJob,
    listJobs,
    listVersions,
    probeReadiness
  });
}

export function sanitizeHeyGenDurableRepositoryError(error) {
  const normalized = normalizeError(error);
  return Object.freeze({ ok: false, code: normalized.code, error: normalized.message, status: normalized.status });
}
