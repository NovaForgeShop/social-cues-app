import { validateLocalOwnershipState } from "./local-workspace-ownership.mjs";

const localCanonicalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function localCanonicalValue(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length >= 3 && normalized.length <= 128 && localCanonicalPattern.test(normalized)
    ? normalized
    : "";
}

function inactiveWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return true;
  if (workspace.active === false || workspace.deleted === true || workspace.archived === true) return true;
  if (["deletedAt", "archivedAt", "inactiveAt", "revokedAt"].some(field => Boolean(workspace[field]))) return true;
  const status = typeof workspace.status === "string" ? workspace.status.trim().toLowerCase() : "";
  return ["deleted", "archived", "inactive", "revoked", "unavailable"].includes(status);
}

export function resolveLocalWorkspaceManagementMembership({
  localMode = false,
  authenticatedUserId = "",
  activeWorkspaceId = "",
  canonicalModel = null
} = {}) {
  if (localMode !== true) return null;
  const userId = localCanonicalValue(authenticatedUserId);
  const workspaceId = localCanonicalValue(activeWorkspaceId);
  if (!userId || !workspaceId || !canonicalModel || typeof canonicalModel !== "object" || Array.isArray(canonicalModel)) {
    return null;
  }

  try {
    const identity = validateLocalOwnershipState({
      model: canonicalModel,
      activeWorkspaceId: workspaceId,
      authenticatedUserId: userId
    });
    const matches = Array.isArray(canonicalModel.workspaces)
      ? canonicalModel.workspaces.filter(workspace => workspace?.id === workspaceId)
      : [];
    const topLevel = canonicalModel.workspace;
    const stored = matches[0];
    if (matches.length !== 1
      || !topLevel
      || topLevel.id !== workspaceId
      || stored?.id !== workspaceId
      || identity.id !== workspaceId
      || identity.ownerUserId !== userId
      || topLevel.ownerUserId !== userId
      || stored.ownerUserId !== userId
      || topLevel.createdAt !== identity.createdAt
      || stored.createdAt !== identity.createdAt
      || inactiveWorkspace(topLevel)
      || inactiveWorkspace(stored)) {
      return null;
    }
    return Object.freeze({
      workspace_id: workspaceId,
      user_id: userId,
      role: "owner",
      status: "active"
    });
  } catch {
    return null;
  }
}
