import { createHash, randomUUID } from "node:crypto";
import { WorkspaceContentPersistenceError } from "./workspace-content-persistence.mjs";

const REVISION_EPOCH = "social-cues.workspace-model.updated-at.v1";
const PRIVATE_RECEIPT_KEY = "_hostedPersistenceReceipt";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

const clone = value => JSON.parse(JSON.stringify(value));
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function fail(code, status = 400, commitStatus = "not_committed", phase = "") {
  throw new WorkspaceContentPersistenceError(code, status, commitStatus, phase);
}

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) fail("workspace_input_invalid");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return "[" + value.map(item => canonical(item, ancestors)).join(",") + "]";
    if (!record(value)) fail("workspace_input_invalid");
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key], ancestors)).join(",") + "}";
  } finally {
    ancestors.delete(value);
  }
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || value.length > 64) return "";
  const match = RFC3339.exec(value);
  if (!match) return "";
  const wholeSecond = Date.parse(`${match[1]}.000${match[3]}`);
  if (!Number.isFinite(wholeSecond)) return "";
  const fraction = String(match[2] || "").replace(/0+$/, "");
  return `${new Date(wholeSecond).toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ""}Z`;
}

function identityFor(user = {}) {
  const workspaceId = String(user.workspaceId || user.supabaseUserId || user.id || "");
  const ownerUserId = String(user.supabaseUserId || user.id || "");
  if (!UUID.test(workspaceId) || !UUID.test(ownerUserId)) fail("workspace_authorization_failed", 403);
  return { workspaceId, ownerUserId };
}

function revisionFor(identity, updatedAt) {
  const timestamp = canonicalTimestamp(updatedAt);
  if (!timestamp) return null;
  return {
    epoch: REVISION_EPOCH,
    revision: digestBytes(JSON.stringify([identity.workspaceId, identity.ownerUserId, timestamp]))
  };
}

function validRevision(value) {
  return record(value)
    && Object.keys(value).sort().join(",") === "epoch,revision"
    && value.epoch === REVISION_EPOCH
    && typeof value.revision === "string"
    && HASH.test(value.revision);
}

function sameRevision(left, right) {
  return validRevision(left) && validRevision(right)
    && left.epoch === right.epoch && left.revision === right.revision;
}

function clockMilliseconds(clock) {
  let nowMs;
  try {
    const value = clock();
    nowMs = value instanceof Date ? value.getTime() : Number(value);
  } catch {
    nowMs = NaN;
  }
  if (!Number.isFinite(nowMs)) fail("workspace_storage_unavailable", 503);
  const date = new Date(Math.trunc(nowMs));
  if (!Number.isFinite(date.getTime())) fail("workspace_storage_unavailable", 503);
  return date.getTime();
}

function nextTimestamp(previous, clock) {
  const previousMs = Date.parse(previous);
  if (!Number.isFinite(previousMs)) fail("workspace_storage_unavailable", 503);
  const nextMs = Math.max(clockMilliseconds(clock), previousMs + 1);
  const next = new Date(nextMs);
  if (!Number.isFinite(next.getTime())) fail("workspace_storage_unavailable", 503);
  return next.toISOString();
}

function stripPrivateReceipt(model) {
  if (record(model?.workspaceModel)) delete model.workspaceModel[PRIVATE_RECEIPT_KEY];
  return model;
}

function receiptFromModel(model) {
  if (!record(model?.workspaceModel)) return null;
  const value = model.workspaceModel[PRIVATE_RECEIPT_KEY];
  delete model.workspaceModel[PRIVATE_RECEIPT_KEY];
  if (!record(value)
    || Object.keys(value).sort().join(",") !== "expectedRevision,operationId,requestDigest,resultRevision,status"
    || !UUID_V4.test(String(value.operationId || ""))
    || !HASH.test(String(value.requestDigest || ""))
    || !HASH.test(String(value.expectedRevision || ""))
    || !HASH.test(String(value.resultRevision || ""))
    || value.status !== "committed") return null;
  return clone(value);
}

function publicRow(row) {
  const result = clone(row);
  stripPrivateReceipt(result?.model);
  return result;
}

function validateRow(row, identity, { revisionRequired = false } = {}) {
  if (!record(row) || String(row.workspace_id || "") !== identity.workspaceId
    || String(row.owner_user_id || "") !== identity.ownerUserId || !record(row.model)) {
    fail("workspace_authorization_failed", 403);
  }
  const revision = revisionFor(identity, row.updated_at);
  if (revisionRequired && !revision) fail("workspace_revision_invalid", 409);
  return revision;
}

function validateEnvelope(envelope) {
  if (!record(envelope)) fail("workspace_input_invalid");
  if (!Object.hasOwn(envelope, "expectedRevision")) fail("workspace_revision_required", 428);
  if (Object.keys(envelope).sort().join(",") !== "expectedRevision,kind,operationId,request") fail("workspace_input_invalid");
  if (!new Set(["model-save", "content-recovery"]).has(envelope.kind)
    || !UUID_V4.test(String(envelope.operationId || "")) || !record(envelope.request)) fail("workspace_input_invalid");
  if (envelope.expectedRevision === null) fail("workspace_revision_required", 428);
  if (!validRevision(envelope.expectedRevision)) fail("workspace_revision_invalid");
  canonical(envelope.request);
  return envelope;
}

function publicReceipt(operationId, committedRevision, currentRevision, replayed = false) {
  return {
    operationId,
    committedRevision: clone(committedRevision),
    currentRevision: clone(currentRevision),
    replayed,
    superseded: !sameRevision(committedRevision, currentRevision),
    durability: { driver: "supabase-postgrest", atomicCompareAndSwap: true }
  };
}

export function createHostedWorkspacePersistence({ request, snapshot, mergeClient, recoverClient, clock = Date.now } = {}) {
  if ([request, snapshot, mergeClient, recoverClient, clock].some(value => typeof value !== "function")) {
    fail("workspace_store_options_invalid");
  }
  const states = new WeakMap();

  function stateFor(model, user, { requireRevision = false, allowAbsent = false } = {}) {
    const identity = identityFor(user);
    const state = model && typeof model === "object" ? states.get(model) : null;
    if (!state || state.identity.workspaceId !== identity.workspaceId || state.identity.ownerUserId !== identity.ownerUserId) {
      fail("workspace_writer_unclassified", 403);
    }
    if (!state.present && !allowAbsent) fail("workspace_revision_required", 428);
    if (requireRevision && !state.revision) fail("workspace_revision_invalid", 409);
    return { identity, state };
  }

  function attach(model, row, user) {
    const identity = identityFor(user);
    const copiedRowModel = clone(row?.model || {});
    const receipt = receiptFromModel(copiedRowModel);
    stripPrivateReceipt(model);
    const revision = validateRow({ ...row, model: copiedRowModel }, identity);
    states.set(model, {
      identity,
      present: true,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
      revision,
      receipt
    });
    return model;
  }

  function markAbsent(model, user) {
    const identity = identityFor(user);
    stripPrivateReceipt(model);
    states.set(model, { identity, present: false, updatedAt: "", revision: null, receipt: null });
    return model;
  }

  async function readRow(user) {
    const identity = identityFor(user);
    let rows;
    try {
      rows = await request(
        `/workspace_models?workspace_id=eq.${encodeURIComponent(identity.workspaceId)}&owner_user_id=eq.${encodeURIComponent(identity.ownerUserId)}&select=workspace_id,owner_user_id,model,updated_at&limit=1`
      );
    } catch (error) {
      if (error instanceof WorkspaceContentPersistenceError) throw error;
      fail("workspace_storage_unavailable", 503);
    }
    if (!Array.isArray(rows) || rows.length > 1) fail("workspace_storage_unavailable", 503);
    if (!rows.length) return null;
    validateRow(rows[0], identity);
    return clone(rows[0]);
  }

  async function bootstrap(model, user) {
    const { identity, state } = stateFor(model, user, { allowAbsent: true });
    if (state.present) fail("workspace_already_initialized", 409);
    const storedModel = stripPrivateReceipt(clone(snapshot(model, user)));
    if (!record(storedModel)) fail("workspace_content_invalid");
    const updatedAt = new Date(clockMilliseconds(clock)).toISOString();
    try {
      await request("/workspace_models?on_conflict=workspace_id", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify([{
          workspace_id: identity.workspaceId,
          owner_user_id: identity.ownerUserId,
          model: storedModel,
          updated_at: updatedAt
        }])
      });
    } catch {
      fail("workspace_storage_unavailable", 503);
    }
    const row = await readRow(user);
    if (!row) fail("workspace_authorization_failed", 403);
    return row;
  }

  function replayDecision(state, operationId, requestDigest, expectedRevision) {
    const receipt = state.receipt;
    if (!receipt || receipt.operationId !== operationId) return null;
    if (receipt.requestDigest !== requestDigest || receipt.expectedRevision !== expectedRevision.revision) {
      fail("workspace_operation_id_reused", 409);
    }
    if (!state.revision || receipt.resultRevision !== state.revision.revision) fail("workspace_storage_unavailable", 503);
    return publicReceipt(operationId, state.revision, state.revision, true);
  }

  async function reconcile(operation, user) {
    const row = await readRow(user);
    if (!row) fail("workspace_revision_conflict", 409);
    const identity = identityFor(user);
    const rowModel = clone(row.model);
    const receipt = receiptFromModel(rowModel);
    const revision = validateRow({ ...row, model: rowModel }, identity, { revisionRequired: true });
    if (receipt?.operationId === operation.operationId) {
      if (receipt.requestDigest !== operation.requestDigest || receipt.expectedRevision !== operation.expectedRevision.revision) {
        fail("workspace_operation_id_reused", 409);
      }
      if (receipt.resultRevision !== revision.revision) fail("workspace_storage_unavailable", 503);
      return { row: publicRow(row), receipt: publicReceipt(operation.operationId, revision, revision, true) };
    }
    fail("workspace_revision_conflict", 409);
  }

  async function commit({ model, user, operationId, expectedRevision, requestDigest, apply }) {
    const { identity, state } = stateFor(model, user, { requireRevision: true });
    const replay = replayDecision(state, operationId, requestDigest, expectedRevision);
    if (replay) return { model, receipt: replay };
    if (!sameRevision(expectedRevision, state.revision)) fail("workspace_revision_conflict", 409);

    const updatedModel = await apply();
    if (!record(updatedModel)) fail("workspace_content_invalid");
    const updatedAt = nextTimestamp(state.updatedAt, clock);
    const resultRevision = revisionFor(identity, updatedAt);
    const privateReceipt = {
      operationId,
      requestDigest,
      expectedRevision: expectedRevision.revision,
      resultRevision: resultRevision.revision,
      status: "committed"
    };
    const storedModel = stripPrivateReceipt(clone(snapshot(updatedModel, user)));
    if (!record(storedModel)) fail("workspace_content_invalid");
    storedModel.workspaceModel = record(storedModel.workspaceModel) ? storedModel.workspaceModel : {};
    storedModel.workspaceModel[PRIVATE_RECEIPT_KEY] = privateReceipt;
    const pathname = `/workspace_models?workspace_id=eq.${encodeURIComponent(identity.workspaceId)}`
      + `&owner_user_id=eq.${encodeURIComponent(identity.ownerUserId)}`
      + `&updated_at=eq.${encodeURIComponent(state.updatedAt)}`
      + "&select=workspace_id,owner_user_id,model,updated_at";

    let rows;
    try {
      rows = await request(pathname, {
        method: "PATCH",
        headers: { Prefer: "return=representation,handling=strict,max-affected=1" },
        body: JSON.stringify({ model: storedModel, updated_at: updatedAt })
      });
    } catch {
      try {
        return await reconcile({ operationId, requestDigest, expectedRevision }, user);
      } catch (error) {
        if (error?.code === "workspace_operation_id_reused") throw error;
        fail("workspace_commit_unknown", 503, "unknown", "workspace-cas");
      }
    }
    if (Array.isArray(rows) && rows.length === 0) {
      return reconcile({ operationId, requestDigest, expectedRevision }, user);
    }
    if (!Array.isArray(rows) || rows.length !== 1) fail("workspace_commit_unknown", 503, "unknown", "workspace-cas");
    const returnedRevision = validateRow(rows[0], identity, { revisionRequired: true });
    const returnedModel = clone(rows[0].model);
    const returnedReceipt = receiptFromModel(returnedModel);
    if (!sameRevision(returnedRevision, resultRevision)
      || returnedReceipt?.operationId !== operationId
      || returnedReceipt?.requestDigest !== requestDigest
      || returnedReceipt?.expectedRevision !== expectedRevision.revision
      || returnedReceipt?.resultRevision !== returnedRevision.revision) {
      fail("workspace_commit_unknown", 503, "unknown", "workspace-cas-verification");
    }
    attach(updatedModel, rows[0], user);
    return {
      model: updatedModel,
      row: publicRow(rows[0]),
      receipt: publicReceipt(operationId, returnedRevision, returnedRevision, false)
    };
  }

  return Object.freeze({
    revisionEpoch: REVISION_EPOCH,
    privateReceiptKey: PRIVATE_RECEIPT_KEY,
    attach,
    markAbsent,
    readRow,
    bootstrap,
    stripPrivate: stripPrivateReceipt,
    inherit(target, source) {
      const state = states.get(source);
      if (!state) fail("workspace_writer_unclassified", 403);
      stripPrivateReceipt(target);
      states.set(target, clone(state));
      return target;
    },
    hasLoadedRow(model, user) {
      try { return stateFor(model, user).state.present; } catch { return false; }
    },
    isKnownAbsent(model, user) {
      try { return !stateFor(model, user, { allowAbsent: true }).state.present; } catch { return false; }
    },
    capability(model, user) {
      try {
        const { state } = stateFor(model, user);
        return state.present && state.revision
          ? { conditionalSave: true, revision: clone(state.revision) }
          : { conditionalSave: false };
      } catch {
        return { conditionalSave: false };
      }
    },
    async clientSave(user, model, envelope, requestBytes) {
      const validated = validateEnvelope(envelope);
      if (!Buffer.isBuffer(requestBytes) || requestBytes.length === 0) fail("workspace_input_invalid");
      const requestDigest = digestBytes(requestBytes);
      return commit({
        model,
        user,
        operationId: validated.operationId,
        expectedRevision: validated.expectedRevision,
        requestDigest,
        apply: () => validated.kind === "content-recovery"
          ? recoverClient(validated.request, model, user)
          : mergeClient(validated.request, model, user)
      });
    },
    async serverSave(model, user) {
      const { state } = stateFor(model, user, { requireRevision: true });
      const requestDigest = digestBytes(canonical(stripPrivateReceipt(clone(snapshot(model, user)))));
      return commit({
        model,
        user,
        operationId: randomUUID(),
        expectedRevision: state.revision,
        requestDigest,
        apply: () => model
      });
    }
  });
}
