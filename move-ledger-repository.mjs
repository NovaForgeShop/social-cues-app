import { createHash } from "node:crypto";
import { isPromise } from "node:util/types";
import { hydrateMoveLedger, MoveLedgerError } from "./move-ledger.mjs";
import {
  openWorkspaceContentStore,
  WorkspaceContentPersistenceError
} from "./workspace-content-persistence.mjs";

export const MOVE_LEDGER_REPOSITORY_VERSION = "social-cues.move-ledger-repository.v1";

const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const STORE_SHARED = Object.freeze({
  domain: "move-ledger",
  version: MOVE_LEDGER_REPOSITORY_VERSION
});

export class MoveLedgerRepositoryError extends Error {
  constructor(code, status = 400, options = {}) {
    super(code);
    this.name = "MoveLedgerRepositoryError";
    this.code = code;
    this.status = status;
    this.commitStatus = options.commitStatus || "not_committed";
    if (options.phase) this.phase = options.phase;
  }
}

function fail(code, status = 400, options) {
  throw new MoveLedgerRepositoryError(code, status, options);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function localId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!LOCAL_ID_PATTERN.test(normalized)) fail("move_ledger_repository_input_invalid");
  return normalized;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapPersistenceError(error) {
  if (error instanceof MoveLedgerRepositoryError || error instanceof MoveLedgerError) return error;
  if (!(error instanceof WorkspaceContentPersistenceError)) {
    return new MoveLedgerRepositoryError("move_ledger_storage_unavailable", 503);
  }
  const mapped = {
    workspace_authorization_failed: ["move_ledger_not_authorized", 403],
    workspace_not_found: ["move_ledger_not_found", 404],
    workspace_revision_conflict: ["move_ledger_revision_conflict", 409],
    workspace_revision_required: ["move_ledger_revision_required", 428],
    workspace_revision_invalid: ["move_ledger_revision_invalid", 400],
    workspace_operation_id_reused: ["move_ledger_operation_conflict", 409],
    workspace_writer_busy: ["move_ledger_writer_busy", 409],
    workspace_writer_ownership_lost: ["move_ledger_storage_unavailable", 503],
    workspace_commit_unknown: ["move_ledger_commit_unknown", 503],
    workspace_store_closed: ["move_ledger_repository_closed", 503],
    workspace_input_invalid: ["move_ledger_repository_input_invalid", 400],
    workspace_content_invalid: ["move_ledger_state_invalid", 400],
    workspace_storage_unavailable: ["move_ledger_storage_unavailable", 503]
  }[error.code] || ["move_ledger_storage_unavailable", 503];
  return new MoveLedgerRepositoryError(mapped[0], mapped[1], {
    commitStatus: error.commitStatus,
    phase: error.phase
  });
}

async function translated(action) {
  try {
    return await action();
  } catch (error) {
    throw mapPersistenceError(error);
  }
}

function ledgerContent(value, workspaceId, stored = false) {
  try {
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== "ledger") {
      throw new MoveLedgerError("move_ledger_state_invalid", "Move ledger content is invalid.");
    }
    const ledger = hydrateMoveLedger(value.ledger);
    if (ledger.workspaceId !== workspaceId) {
      throw new MoveLedgerError("move_ledger_workspace_mismatch", "Move ledger workspace is invalid.", 403);
    }
    return { ledger };
  } catch (error) {
    if (!stored) throw error;
    fail("move_ledger_storage_corrupt", 503);
  }
}

function validShared(value) {
  return isRecord(value)
    && Object.keys(value).sort().join(",") === "domain,version"
    && value.domain === STORE_SHARED.domain
    && value.version === STORE_SHARED.version;
}

function validateStoredDocument(document) {
  if (document === null) return null;
  try {
    if (!isRecord(document) || !validShared(document.shared) || !isRecord(document.workspaces)) {
      throw new Error("invalid move ledger repository document");
    }
    for (const [workspaceId, entry] of Object.entries(document.workspaces)) {
      localId(workspaceId);
      if (!isRecord(entry)) throw new Error("invalid move ledger repository entry");
      ledgerContent(entry.content, workspaceId, true);
    }
    return document;
  } catch {
    fail("move_ledger_storage_corrupt", 503);
  }
}

function stableCreateOperationId(workspaceId) {
  return `move-create-${createHash("sha256").update(workspaceId).digest("hex").slice(0, 48)}`;
}

export function assertMoveLedgerRepository(repository) {
  if (!repository || ["load", "createIfAbsent", "compareAndSet"].some(name => typeof repository[name] !== "function")) {
    throw new TypeError("move_ledger_repository_required");
  }
  return repository;
}

export async function openLocalMoveLedgerRepository({
  dataDir,
  authorize,
  fault,
  maxBytes = 16 * 1024 * 1024
} = {}) {
  if (typeof authorize !== "function" || (fault !== undefined && typeof fault !== "function")) {
    fail("move_ledger_repository_options_invalid");
  }

  function authorized(input) {
    let decision;
    try {
      decision = authorize({
        actorId: input.actorId,
        workspaceId: input.workspaceId,
        action: input.action
      });
    } catch {
      return false;
    }
    if (isPromise(decision)) {
      decision.catch(() => {});
      return false;
    }
    return decision === true;
  }

  function requireAccess(actorId, workspaceId, action) {
    const identity = {
      actorId: localId(actorId),
      workspaceId: localId(workspaceId)
    };
    if (!authorized({ ...identity, action: localId(action) })) fail("move_ledger_not_authorized", 403);
    return identity;
  }

  let store;
  try {
    store = await openWorkspaceContentStore({
      dataDir,
      fault: fault || (() => {}),
      maxBytes,
      authorize: ({ actorId, workspaceId, action }) => authorized({
        actorId,
        workspaceId,
        action: action === "commit" ? "write" : action
      }),
      validateContent: ({ workspaceId, content }) => {
        try {
          ledgerContent(content, workspaceId);
          return true;
        } catch {
          return false;
        }
      },
      mutations: {
        "replace-ledger": ({ workspaceId, content, request }) => {
          ledgerContent(content, workspaceId, true);
          if (!isRecord(request) || Object.keys(request).sort().join(",") !== "ledger") {
            fail("move_ledger_repository_input_invalid");
          }
          return ledgerContent({ ledger: request.ledger }, workspaceId);
        }
      },
      application: {
        authorize({ action, input }) {
          if (action === "snapshot") return true;
          return input?.kind === "move-ledger-create"
            && authorized({ actorId: input.actorId, workspaceId: input.workspaceId, action: "create" });
        },
        mutate({ document, input }) {
          if (!isRecord(input?.request) || Object.keys(input.request).sort().join(",") !== "ledger") {
            fail("move_ledger_repository_input_invalid");
          }
          const workspaceId = localId(input.workspaceId);
          const content = ledgerContent({ ledger: input.request.ledger }, workspaceId);
          const stored = validateStoredDocument(document);
          const next = {
            shared: clone(stored?.shared || STORE_SHARED),
            workspaces: Object.fromEntries(Object.entries(stored?.workspaces || {})
              .map(([id, entry]) => [id, clone(entry.content)]))
          };
          if (!Object.hasOwn(next.workspaces, workspaceId)) next.workspaces[workspaceId] = content;
          return next;
        },
        validate({ previous, next, input }) {
          try {
            if (!validShared(next.shared) || !isRecord(next.workspaces) || Object.keys(next.workspaces).length === 0) return false;
            for (const [workspaceId, content] of Object.entries(next.workspaces)) ledgerContent(content, workspaceId);
            if (!previous) return Object.keys(next.workspaces).length === 1
              && Object.hasOwn(next.workspaces, input.workspaceId);
            validateStoredDocument(previous);
            for (const [workspaceId, entry] of Object.entries(previous.workspaces)) {
              if (!Object.hasOwn(next.workspaces, workspaceId)) return false;
              if (!sameValue(next.workspaces[workspaceId], entry.content)) return false;
            }
            const added = Object.keys(next.workspaces)
              .filter(workspaceId => !Object.hasOwn(previous.workspaces, workspaceId));
            return added.length === 0 || (added.length === 1 && added[0] === input.workspaceId);
          } catch {
            return false;
          }
        }
      }
    });
    validateStoredDocument(await store.snapshot());
  } catch (error) {
    await store?.close().catch(() => {});
    throw mapPersistenceError(error);
  }

  async function load(input = {}) {
    const identity = requireAccess(input.actorId, input.workspaceId, "read");
    return translated(async () => {
      const document = validateStoredDocument(await store.snapshot());
      const entry = document?.workspaces?.[identity.workspaceId];
      if (!entry) fail("move_ledger_not_found", 404);
      const content = ledgerContent(entry.content, identity.workspaceId, true);
      return Object.freeze({
        ledger: content.ledger,
        revision: Object.freeze({ epoch: entry.epoch, revision: entry.revision })
      });
    });
  }

  async function createIfAbsent(input = {}) {
    const identity = requireAccess(input.actorId, input.workspaceId, "create");
    const content = ledgerContent({ ledger: input.ledger }, identity.workspaceId);
    return translated(async () => {
      const result = await store.transact({
        actorId: identity.actorId,
        workspaceId: identity.workspaceId,
        kind: "move-ledger-create",
        operationId: stableCreateOperationId(identity.workspaceId),
        request: content
      });
      const entry = result.document?.workspaces?.[identity.workspaceId];
      if (!entry) fail("move_ledger_storage_corrupt", 503);
      const stored = ledgerContent(entry.content, identity.workspaceId, true);
      return Object.freeze({
        ledger: stored.ledger,
        revision: Object.freeze({ epoch: entry.epoch, revision: entry.revision }),
        durability: result.durability ? Object.freeze({ ...result.durability }) : null
      });
    });
  }

  async function compareAndSet(input = {}) {
    const identity = requireAccess(input.actorId, input.workspaceId, "write");
    const operationId = localId(input.operationId);
    const content = ledgerContent({ ledger: input.ledger }, identity.workspaceId);
    return translated(async () => {
      const result = await store.commit({
        actorId: identity.actorId,
        workspaceId: identity.workspaceId,
        kind: "replace-ledger",
        operationId,
        expectedRevision: input.expectedRevision,
        request: content
      });
      const current = result.content
        ? { ledger: ledgerContent(result.content, identity.workspaceId, true).ledger, revision: result.currentRevision }
        : await load({ actorId: identity.actorId, workspaceId: identity.workspaceId });
      return Object.freeze({
        ledger: current.ledger,
        revision: Object.freeze({ ...current.revision }),
        committedRevision: Object.freeze({ ...result.committedRevision }),
        replayed: result.replayed === true,
        superseded: result.superseded === true,
        durability: result.durability ? Object.freeze({ ...result.durability }) : null
      });
    });
  }

  return Object.freeze({
    version: MOVE_LEDGER_REPOSITORY_VERSION,
    directory: store.directory,
    load,
    createIfAbsent,
    compareAndSet,
    close: () => translated(() => store.close())
  });
}
