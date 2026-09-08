import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { WorkspaceContentPersistenceError } from "./workspace-content-persistence.mjs";

const CONTRACT_VERSION = "social-cues.hosted-workspace-repository.v2";
const CONTEXT_VERSION = "social-cues.workspace-actor.v2";
const PUBLIC_SCHEMA_VERSION = "social-cues.workspace-public.v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,127})$/;
const HASH = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;

const PUBLIC_PROJECTION_KEYS = Object.freeze([
  "activity",
  "analytics",
  "campaigns",
  "drafts",
  "media",
  "preferences",
  "profile",
  "providerStates",
  "schemaVersion"
]);
const ARRAY_SECTIONS = new Set(["activity", "campaigns", "drafts", "media", "providerStates"]);
const RECORD_SECTIONS = new Set(["analytics", "preferences", "profile"]);
const RECOVERY_SECTIONS = new Set(["activity", "campaigns", "drafts", "media"]);
const ITEM_COLLECTIONS = new Set(["activity", "campaigns", "drafts", "media"]);
const USER_ROLES = new Set(["owner", "admin", "member", "viewer"]);
const USER_WRITE_ROLES = new Set(["owner", "admin"]);
const CLIENT_KINDS = Object.freeze({
  "model-save": "workspace.client-save",
  "content-recovery": "workspace.content-recovery"
});
const SERVICE_INTENTS = new Set([
  "workspace.content-result",
  "workspace.provider-state-result",
  "workspace.worker-result",
  "workspace.system-repair"
]);
const ALL_INTENTS = Object.freeze([
  "workspace.initialize",
  "workspace.client-save",
  "workspace.content-recovery",
  "workspace.content-result",
  "workspace.provider-state-result",
  "workspace.worker-result",
  "workspace.system-repair"
]);
const USER_CONTEXT_KEYS = Object.freeze([
  "activeWorkspaceId",
  "actorUserId",
  "contextVersion",
  "entitlementStatus",
  "membershipStatus",
  "mode",
  "ownerUserId",
  "role",
  "sessionStatus",
  "sessionUserId",
  "source"
]);
const SERVICE_CONTEXT_KEYS = Object.freeze([
  "actorUserId",
  "allowedIntent",
  "contextVersion",
  "jobId",
  "leaseId",
  "leaseStatus",
  "mode",
  "ownerUserId",
  "source",
  "workspaceId"
]);
const STORED_ROW_KEYS = Object.freeze([
  "content_hash",
  "created_at",
  "model",
  "owner_user_id",
  "persistence_epoch",
  "revision",
  "updated_at",
  "workspace_id"
]);
const RECEIPT_KEYS = Object.freeze([
  "actor_user_id",
  "committed_at",
  "content_hash",
  "expected_revision",
  "kind",
  "operation_id",
  "persistence_epoch",
  "request_hash",
  "result_revision",
  "workspace_id"
]);
const ERROR_STATUS = Object.freeze({
  workspace_input_invalid: 400,
  authentication_required: 401,
  workspace_authorization_failed: 403,
  workspace_revision_conflict: 409,
  workspace_operation_id_reused: 409,
  workspace_revision_required: 428,
  workspace_storage_unavailable: 503,
  workspace_commit_unknown: 503,
  workspace_writer_unclassified: 400
});
const RPC = Object.freeze({
  read: "/rpc/social_cues_workspace_read_v2",
  initialize: "/rpc/social_cues_workspace_initialize_v2",
  commit: "/rpc/social_cues_workspace_commit_v2",
  reconcile: "/rpc/social_cues_workspace_receipt_v2"
});
const DURABILITY = Object.freeze({
  driver: "supabase-postgres",
  atomicCompareAndSwap: true
});
const FORBIDDEN_KEYS = new Set([
  "accesstoken",
  "actoruserid",
  "auth",
  "authentication",
  "authorization",
  "authusers",
  "billingcustomerid",
  "billingprivate",
  "billingsubscriptionid",
  "callbackbody",
  "currentuser",
  "commitreceipt",
  "commitreceipts",
  "contenthash",
  "cookie",
  "devicecredential",
  "devicecredentials",
  "deviceauth",
  "devicesecret",
  "devicesession",
  "devicesessions",
  "encryptedtoken",
  "jwttoken",
  "leasetoken",
  "oauthstate",
  "oauthstates",
  "operationid",
  "owneruserid",
  "password",
  "passwordhash",
  "paymentmethod",
  "persistenceepoch",
  "privatebilling",
  "privatereceipt",
  "providertoken",
  "providertokenciphertext",
  "rawcallbackbody",
  "rawwebhookbody",
  "receipt",
  "receipts",
  "refreshtoken",
  "servicecredential",
  "servicecredentials",
  "servicekey",
  "servicerolekey",
  "sessiontoken",
  "webhookbody",
  "webhookevent",
  "webhookevents",
  "webhooksecret",
  "webhooksignature",
  "workerlease",
  "workerleases",
  "workspaceid"
]);
const FORBIDDEN_FRAGMENTS = Object.freeze([
  "accesstoken",
  "authorization",
  "billing",
  "ciphertext",
  "credential",
  "deviceauth",
  "oauthstate",
  "password",
  "paymentmethod",
  "privatereceipt",
  "providertoken",
  "refreshtoken",
  "secret",
  "servicekey",
  "sessiontoken",
  "stripecustomer",
  "stripesubscription",
  "webhookbody",
  "webhookevent",
  "webhooksecret",
  "workerlease"
]);

function fail(code, commitStatus = "not_committed") {
  const status = ERROR_STATUS[code] || 400;
  throw new WorkspaceContentPersistenceError(code, status, commitStatus);
}

function record(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, expected) {
  return record(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function canonical(value, limits, state = { ancestors: new Set(), nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes || depth > limits.maxDepth) fail("workspace_input_invalid");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > limits.maxStringBytes) fail("workspace_input_invalid");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || state.ancestors.has(value)) fail("workspace_input_invalid");

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string")) fail("workspace_input_invalid");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayItems) fail("workspace_input_invalid");
      if (Object.keys(value).length !== value.length) fail("workspace_input_invalid");
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
          fail("workspace_input_invalid");
        }
      }
      if (ownKeys.some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
        fail("workspace_input_invalid");
      }
      return "[" + value.map(item => canonical(item, limits, state, depth + 1)).join(",") + "]";
    }
    if (!record(value) || ownKeys.length > limits.maxObjectKeys) fail("workspace_input_invalid");
    for (const key of ownKeys) {
      const descriptor = descriptors[key];
      if (!KEY.test(key) || !descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
        fail("workspace_input_invalid");
      }
    }
    return "{" + ownKeys.sort().map(key => JSON.stringify(key) + ":" + canonical(descriptors[key].value, limits, state, depth + 1)).join(",") + "}";
  } finally {
    state.ancestors.delete(value);
  }
}

function canonicalBytes(value, limits) {
  const text = canonical(value, limits);
  if (Buffer.byteLength(text) > limits.maxBytes) fail("workspace_input_invalid");
  return Buffer.from(text);
}

function canonicalCopy(value, limits) {
  return JSON.parse(canonicalBytes(value, limits).toString("utf8"));
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalHash(value, limits) {
  return hashBytes(canonicalBytes(value, limits));
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertPublicTree(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertPublicTree(item);
    return;
  }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (FORBIDDEN_KEYS.has(normalized) || FORBIDDEN_FRAGMENTS.some(fragment => normalized.includes(fragment))) {
      fail("workspace_input_invalid");
    }
    assertPublicTree(child);
  }
}

function assertRecordList(value) {
  if (!Array.isArray(value) || value.some(item => !record(item))) fail("workspace_input_invalid");
  const ids = new Set();
  for (const item of value) {
    if (Object.hasOwn(item, "id")) {
      if (typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id)) {
        fail("workspace_input_invalid");
      }
      ids.add(item.id);
    }
  }
}

function validateProjection(value, limits) {
  const projection = canonicalCopy(value, limits);
  if (!exactKeys(projection, PUBLIC_PROJECTION_KEYS)
    || projection.schemaVersion !== PUBLIC_SCHEMA_VERSION) {
    fail("workspace_input_invalid");
  }
  for (const section of ARRAY_SECTIONS) assertRecordList(projection[section]);
  for (const section of RECORD_SECTIONS) {
    if (!record(projection[section])) fail("workspace_input_invalid");
  }
  const providers = new Set();
  for (const item of projection.providerStates) {
    if (!PROVIDER.test(String(item.provider || "")) || providers.has(item.provider)) fail("workspace_input_invalid");
    providers.add(item.provider);
  }
  assertPublicTree(projection);
  return { model: projection, contentHash: canonicalHash(projection, limits) };
}

function validatePublicRecord(value, limits) {
  const copied = canonicalCopy(value, limits);
  if (!record(copied)) fail("workspace_input_invalid");
  assertPublicTree(copied);
  return copied;
}

function validateSectionPatch(value, allowed, limits) {
  const patch = canonicalCopy(value, limits);
  if (!record(patch) || Object.keys(patch).length === 0
    || Object.keys(patch).some(key => !allowed.has(key))) fail("workspace_input_invalid");
  for (const [key, section] of Object.entries(patch)) {
    if (ARRAY_SECTIONS.has(key)) assertRecordList(section);
    else if (RECORD_SECTIONS.has(key) && !record(section)) fail("workspace_input_invalid");
    else if (!ARRAY_SECTIONS.has(key) && !RECORD_SECTIONS.has(key)) fail("workspace_input_invalid");
  }
  assertPublicTree(patch);
  return patch;
}

function validTimestamp(value) {
  return typeof value === "string" && value.length <= 64 && RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

function validRevision(value) {
  return exactKeys(value, ["epoch", "revision"])
    && UUID.test(value.epoch)
    && typeof value.revision === "string"
    && DECIMAL.test(value.revision);
}

function revisionOf(row) {
  return { epoch: row.persistence_epoch, revision: row.revision };
}

function sameRevision(left, right) {
  return validRevision(left)
    && validRevision(right)
    && left.epoch === right.epoch
    && left.revision === right.revision;
}

function validateUserContext(value, limits, write = false) {
  let context;
  try {
    context = canonicalCopy(value, { ...limits, maxBytes: Math.min(limits.maxBytes, 8 * 1024) });
  } catch {
    fail("authentication_required");
  }
  if (!record(context)
    || context.contextVersion !== CONTEXT_VERSION
    || context.mode !== "user-jwt"
    || context.source !== "verified-session") {
    fail("authentication_required");
  }
  if (!exactKeys(context, USER_CONTEXT_KEYS)) fail("workspace_authorization_failed");
  if (![context.actorUserId, context.sessionUserId, context.activeWorkspaceId, context.ownerUserId].every(value => UUID.test(value))
    || context.actorUserId !== context.sessionUserId
    || !USER_ROLES.has(context.role)
    || context.sessionStatus !== "active"
    || context.membershipStatus !== "active"
    || context.entitlementStatus !== "active") {
    fail("workspace_authorization_failed");
  }
  if (write && !USER_WRITE_ROLES.has(context.role)) fail("workspace_authorization_failed");
  return context;
}

function validateServiceContext(value, limits) {
  let context;
  try {
    context = canonicalCopy(value, { ...limits, maxBytes: Math.min(limits.maxBytes, 8 * 1024) });
  } catch {
    fail("authentication_required");
  }
  if (!record(context)
    || context.contextVersion !== CONTEXT_VERSION
    || context.mode !== "service-job"
    || context.source !== "claimed-service-job") {
    fail("authentication_required");
  }
  if (!exactKeys(context, SERVICE_CONTEXT_KEYS)
    || ![context.actorUserId, context.workspaceId, context.ownerUserId, context.jobId, context.leaseId].every(value => UUID.test(value))
    || context.leaseStatus !== "active"
    || !SERVICE_INTENTS.has(context.allowedIntent)) {
    fail("workspace_authorization_failed");
  }
  return context;
}

function contextWorkspaceId(context) {
  return context.mode === "user-jwt" ? context.activeWorkspaceId : context.workspaceId;
}

function validateRawEnvelope(envelope, requestBytes, limits) {
  if (!Buffer.isBuffer(requestBytes) || requestBytes.length === 0 || requestBytes.length > limits.maxEnvelopeBytes) {
    fail("workspace_input_invalid");
  }
  let parsed;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes);
    parsed = JSON.parse(text);
  } catch {
    fail("workspace_input_invalid");
  }
  if (canonical(parsed, limits) !== canonical(envelope, limits)) fail("workspace_input_invalid");
  return hashBytes(requestBytes);
}

function validateClientEnvelope(value, requestBytes, limits) {
  if (!record(value)) fail("workspace_input_invalid");
  if (!Object.hasOwn(value, "expectedRevision") || value.expectedRevision === null) {
    fail("workspace_revision_required");
  }
  if (!exactKeys(value, ["expectedRevision", "kind", "operationId", "request"])) fail("workspace_input_invalid");
  if (!validRevision(value.expectedRevision)
    || !Object.hasOwn(CLIENT_KINDS, value.kind)
    || !UUID_V4.test(String(value.operationId || ""))
    || !record(value.request)) {
    fail("workspace_input_invalid");
  }
  const requestHash = validateRawEnvelope(value, requestBytes, limits);
  return { envelope: canonicalCopy(value, limits), requestHash };
}

function validateInitializeEnvelope(value, requestBytes, limits) {
  if (!exactKeys(value, ["operationId", "request"])
    || !UUID_V4.test(String(value.operationId || ""))
    || !exactKeys(value.request, ["model"])) fail("workspace_input_invalid");
  const requestHash = validateRawEnvelope(value, requestBytes, limits);
  const projected = validateProjection(value.request.model, limits);
  return { envelope: canonicalCopy(value, limits), requestHash, projected };
}

function validateServiceEnvelope(value, requestBytes, context, limits) {
  if (!record(value)) fail("workspace_input_invalid");
  if (!Object.hasOwn(value, "expectedRevision") || value.expectedRevision === null) {
    fail("workspace_revision_required");
  }
  if (!exactKeys(value, ["expectedRevision", "intent", "operationId", "request"])) fail("workspace_input_invalid");
  if (!validRevision(value.expectedRevision)
    || !UUID_V4.test(String(value.operationId || ""))
    || !SERVICE_INTENTS.has(value.intent)
    || value.intent !== context.allowedIntent
    || !record(value.request)) {
    if (typeof value.intent === "string" && !SERVICE_INTENTS.has(value.intent)) fail("workspace_writer_unclassified");
    fail("workspace_authorization_failed");
  }
  const requestHash = validateRawEnvelope(value, requestBytes, limits);
  return { envelope: canonicalCopy(value, limits), requestHash };
}

function validateBase(value, expectedRevision, limits) {
  if (!exactKeys(value, ["model", "revision", "state"]) || value.state !== "present" || !validRevision(value.revision)) {
    fail("workspace_input_invalid");
  }
  if (!sameRevision(value.revision, expectedRevision)) fail("workspace_revision_conflict");
  return validateProjection(value.model, limits).model;
}

function upsert(list, item) {
  if (typeof item.id !== "string" || !item.id || item.id.length > 128) fail("workspace_input_invalid");
  const next = list.map(value => ({ ...value }));
  const index = next.findIndex(value => value.id === item.id);
  if (index === -1) next.push(item);
  else next[index] = item;
  return next;
}

function applyClientIntent(current, envelope, limits) {
  if (envelope.kind === "model-save") {
    if (!exactKeys(envelope.request, ["model"])) fail("workspace_input_invalid");
    return validateProjection(envelope.request.model, limits);
  }
  if (!exactKeys(envelope.request, ["sections"])) fail("workspace_input_invalid");
  const sections = validateSectionPatch(envelope.request.sections, RECOVERY_SECTIONS, limits);
  return validateProjection({ ...current, ...sections }, limits);
}

function applyServiceIntent(current, envelope, context, limits) {
  let next;
  if (envelope.intent === "workspace.content-result") {
    if (!exactKeys(envelope.request, ["collection", "item"]) || !ITEM_COLLECTIONS.has(envelope.request.collection)) {
      fail("workspace_input_invalid");
    }
    const item = validatePublicRecord(envelope.request.item, limits);
    next = { ...current, [envelope.request.collection]: upsert(current[envelope.request.collection], item) };
  } else if (envelope.intent === "workspace.provider-state-result") {
    if (!exactKeys(envelope.request, ["provider", "state"])
      || !PROVIDER.test(String(envelope.request.provider || ""))) fail("workspace_input_invalid");
    const state = validatePublicRecord(envelope.request.state, limits);
    if (Object.hasOwn(state, "provider") && state.provider !== envelope.request.provider) fail("workspace_input_invalid");
    next = {
      ...current,
      providerStates: upsert(
        current.providerStates.map(item => ({ ...item, id: item.provider })),
        { ...state, id: envelope.request.provider, provider: envelope.request.provider }
      ).map(({ id, ...item }) => item)
    };
  } else if (envelope.intent === "workspace.worker-result") {
    if (!exactKeys(envelope.request, ["jobId", "result", "target"])
      || envelope.request.jobId !== context.jobId
      || !exactKeys(envelope.request.target, ["collection", "id"])
      || !ITEM_COLLECTIONS.has(envelope.request.target.collection)
      || typeof envelope.request.target.id !== "string"
      || !envelope.request.target.id) fail("workspace_input_invalid");
    const result = validatePublicRecord(envelope.request.result, limits);
    if (Object.hasOwn(result, "id") && result.id !== envelope.request.target.id) fail("workspace_input_invalid");
    next = {
      ...current,
      [envelope.request.target.collection]: upsert(
        current[envelope.request.target.collection],
        { ...result, id: envelope.request.target.id }
      )
    };
  } else if (envelope.intent === "workspace.system-repair") {
    if (!exactKeys(envelope.request, ["patch", "repairId"])
      || !UUID_V4.test(String(envelope.request.repairId || ""))) fail("workspace_input_invalid");
    const patch = validateSectionPatch(
      envelope.request.patch,
      new Set([...ARRAY_SECTIONS, ...RECORD_SECTIONS].filter(key => key !== "providerStates")),
      limits
    );
    next = { ...current, ...patch };
  } else {
    fail("workspace_writer_unclassified");
  }
  return validateProjection(next, limits);
}

function normalizeRow(value, context, limits) {
  if (!exactKeys(value, STORED_ROW_KEYS)
    || !UUID.test(value.persistence_epoch)
    || typeof value.revision !== "string"
    || !DECIMAL.test(value.revision)
    || !HASH.test(String(value.content_hash || ""))
    || !validTimestamp(value.created_at)
    || !validTimestamp(value.updated_at)) {
    fail("workspace_storage_unavailable");
  }
  if (value.workspace_id !== contextWorkspaceId(context)
    || value.owner_user_id !== context.ownerUserId) fail("workspace_authorization_failed");
  const projected = validateProjection(value.model, limits);
  if (projected.contentHash !== value.content_hash) fail("workspace_storage_unavailable");
  return { ...canonicalCopy(value, limits), model: projected.model };
}

function normalizeReadResponse(value, context, limits) {
  if (!record(value) || !Array.isArray(value.rows)) fail("workspace_storage_unavailable");
  if (value.outcome === "absent") {
    if (!exactKeys(value, ["outcome", "rows"]) || value.rows.length !== 0) fail("workspace_storage_unavailable");
    return { state: "absent" };
  }
  if (value.outcome !== "present"
    || !exactKeys(value, ["outcome", "rows"])
    || value.rows.length !== 1) fail("workspace_storage_unavailable");
  const row = normalizeRow(value.rows[0], context, limits);
  return { state: "present", model: row.model, revision: revisionOf(row) };
}

function normalizeReceipt(value, row, context, evidence) {
  if (!exactKeys(value, RECEIPT_KEYS)
    || value.workspace_id !== row.workspace_id
    || value.persistence_epoch !== row.persistence_epoch
    || value.operation_id !== evidence.operationId
    || value.actor_user_id !== context.actorUserId
    || value.kind !== evidence.intent
    || value.expected_revision !== evidence.expectedRevision
    || value.request_hash !== evidence.requestHash
    || !DECIMAL.test(String(value.result_revision || ""))
    || !HASH.test(String(value.content_hash || ""))
    || !validTimestamp(value.committed_at)
    || BigInt(value.result_revision) > BigInt(row.revision)) {
    fail("workspace_commit_unknown", "unknown");
  }
  if (value.result_revision === row.revision && value.content_hash !== row.content_hash) {
    fail("workspace_commit_unknown", "unknown");
  }
  return canonicalCopy(value, {
    maxBytes: 16 * 1024,
    maxDepth: 8,
    maxNodes: 128,
    maxStringBytes: 4096,
    maxArrayItems: 32,
    maxObjectKeys: 32
  });
}

function publicCommit(receipt, row, replayed) {
  const committedRevision = { epoch: receipt.persistence_epoch, revision: receipt.result_revision };
  const currentRevision = revisionOf(row);
  return {
    operationId: receipt.operation_id,
    committedRevision,
    currentRevision,
    replayed,
    superseded: !sameRevision(committedRevision, currentRevision),
    commitStatus: "committed",
    durability: { ...DURABILITY }
  };
}

function trustedError(error) {
  return error instanceof WorkspaceContentPersistenceError && Object.hasOwn(ERROR_STATUS, error.code);
}

function sanitizeError(error) {
  if (!trustedError(error)) return null;
  return new WorkspaceContentPersistenceError(
    error.code,
    ERROR_STATUS[error.code],
    error.code === "workspace_commit_unknown" ? "unknown" : "not_committed"
  );
}

export function createHostedWorkspacePersistence({
  userJwtRequest,
  serviceJobRequest,
  maxBytes = 256 * 1024,
  maxEnvelopeBytes = 320 * 1024,
  maxDepth = 20,
  maxNodes = 10_000,
  maxStringBytes = 64 * 1024,
  maxArrayItems = 2_000,
  maxObjectKeys = 256
} = {}) {
  if (typeof userJwtRequest !== "function"
    || typeof serviceJobRequest !== "function"
    || ![maxBytes, maxEnvelopeBytes, maxDepth, maxNodes, maxStringBytes, maxArrayItems, maxObjectKeys]
      .every(value => Number.isSafeInteger(value) && value > 0)) {
    fail("workspace_input_invalid");
  }
  const limits = Object.freeze({
    maxBytes,
    maxEnvelopeBytes,
    maxDepth,
    maxNodes,
    maxStringBytes,
    maxArrayItems,
    maxObjectKeys
  });

  async function requestThrough(request, pathname, context, body) {
    return request(pathname, {
      method: "POST",
      context: canonicalCopy(context, limits),
      body: canonicalCopy(body, limits)
    });
  }

  async function readWith(request, context) {
    let response;
    try {
      response = await requestThrough(request, RPC.read, context, {
        workspace_id: contextWorkspaceId(context)
      });
    } catch (error) {
      const sanitized = sanitizeError(error);
      if (sanitized) throw sanitized;
      fail("workspace_storage_unavailable");
    }
    return normalizeReadResponse(response, context, limits);
  }

  function normalizeCommitResponse(value, context, evidence, replayed = null) {
    if (!record(value)
      || !exactKeys(value, ["outcome", "receipts", "rows"])
      || !Array.isArray(value.rows)
      || !Array.isArray(value.receipts)
      || value.rows.length !== 1
      || value.receipts.length !== 1
      || !new Set(["committed", "replayed"]).has(value.outcome)) {
      fail("workspace_commit_unknown", "unknown");
    }
    const row = normalizeRow(value.rows[0], context, limits);
    const receipt = normalizeReceipt(value.receipts[0], row, context, evidence);
    const isReplay = replayed === null ? value.outcome === "replayed" : replayed;
    if (!isReplay && receipt.result_revision !== row.revision) fail("workspace_commit_unknown", "unknown");
    return publicCommit(receipt, row, isReplay);
  }

  async function reconcile(request, context, evidence, { initialize = false } = {}) {
    let response;
    try {
      response = await requestThrough(request, RPC.reconcile, context, {
        actor_user_id: context.actorUserId,
        expected_epoch: evidence.expectedEpoch,
        expected_revision: evidence.expectedRevision,
        kind: evidence.intent,
        operation_id: evidence.operationId,
        request_hash: evidence.requestHash,
        workspace_id: contextWorkspaceId(context)
      });
    } catch (error) {
      const sanitized = sanitizeError(error);
      if (sanitized && !new Set(["workspace_storage_unavailable", "workspace_commit_unknown"]).has(sanitized.code)) {
        throw sanitized;
      }
      fail("workspace_commit_unknown", "unknown");
    }

    if (record(response) && response.outcome === "replayed") {
      return normalizeCommitResponse(response, context, evidence, true);
    }
    if (initialize && record(response) && response.outcome === "existing") {
      if (!exactKeys(response, ["outcome", "receipts", "rows"])
        || !Array.isArray(response.receipts)
        || response.receipts.length !== 0
        || !Array.isArray(response.rows)
        || response.rows.length !== 1) fail("workspace_commit_unknown", "unknown");
      const row = normalizeRow(response.rows[0], context, limits);
      return { initialized: false, state: "present", model: row.model, revision: revisionOf(row) };
    }
    if (record(response) && response.outcome === "not_found") {
      if (!exactKeys(response, ["outcome", "receipts", "rows"])
        || !Array.isArray(response.receipts)
        || response.receipts.length !== 0
        || !Array.isArray(response.rows)
        || response.rows.length !== 1) fail("workspace_commit_unknown", "unknown");
      const row = normalizeRow(response.rows[0], context, limits);
      if (initialize) return { initialized: false, state: "present", model: row.model, revision: revisionOf(row) };
      if (evidence.expectedEpoch
        && evidence.expectedRevision
        && sameRevision(revisionOf(row), { epoch: evidence.expectedEpoch, revision: evidence.expectedRevision })) {
        fail("workspace_storage_unavailable");
      }
      fail("workspace_commit_unknown", "unknown");
    }
    if (initialize && record(response) && response.outcome === "absent"
      && exactKeys(response, ["outcome", "receipts", "rows"])
      && Array.isArray(response.receipts) && response.receipts.length === 0
      && Array.isArray(response.rows) && response.rows.length === 0) {
      fail("workspace_storage_unavailable");
    }
    fail("workspace_commit_unknown", "unknown");
  }

  async function performCommit(request, context, command, evidence, options = {}) {
    let response;
    try {
      response = await requestThrough(request, options.initialize ? RPC.initialize : RPC.commit, context, command);
    } catch (error) {
      const sanitized = sanitizeError(error);
      if (sanitized && sanitized.code !== "workspace_commit_unknown") throw sanitized;
      return reconcile(request, context, evidence, options);
    }
    if (options.initialize && record(response) && response.outcome === "existing") {
      return reconcile(request, context, evidence, options);
    }
    try {
      return normalizeCommitResponse(response, context, evidence);
    } catch (error) {
      if (!trustedError(error) || error.code !== "workspace_commit_unknown") throw error;
      return reconcile(request, context, evidence, options);
    }
  }

  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    contextVersion: CONTEXT_VERSION,
    publicSchemaVersion: PUBLIC_SCHEMA_VERSION,
    intents: [...ALL_INTENTS],

    async readUser(actorContext) {
      const context = validateUserContext(actorContext, limits);
      return readWith(userJwtRequest, context);
    },

    async readService(serviceContext) {
      const context = validateServiceContext(serviceContext, limits);
      return readWith(serviceJobRequest, context);
    },

    async initializeUser(actorContext, input, requestBytes) {
      const context = validateUserContext(actorContext, limits, true);
      const validated = validateInitializeEnvelope(input, requestBytes, limits);
      const evidence = {
        operationId: validated.envelope.operationId,
        intent: "workspace.initialize",
        expectedEpoch: null,
        expectedRevision: null,
        requestHash: validated.requestHash
      };
      return performCommit(userJwtRequest, context, {
        actor_user_id: context.actorUserId,
        content_hash: validated.projected.contentHash,
        kind: evidence.intent,
        model: validated.projected.model,
        operation_id: evidence.operationId,
        request_hash: evidence.requestHash,
        workspace_id: context.activeWorkspaceId
      }, evidence, { initialize: true });
    },

    async commitClient(actorContext, base, input, requestBytes) {
      const context = validateUserContext(actorContext, limits, true);
      const validated = validateClientEnvelope(input, requestBytes, limits);
      const current = validateBase(base, validated.envelope.expectedRevision, limits);
      const projected = applyClientIntent(current, validated.envelope, limits);
      const evidence = {
        operationId: validated.envelope.operationId,
        intent: CLIENT_KINDS[validated.envelope.kind],
        expectedEpoch: validated.envelope.expectedRevision.epoch,
        expectedRevision: validated.envelope.expectedRevision.revision,
        requestHash: validated.requestHash
      };
      return performCommit(userJwtRequest, context, {
        actor_user_id: context.actorUserId,
        content_hash: projected.contentHash,
        expected_epoch: validated.envelope.expectedRevision.epoch,
        expected_revision: validated.envelope.expectedRevision.revision,
        kind: evidence.intent,
        model: projected.model,
        operation_id: evidence.operationId,
        request_hash: evidence.requestHash,
        workspace_id: context.activeWorkspaceId
      }, evidence);
    },

    async commitService(serviceContext, base, input, requestBytes) {
      const context = validateServiceContext(serviceContext, limits);
      const validated = validateServiceEnvelope(input, requestBytes, context, limits);
      const current = validateBase(base, validated.envelope.expectedRevision, limits);
      const projected = applyServiceIntent(current, validated.envelope, context, limits);
      const evidence = {
        operationId: validated.envelope.operationId,
        intent: validated.envelope.intent,
        expectedEpoch: validated.envelope.expectedRevision.epoch,
        expectedRevision: validated.envelope.expectedRevision.revision,
        requestHash: validated.requestHash
      };
      return performCommit(serviceJobRequest, context, {
        actor_user_id: context.actorUserId,
        content_hash: projected.contentHash,
        expected_epoch: validated.envelope.expectedRevision.epoch,
        expected_revision: validated.envelope.expectedRevision.revision,
        job_id: context.jobId,
        kind: evidence.intent,
        lease_id: context.leaseId,
        model: projected.model,
        operation_id: evidence.operationId,
        request_hash: evidence.requestHash,
        workspace_id: context.workspaceId
      }, evidence);
    }
  });
}
