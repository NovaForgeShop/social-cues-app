const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WORKSPACE_IDENTITY_FIELDS = Object.freeze([
  "id",
  "ownerUserId",
  "createdAt",
  "workspaceId",
  "tenantId",
  "organizationId",
  "ownerId",
  "createdBy",
  "createdByUserId"
]);
const MODEL_IDENTITY_SELECTORS = Object.freeze([
  "activeWorkspaceId",
  "workspaceId",
  "tenantId",
  "organizationId"
]);

export class LocalWorkspaceOwnershipError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "LocalWorkspaceOwnershipError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new LocalWorkspaceOwnershipError(code, message, status);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value, label = "ownership input") {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail("ownership_integrity_invalid", `${label} is not JSON data.`);
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof LocalWorkspaceOwnershipError) throw error;
    fail("ownership_integrity_invalid", `${label} is not valid JSON data.`);
  }
}

function localIdentity(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 3 || normalized.length > 128 || !LOCAL_ID_PATTERN.test(normalized)) {
    fail("ownership_integrity_invalid", `${label} is invalid.`);
  }
  return normalized;
}

function creationTimestamp(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 64 || !Number.isFinite(Date.parse(normalized))) {
    fail("ownership_integrity_invalid", "Workspace creation identity is invalid.");
  }
  return normalized;
}

function withoutWorkspaceIdentity(workspace = {}) {
  if (!isRecord(workspace)) fail("ownership_integrity_invalid", "Workspace data must be an object.");
  const safe = cloneJson(workspace, "workspace data");
  for (const field of WORKSPACE_IDENTITY_FIELDS) delete safe[field];
  return safe;
}

function workspaceIdentity(workspace, label = "workspace") {
  if (!isRecord(workspace)) fail("ownership_integrity_invalid", `${label} is unavailable.`);
  return {
    id: localIdentity(workspace.id, `${label} ID`),
    ownerUserId: localIdentity(workspace.ownerUserId, `${label} owner`),
    createdAt: creationTimestamp(workspace.createdAt)
  };
}

function canonicalCollection(model, activeWorkspaceId, authenticatedUserId) {
  if (!isRecord(model) || !Array.isArray(model.workspaces)) {
    fail("workspace_unavailable", "The canonical workspace record is unavailable.", 409);
  }
  const byId = new Map();
  for (const workspace of model.workspaces) {
    const identity = workspaceIdentity(workspace, "Stored workspace");
    if (byId.has(identity.id)) {
      fail("workspace_identity_conflict", "Stored workspace identity is duplicated.");
    }
    byId.set(identity.id, { workspace, identity });
  }
  const active = byId.get(activeWorkspaceId);
  if (!active) fail("workspace_unavailable", "The active workspace is unavailable.", 409);
  if (active.identity.ownerUserId !== authenticatedUserId) {
    fail("ownership_mismatch", "The active workspace owner does not match the authenticated account.", 403);
  }

  if (isRecord(model.workspace) && model.workspace.id) {
    const topLevel = workspaceIdentity(model.workspace, "Top-level workspace");
    const matching = byId.get(topLevel.id);
    if (!matching
      || matching.identity.ownerUserId !== topLevel.ownerUserId
      || matching.identity.createdAt !== topLevel.createdAt) {
      fail("workspace_identity_conflict", "Top-level and stored workspace identity conflict.");
    }
  }
  return { byId, active };
}

function assertIncomingSelectors(incomingModel, activeWorkspaceId) {
  if (!isRecord(incomingModel)) fail("ownership_integrity_invalid", "Incoming model must be an object.", 400);
  if (isRecord(incomingModel.workspace) && incomingModel.workspace.id) {
    const requestedId = localIdentity(incomingModel.workspace.id, "Incoming workspace ID");
    if (requestedId !== activeWorkspaceId) {
      fail("workspace_identity_conflict", "Incoming workspace identity does not match the active workspace.");
    }
  }
  for (const selector of MODEL_IDENTITY_SELECTORS) {
    if (!Object.prototype.hasOwnProperty.call(incomingModel, selector) || !incomingModel[selector]) continue;
    const requestedId = localIdentity(incomingModel[selector], `Incoming ${selector}`);
    if (requestedId !== activeWorkspaceId) {
      fail("workspace_identity_conflict", "Incoming active workspace selection is not permitted.");
    }
  }
  if (incomingModel.workspaces === undefined) return;
  if (!Array.isArray(incomingModel.workspaces)) {
    fail("workspace_identity_conflict", "Incoming workspace collection is invalid.");
  }
  const seen = new Set();
  for (const workspace of incomingModel.workspaces) {
    if (!isRecord(workspace)) fail("workspace_identity_conflict", "Incoming workspace collection is invalid.");
    const id = localIdentity(workspace.id, "Incoming workspace collection ID");
    if (seen.has(id)) fail("workspace_identity_conflict", "Incoming workspace identity is duplicated.");
    seen.add(id);
    if (id !== activeWorkspaceId) {
      fail("workspace_identity_conflict", "Incoming workspace collection contains a foreign workspace.");
    }
  }
}

export function createLocalWorkspaceIdentity({
  authenticatedUserId,
  generatedWorkspaceId,
  createdAt,
  workspace = {}
} = {}) {
  const ownerUserId = localIdentity(authenticatedUserId, "Authenticated user ID");
  const id = localIdentity(generatedWorkspaceId, "Generated workspace ID");
  const canonicalCreatedAt = creationTimestamp(createdAt);
  return {
    ...withoutWorkspaceIdentity(workspace),
    id,
    ownerUserId,
    createdAt: canonicalCreatedAt
  };
}

export function validateLocalOwnershipState({ model, activeWorkspaceId, authenticatedUserId } = {}) {
  const userId = localIdentity(authenticatedUserId, "Authenticated user ID");
  const workspaceId = localIdentity(activeWorkspaceId, "Active workspace ID");
  const { active } = canonicalCollection(model, workspaceId, userId);
  const topLevel = workspaceIdentity(model.workspace, "Top-level workspace");
  if (topLevel.id !== workspaceId
    || topLevel.ownerUserId !== active.identity.ownerUserId
    || topLevel.createdAt !== active.identity.createdAt) {
    fail("workspace_identity_conflict", "The active workspace identity is inconsistent.");
  }
  return { ...active.identity };
}

export function applyCanonicalLocalOwnership({
  authenticatedUserId,
  activeWorkspaceId,
  currentModel,
  incomingModel,
  operation = "model-update"
} = {}) {
  const userId = localIdentity(authenticatedUserId, "Authenticated user ID");
  const workspaceId = localIdentity(activeWorkspaceId, "Active workspace ID");
  if (!new Set(["model-update", "import", "restore"]).has(operation)) {
    fail("ownership_integrity_invalid", "The ownership operation is invalid.", 400);
  }
  const current = cloneJson(currentModel, "current model");
  const incoming = cloneJson(incomingModel, "incoming model");
  const { active } = canonicalCollection(current, workspaceId, userId);
  assertIncomingSelectors(incoming, workspaceId);

  const incomingCollectionWorkspace = Array.isArray(incoming.workspaces)
    ? incoming.workspaces.find(workspace => workspace.id === workspaceId) || {}
    : {};
  const editableWorkspace = {
    ...withoutWorkspaceIdentity(incomingCollectionWorkspace),
    ...withoutWorkspaceIdentity(isRecord(incoming.workspace) ? incoming.workspace : {})
  };
  const nextWorkspace = {
    ...cloneJson(active.workspace, "canonical workspace"),
    ...editableWorkspace,
    ...active.identity
  };
  const next = incoming;
  next.workspace = nextWorkspace;
  next.workspaces = current.workspaces.map(workspace => (
    workspace.id === workspaceId ? cloneJson(nextWorkspace) : cloneJson(workspace)
  ));

  if (Object.prototype.hasOwnProperty.call(current, "workspaceModel")) {
    next.workspaceModel = cloneJson(current.workspaceModel, "workspace provenance");
  } else {
    delete next.workspaceModel;
  }
  for (const selector of MODEL_IDENTITY_SELECTORS) {
    if (Object.prototype.hasOwnProperty.call(current, selector)) {
      next[selector] = selector === "activeWorkspaceId"
        ? workspaceId
        : cloneJson(current[selector], `stored ${selector}`);
    } else {
      delete next[selector];
    }
  }

  validateLocalOwnershipState({
    model: next,
    activeWorkspaceId: workspaceId,
    authenticatedUserId: userId
  });
  return next;
}
