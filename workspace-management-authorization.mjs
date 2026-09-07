const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const localCanonicalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const identityPolicies = new Set(["hosted_uuid", "local_canonical"]);
const managementRoles = new Set(["owner", "admin"]);
const deniedMessage = "Workspace management access denied.";

function uuidValue(value) {
  return typeof value === "string" && uuidPattern.test(value.trim()) ? value.trim().toLowerCase() : "";
}

function firstUuid(...values) {
  return values.map(uuidValue).find(Boolean) || "";
}

function localCanonicalValue(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length >= 3 && normalized.length <= 128 && localCanonicalPattern.test(normalized)
    ? normalized
    : "";
}

function identityValue(identityPolicy, value) {
  return identityPolicy === "local_canonical" ? localCanonicalValue(value) : uuidValue(value);
}

function authenticatedUserId(identityPolicy, user = {}) {
  return identityPolicy === "local_canonical"
    ? localCanonicalValue(user.id)
    : firstUuid(user.supabaseUserId, user.id);
}

function optionalWorkspaceId(identityPolicy, value) {
  if (value === undefined || value === null || value === "") return { supplied: false, value: "" };
  return { supplied: true, value: identityValue(identityPolicy, value) };
}

function safeAction(value) {
  return String(value || "workspace.manage")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "_")
    .slice(0, 120) || "workspace.manage";
}

function authorizationError(category) {
  const error = new Error(deniedMessage);
  error.name = "WorkspaceManagementAuthorizationError";
  error.code = "WORKSPACE_MANAGEMENT_ACCESS_DENIED";
  error.category = category;
  error.status = category === "unauthenticated" ? 401 : 403;
  return error;
}

function resolvedNow(now) {
  const value = typeof now === "function" ? Number(now()) : Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

export async function requireWorkspaceManagementAccess({
  session = null,
  identityPolicy = "hosted_uuid",
  requestedWorkspaceId = "",
  resourceWorkspaceId = "",
  lookupMembership,
  auditDenied,
  action = "workspace.manage",
  now = Date.now
} = {}) {
  const nowMs = resolvedNow(now);
  const policy = identityPolicies.has(identityPolicy) ? identityPolicy : "";
  const userId = policy ? authenticatedUserId(policy, session?.user) : "";
  const workspaceId = policy ? identityValue(policy, session?.device?.workspaceId) : "";
  const actionName = safeAction(action);

  const deny = async category => {
    if (typeof auditDenied === "function") {
      try {
        await auditDenied({
          userId,
          workspaceId,
          action: actionName,
          category,
          at: new Date(nowMs).toISOString()
        });
      } catch {
        // Authorization remains fail-closed when best-effort audit persistence is unavailable.
      }
    }
    throw authorizationError(category);
  };

  if (!policy) await deny("invalid_identity_policy");
  if (!session?.user || !userId) await deny("unauthenticated");
  if (!session?.device || !workspaceId) await deny("missing_active_workspace");

  const deviceUserId = identityValue(policy, session.device.userId);
  if (!deviceUserId || deviceUserId !== userId || session.device.revokedAt || session.device.trusted === false) {
    await deny("invalid_session");
  }
  if (session.device.expiresAt) {
    const expiresAt = Date.parse(session.device.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) await deny("invalid_session");
  }

  for (const candidate of [requestedWorkspaceId, resourceWorkspaceId].map(value => optionalWorkspaceId(policy, value))) {
    if (candidate.supplied && (!candidate.value || candidate.value !== workspaceId)) {
      await deny("workspace_context_mismatch");
    }
  }

  if (typeof lookupMembership !== "function") await deny("membership_lookup_failed");

  let membership;
  try {
    membership = await lookupMembership({ workspaceId, userId });
  } catch {
    await deny("membership_lookup_failed");
  }

  const membershipWorkspaceId = identityValue(policy, membership?.workspace_id);
  const membershipUserId = identityValue(policy, membership?.user_id);
  if (!membership || membershipWorkspaceId !== workspaceId || membershipUserId !== userId) {
    await deny("missing_membership");
  }

  const membershipStatus = String(membership.status || "").trim().toLowerCase();
  if ((policy === "local_canonical" && membershipStatus !== "active")
    || (policy === "hosted_uuid" && membershipStatus && membershipStatus !== "active")) {
    await deny("missing_membership");
  }

  const role = String(membership.role || "").trim().toLowerCase();
  const managementRole = policy === "local_canonical" ? role === "owner" : managementRoles.has(role);
  if (!managementRole) await deny("insufficient_workspace_role");

  return Object.freeze({ userId, workspaceId, role });
}
