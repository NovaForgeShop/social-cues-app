import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isPromise } from "node:util/types";

const FORMAT = "social-cues.local-workspace-content.v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,127})$/;
const HASH = /^[0-9a-f]{64}$/;

export class WorkspaceContentPersistenceError extends Error {
  constructor(code, status, commitStatus = "not_committed", phase = "") {
    super(code);
    this.name = "WorkspaceContentPersistenceError";
    this.code = code;
    this.status = status;
    this.commitStatus = commitStatus;
    if (phase) this.phase = phase;
  }
}

function fail(code, status = 400, commitStatus, phase) {
  throw new WorkspaceContentPersistenceError(code, status, commitStatus, phase);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// Canonicalize the original JSON request before queuing or invoking application code.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) fail("workspace_input_invalid");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || !Object.hasOwn(descriptors[key], "value"))) fail("workspace_input_invalid");
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)) fail("workspace_input_invalid");
      return "[" + value.map(item => canonical(item, ancestors)).join(",") + "]";
    }
    if (!record(value) || keys.some(key => !descriptors[key].enumerable)) fail("workspace_input_invalid");
    return "{" + keys.sort().map(key => JSON.stringify(key) + ":" + canonical(descriptors[key].value, ancestors)).join(",") + "}";
  } finally { ancestors.delete(value); }
}

const copy = value => JSON.parse(canonical(value));
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const validId = value => typeof value === "string" && ID.test(value);
const validToken = value => record(value) && Object.keys(value).length === 2
  && typeof value.epoch === "string" && UUID.test(value.epoch) && typeof value.revision === "string" && DECIMAL.test(value.revision);
const token = entry => ({ epoch: entry.epoch, revision: entry.revision });
const sameToken = (a, b) => a.epoch === b.epoch && a.revision === b.revision;
function synchronous(value) {
  if (isPromise(value)) {
    value.catch(() => {});
    fail("workspace_callback_must_be_synchronous");
  }
  return value;
}

function validateDocument(value) {
  if (!record(value) || value.format !== FORMAT || !record(value.shared) || !record(value.workspaces)
    || Object.keys(value).sort().join(",") !== "format,shared,workspaces") throw new Error("invalid document");
  for (const [id, entry] of Object.entries(value.workspaces)) {
    if (!validId(id) || !record(entry) || !validToken(token(entry)) || !record(entry.receipts)
      || !Object.hasOwn(entry, "content")
      || Object.keys(entry).sort().join(",") !== "content,epoch,receipts,revision") throw new Error("invalid workspace");
    canonical(entry.content);
    const receiptRevisions = new Set();
    for (const [operationId, receipt] of Object.entries(entry.receipts)) {
      if (!validId(operationId) || !record(receipt) || !validId(receipt.actorId) || !validId(receipt.kind)
        || Object.keys(receipt).sort().join(",") !== "actorId,contentHash,kind,requestHash,revision"
        || typeof receipt.requestHash !== "string" || !HASH.test(receipt.requestHash)
        || typeof receipt.contentHash !== "string" || !HASH.test(receipt.contentHash)
        || typeof receipt.revision !== "string" || !DECIMAL.test(receipt.revision)
        || BigInt(receipt.revision) < 1n || BigInt(receipt.revision) > BigInt(entry.revision)
        || receiptRevisions.has(receipt.revision)
        || (receipt.revision === entry.revision && receipt.contentHash !== digest(entry.content))) throw new Error("invalid receipt");
      receiptRevisions.add(receipt.revision);
    }
  }
}

/**
 * Not a server adapter. Callbacks are trusted, synchronous application code.
 * `fault` is a test-only injection seam; never derive it from a request or env.
 */
export async function openWorkspaceContentStore({
  dataDir, authorize, validateContent, mutations, application = null, fault = () => {}, maxBytes = 64 * 1024 * 1024
} = {}) {
  if (typeof dataDir !== "string" || !dataDir || typeof authorize !== "function"
    || typeof validateContent !== "function" || !record(mutations)
    || !Object.entries(mutations).length || Object.entries(mutations).some(([kind, fn]) => !validId(kind) || typeof fn !== "function")
    || typeof fault !== "function" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("workspace_store_options_invalid");
  const handlers = new Map(Object.entries(mutations));
  if (application && ["authorize", "mutate", "validate"].some(key => typeof application[key] !== "function")) fail("workspace_store_options_invalid");
  let directory;
  try { await fs.mkdir(dataDir, { recursive: true }); directory = await fs.realpath(dataDir); }
  catch { fail("workspace_storage_unavailable", 503, "not_committed", "directory"); }
  const modelPath = path.join(directory, "model.json");
  const lockPath = path.join(directory, ".workspace-content.lock");
  const owner = randomUUID();
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") fail("workspace_writer_busy", 409);
    fail("workspace_storage_unavailable", 503, "not_committed", "lock");
  }
  try {
    await lock.writeFile(JSON.stringify({ owner, pid: process.pid }));
    await lock.sync();
    await lock.close();
  } catch {
    await lock.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
    fail("workspace_storage_unavailable", 503, "not_committed", "lock");
  }

  let queue = Promise.resolve(), closed = false, closePromise, observedFile = false;
  const inject = phase => fault(phase, { directory, modelPath });
  async function verifyLock() {
    try {
      const info = await fs.lstat(lockPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error();
      if (JSON.parse(await fs.readFile(lockPath, "utf8")).owner !== owner) throw new Error();
    } catch { fail("workspace_writer_ownership_lost", 503); }
  }
  async function releaseLock() {
    await verifyLock();
    try { await fs.unlink(lockPath); }
    catch { fail("workspace_storage_unavailable", 503, "not_committed", "unlock"); }
  }
  async function readDisk(allowAbsent = false) {
    try {
      await inject("before-read");
      let info;
      try { info = await fs.lstat(modelPath); }
      catch (error) { if (error.code === "ENOENT" && allowAbsent) return null; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error();
      const bytes = await fs.readFile(modelPath);
      if (bytes.length > maxBytes) throw new Error();
      const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      validateDocument(document);
      observedFile = true;
      return document;
    } catch { fail("workspace_storage_unavailable", 503, "not_committed", "read"); }
  }
  async function flushDirectory() {
    // Node does not provide a portable Windows directory-flush guarantee.
    if (process.platform === "win32") return false;
    let handle;
    try {
      handle = await fs.open(directory, "r");
      await handle.sync();
      return true;
    } finally { await handle?.close(); }
  }
  async function writeDisk(document) {
    const tempPath = path.join(directory, ".workspace-content-" + randomUUID() + ".tmp");
    let handle, created = false, renameAttempted = false, phase = "serialize";
    try {
      validateDocument(document);
      const bytes = canonical(document) + "\n";
      if (Buffer.byteLength(bytes) > maxBytes) throw new Error();
      phase = "temp-open"; await inject("before-temp-open");
      handle = await fs.open(tempPath, "wx", 0o600); created = true;
      phase = "temp-write"; await inject("before-temp-write");
      await handle.writeFile(bytes);
      phase = "temp-sync"; await inject("before-temp-sync");
      await handle.sync();
      await handle.close(); handle = null;
      phase = "before-rename"; await inject("before-rename");
      phase = "rename"; renameAttempted = true;
      await fs.rename(tempPath, modelPath);
      observedFile = true;
      phase = "after-rename"; await inject("after-rename");
      phase = "directory-sync"; await inject("before-directory-sync");
      const directorySynced = await flushDirectory();
      return { fileSynced: true, directorySynced, powerLossGuarantee: "unqualified" };
    } catch {
      fail(renameAttempted ? "workspace_commit_unknown" : "workspace_storage_unavailable", 503,
        renameAttempted ? "unknown" : "not_committed", phase);
    } finally {
      await handle?.close().catch(() => {});
      if (created) {
        try { await fs.unlink(tempPath); }
        catch (error) {
          if (error.code !== "ENOENT") {
            // Failure to clean the owned temporary file is also not successful persistence.
            fail(renameAttempted ? "workspace_commit_unknown" : "workspace_storage_unavailable", 503,
              renameAttempted ? "unknown" : "not_committed", "temp-cleanup");
          }
        }
      }
    }
  }
  function enqueue(action) {
    if (closed) return Promise.reject(new WorkspaceContentPersistenceError("workspace_store_closed", 503));
    const pending = queue.then(async () => { await verifyLock(); return action(); });
    queue = pending.catch(() => {});
    return pending;
  }
  function permission(document, workspaceId, actorId, action, content, kind = action) {
    let allowed;
    try { allowed = synchronous(authorize({ workspaceId, actorId, action, kind, shared: copy(document.shared), content: copy(content) })); }
    catch { fail("workspace_authorization_failed", 403); }
    if (allowed !== true) fail("workspace_authorization_failed", 403);
  }
  function validated(content, context) {
    const value = copy(content);
    let valid;
    try { valid = synchronous(validateContent({ ...context, content: copy(value) })); }
    catch { fail("workspace_content_invalid"); }
    if (valid !== true) fail("workspace_content_invalid");
    return value;
  }
  function find(document, workspaceId) {
    if (!Object.hasOwn(document.workspaces, workspaceId)) fail("workspace_not_found", 404);
    return document.workspaces[workspaceId];
  }
  function receiptView(entry, workspaceId, operationId, replayed) {
    const saved = entry.receipts[operationId];
    const superseded = saved.revision !== entry.revision;
    return { workspaceId, operationId, kind: saved.kind, committedRevision: { epoch: entry.epoch, revision: saved.revision },
      currentRevision: token(entry), contentHash: saved.contentHash, replayed, superseded,
      ...(!superseded ? { content: copy(entry.content) } : {}) };
  }
  async function acknowledge(result) {
    try { await inject("before-response"); }
    catch { fail("workspace_commit_unknown", 503, "unknown", "response"); }
    return result;
  }

  try { await readDisk(true); }
  catch (error) { await releaseLock(); throw error; }

  return Object.freeze({
    directory,
    // Optional server-held interface. It shares the exact queue, lock and atomic file.
    // No metadata can be supplied by its mutation callback; this layer owns receipts.
    ...(application ? {
      snapshot() {
        return enqueue(async () => {
          const document = await readDisk(!observedFile);
          if (synchronous(application.authorize({ action: "snapshot", document: copy(document) })) !== true) fail("workspace_authorization_failed", 403);
          return copy(document);
        });
      },
      transact(input) {
        const original = copy(input);
        const { actorId, workspaceId, kind, operationId, expectedRevision } = original;
        if (!validId(actorId) || !validId(workspaceId) || !validId(kind) || !validId(operationId)) fail("workspace_input_invalid");
        const client = kind === "model-save" || kind === "content-recovery";
        if (client && expectedRevision == null) fail("workspace_revision_required", 428);
        if (client && !validToken(expectedRevision)) fail("workspace_revision_invalid");
        const requestHash = digest(original);
        return enqueue(async () => {
          const document = await readDisk(!observedFile);
          if (synchronous(application.authorize({ action: "transact", document: copy(document), input: copy(original) })) !== true) fail("workspace_authorization_failed", 403);
          const entry = document?.workspaces[workspaceId];
          if (client) {
            if (!entry) fail("workspace_not_found", 404);
            if (Object.hasOwn(entry.receipts, operationId)) {
              const receipt = entry.receipts[operationId];
              if (receipt.actorId !== actorId || receipt.kind !== kind || receipt.requestHash !== requestHash) fail("workspace_operation_id_reused", 409);
              return acknowledge({ ...receiptView(entry, workspaceId, operationId, true), document: copy(document) });
            }
            if (!sameToken(expectedRevision, token(entry))) fail("workspace_revision_conflict", 409);
          }
          const next = synchronous(application.mutate({ document: copy(document), input: copy(original) }));
          if (!record(next) || !record(next.shared) || !record(next.workspaces) || Object.keys(next.workspaces).length === 0
            || synchronous(application.validate({ previous: copy(document), next: copy(next), input: copy(original) })) !== true) fail("workspace_content_invalid");
          const updated = document || { format: FORMAT, shared: {}, workspaces: {} };
          if (Object.keys(updated.workspaces).some(id => !Object.hasOwn(next.workspaces, id))) fail("workspace_content_invalid");
          updated.shared = copy(next.shared);
          for (const [id, content] of Object.entries(next.workspaces)) {
            if (!validId(id)) fail("workspace_content_invalid");
            let target = updated.workspaces[id];
            if (!target) {
              target = updated.workspaces[id] = { content: copy(content), epoch: randomUUID(), revision: "0", receipts: {} };
            } else if (digest(target.content) !== digest(content) || (client && id === workspaceId)) {
              target.content = copy(content);
              target.revision = String(BigInt(target.revision) + 1n);
            }
          }
          if (client) {
            const target = updated.workspaces[workspaceId];
            target.receipts[operationId] = { actorId, kind, requestHash, revision: target.revision, contentHash: digest(target.content) };
          }
          const durability = await writeDisk(updated);
          return acknowledge({ document: copy(updated), durability,
            ...(client ? receiptView(updated.workspaces[workspaceId], workspaceId, operationId, false) : {}) });
        });
      }
    } : {}),
    // This bootstrap is for a confirmed absent, explicitly authorized new store only.
    initialize(input) {
      const captured = copy(input);
      return enqueue(async () => {
        const existing = await readDisk(!observedFile);
        if (existing) fail("workspace_already_initialized", 409);
        if (!record(captured) || !validId(captured.actorId) || !record(captured.shared) || !record(captured.workspaces)
          || Object.keys(captured.workspaces).length === 0
          || Object.keys(captured).sort().join(",") !== "actorId,shared,workspaces") fail("workspace_input_invalid");
        const document = { format: FORMAT, shared: captured.shared, workspaces: {} };
        for (const [workspaceId, content] of Object.entries(captured.workspaces)) {
          if (!validId(workspaceId)) fail("workspace_input_invalid");
          permission(document, workspaceId, captured.actorId, "initialize", content);
          document.workspaces[workspaceId] = { content: validated(content, { workspaceId, actorId: captured.actorId, kind: "initialize" }),
            epoch: randomUUID(), revision: "0", receipts: {} };
        }
        const durability = await writeDisk(document);
        return acknowledge({ initialized: true, durability });
      });
    },
    read(input = {}) {
      const captured = copy(input);
      if (!record(captured)) fail("workspace_input_invalid");
      const { workspaceId, actorId } = captured;
      if (!validId(workspaceId) || !validId(actorId)) fail("workspace_input_invalid");
      return enqueue(async () => {
        const document = await readDisk(), entry = find(document, workspaceId);
        permission(document, workspaceId, actorId, "read", entry.content);
        return { workspaceId, content: copy(entry.content), revision: token(entry) };
      });
    },
    commit(input = {}) {
      const original = copy(input);
      if (!record(original)) fail("workspace_input_invalid");
      const { workspaceId, actorId, kind, operationId, expectedRevision, request } = original;
      if (!validId(workspaceId) || !validId(actorId) || !validId(operationId) || !handlers.has(kind)
        || !Object.hasOwn(original, "request")
        || Object.keys(original).sort().join(",") !== "actorId,expectedRevision,kind,operationId,request,workspaceId") {
        if (!Object.hasOwn(original, "expectedRevision")) fail("workspace_revision_required", 428);
        fail("workspace_input_invalid");
      }
      if (expectedRevision === null) fail("workspace_revision_required", 428);
      if (!validToken(expectedRevision)) fail("workspace_revision_invalid");
      const requestHash = digest(original);
      return enqueue(async () => {
        const document = await readDisk(), entry = find(document, workspaceId);
        permission(document, workspaceId, actorId, "commit", entry.content, kind);
        if (Object.hasOwn(entry.receipts, operationId)) {
          const saved = entry.receipts[operationId];
          if (saved.actorId !== actorId || saved.kind !== kind || saved.requestHash !== requestHash) fail("workspace_operation_id_reused", 409);
          return acknowledge(receiptView(entry, workspaceId, operationId, true));
        }
        if (!sameToken(expectedRevision, token(entry))) fail("workspace_revision_conflict", 409);
        let content;
        try { content = synchronous(handlers.get(kind)({ content: copy(entry.content), request: copy(request), workspaceId, actorId })); }
        catch { fail("workspace_mutation_invalid"); }
        content = validated(content, { workspaceId, actorId, kind, previousContent: copy(entry.content) });
        entry.content = content;
        entry.revision = String(BigInt(entry.revision) + 1n);
        entry.receipts[operationId] = { actorId, kind, requestHash, revision: entry.revision, contentHash: digest(content) };
        const durability = await writeDisk(document);
        return acknowledge({ ...receiptView(entry, workspaceId, operationId, false), durability });
      });
    },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = queue.then(releaseLock);
      }
      return closePromise;
    }
  });
}
