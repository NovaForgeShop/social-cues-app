import crypto from "node:crypto";

export const VIZARD_API_KEY_MAX_UTF8_BYTES = 3072;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const base64urlPattern = /^[A-Za-z0-9_-]+$/u;
const allowedActions = new Set(["connect", "replace", "disconnect"]);
const credentialStates = new Set(["pending_verification", "connected"]);
const encryptedValueMaxCharacters = 4096;
const publicErrorCodes = new Set([
  "invalid_request",
  "unsupported_media_type",
  "not_authenticated",
  "not_authorized",
  "connection_service_unavailable",
  "connection_update_failed"
]);
const safeAccountSelect = [
  "id",
  "workspace_id",
  "provider",
  "platform",
  "status",
  "connected_at",
  "created_at",
  "updated_at"
].join(",");

export class VizardConnectionServiceError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "VizardConnectionServiceError";
    this.code = code;
    this.status = status;
  }
}

function uuidValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return uuidPattern.test(normalized) ? normalized : "";
}

function requiredUuid(value, field) {
  const normalized = uuidValue(value);
  if (!normalized) {
    throw new VizardConnectionServiceError(
      "VIZARD_CONNECTION_CONTEXT_INVALID",
      `A valid ${field} is required.`,
      400
    );
  }
  return normalized;
}

export function vizardEncryptionReadiness(environment = process.env) {
  const keyMaterial = typeof environment?.OAUTH_TOKEN_ENCRYPTION_KEY === "string"
    ? environment.OAUTH_TOKEN_ENCRYPTION_KEY
    : "";
  const ready = keyMaterial.length > 0;
  return {
    ready,
    explicitKey: ready,
    missingEnv: ready ? [] : ["OAUTH_TOKEN_ENCRYPTION_KEY"]
  };
}

function validApiKey(value) {
  const apiKey = String(value || "").trim();
  if (!apiKey
    || Buffer.byteLength(apiKey, "utf8") > VIZARD_API_KEY_MAX_UTF8_BYTES
    || /[\r\n\0]/u.test(apiKey)) {
    throw new VizardConnectionServiceError(
      "VIZARD_API_KEY_INVALID",
      "Enter a valid Vizard API key.",
      400
    );
  }
  return apiKey;
}

function validatedEnvelope(envelope) {
  if (envelope.alg !== "aes-256-gcm"
    || envelope.iv.length !== 16
    || envelope.tag.length !== 22
    || envelope.value.length < 1
    || envelope.value.length > encryptedValueMaxCharacters
    || !base64urlPattern.test(envelope.iv)
    || !base64urlPattern.test(envelope.tag)
    || !base64urlPattern.test(envelope.value)) {
    throw new VizardConnectionServiceError(
      "VIZARD_CONNECTION_ENVELOPE_INVALID",
      "The Vizard API key could not be prepared.",
      500
    );
  }
  return Object.freeze(envelope);
}

export function encryptVizardApiKey(value, {
  keyMaterial = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "",
  randomBytes = crypto.randomBytes
} = {}) {
  const apiKey = validApiKey(value);
  if (!keyMaterial) {
    throw new VizardConnectionServiceError(
      "VIZARD_ENCRYPTION_KEY_REQUIRED",
      "Vizard connection storage is unavailable until OAUTH_TOKEN_ENCRYPTION_KEY is configured.",
      503
    );
  }
  const key = crypto.createHash("sha256").update(String(keyMaterial)).digest();
  const iv = randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return validatedEnvelope({
    alg: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    value: ciphertext.toString("base64url")
  });
}

export function isVizardJsonMediaType(value) {
  const header = Array.isArray(value) ? value[0] : value;
  const mediaType = String(header || "").split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
}

function verificationStateFor(row = {}) {
  return String(row.verification_state || row.verificationState || "").trim().toLowerCase()
    || (String(row.connection_state || row.status || "").trim().toLowerCase() === "pending_verification"
      ? "pending"
      : "not_verified");
}

export function publicVizardConnection(row = null, encryption = vizardEncryptionReadiness()) {
  const connectionState = String(row?.connection_state || row?.status || "not_connected").trim().toLowerCase()
    || "not_connected";
  const credentialStored = credentialStates.has(connectionState);
  return Object.freeze({
    connectedAccountId: row?.connected_account_id || row?.id || null,
    provider: "vizard",
    platform: "vizard",
    connectionState,
    verificationState: verificationStateFor(row || {}),
    credentialStored,
    connected: connectionState === "connected",
    canReplace: credentialStored,
    canDisconnect: credentialStored,
    connectedAt: row?.connected_at || null,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
    credentialStorageAvailable: Boolean(encryption.ready),
    apiKeyMaxUtf8Bytes: VIZARD_API_KEY_MAX_UTF8_BYTES
  });
}

export function normalizeVizardConnectionError(error, { operation = "update" } = {}) {
  if (error instanceof VizardConnectionServiceError && publicErrorCodes.has(error.code)) return error;
  const detail = `${String(error?.code || "")} ${String(error?.message || error || "")}`;
  const mappings = [
    [/VIZARD_UNSUPPORTED_MEDIA_TYPE/iu, "unsupported_media_type", "Send the Vizard API key as JSON.", 415],
    [/VIZARD_API_KEY_INVALID/iu, "invalid_request", "Enter a valid Vizard API key.", 400],
    [/VIZARD_CONNECTION_(?:CONTEXT|ACTION|REQUEST|ENVELOPE)_/iu, "invalid_request", "The Vizard connection request is invalid.", 400],
    [/VIZARD_CONNECTION_NOT_AUTHORIZED/iu, "not_authorized", "You do not have permission to manage this workspace connection.", 403],
    [/VIZARD_CONNECTION_(?:ALREADY_STORED|CONFLICT)/iu, "connection_update_failed", "The connection could not be updated.", 409],
    [/(?:VIZARD_ENCRYPTION_KEY_REQUIRED|VIZARD_CONNECTION_(?:RESULT_MISSING|UNAVAILABLE)|PGRST\d+|schema cache|Could not find the function|function .* does not exist)/iu,
      "connection_service_unavailable", "The Vizard connection service is temporarily unavailable.", 503]
  ];
  for (const [pattern, code, message, status] of mappings) {
    if (pattern.test(detail)) return new VizardConnectionServiceError(code, message, status);
  }
  return new VizardConnectionServiceError(
    operation === "status" ? "connection_service_unavailable" : "connection_update_failed",
    operation === "status"
      ? "The Vizard connection service is temporarily unavailable."
      : "The connection could not be updated.",
    503
  );
}

export function createVizardConnectionService({
  request,
  environment = process.env,
  randomBytes = crypto.randomBytes
} = {}) {
  if (typeof request !== "function") throw new TypeError("A Supabase request function is required.");

  const encryptionReadiness = () => vizardEncryptionReadiness(environment);

  async function status({ workspaceId } = {}) {
    try {
      const normalizedWorkspaceId = requiredUuid(workspaceId, "workspace ID");
      const rows = await request(
        `/connected_accounts?workspace_id=eq.${encodeURIComponent(normalizedWorkspaceId)}&provider=eq.vizard&platform=eq.vizard&select=${safeAccountSelect}&limit=1`
      );
      const row = Array.isArray(rows) ? rows[0] || null : null;
      return publicVizardConnection(row, encryptionReadiness());
    } catch (error) {
      throw normalizeVizardConnectionError(error, { operation: "status" });
    }
  }

  async function manage({ action, userId, workspaceId, apiKey = "" } = {}) {
    try {
      const normalizedAction = String(action || "").trim().toLowerCase();
      if (!allowedActions.has(normalizedAction)) {
        throw new VizardConnectionServiceError(
          "VIZARD_CONNECTION_ACTION_INVALID",
          "Choose connect, replace, or disconnect.",
          400
        );
      }
      const normalizedUserId = requiredUuid(userId, "user ID");
      const normalizedWorkspaceId = requiredUuid(workspaceId, "workspace ID");
      let encryptedToken = null;
      if (normalizedAction !== "disconnect") {
        encryptedToken = encryptVizardApiKey(apiKey, {
          keyMaterial: environment?.OAUTH_TOKEN_ENCRYPTION_KEY || "",
          randomBytes
        });
      }
      const payload = await request("/rpc/social_cues_manage_vizard_connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          p_actor_user_id: normalizedUserId,
          p_workspace_id: normalizedWorkspaceId,
          p_action: normalizedAction,
          p_encrypted_token: encryptedToken
        })
      });
      const row = Array.isArray(payload) ? payload[0] || null : payload;
      if (!row) {
        throw new VizardConnectionServiceError(
          "VIZARD_CONNECTION_RESULT_MISSING",
          "Vizard connection storage returned no result.",
          503
        );
      }
      return publicVizardConnection(row, encryptionReadiness());
    } catch (error) {
      throw normalizeVizardConnectionError(error, { operation: "update" });
    }
  }

  return Object.freeze({ status, manage });
}
