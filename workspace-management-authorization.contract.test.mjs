import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { fixtureModel, injectSharedFixture } from "./tests/support/local-envelope-fixture.mjs";

const originalFetch = globalThis.fetch;
let externalRequests = 0;
globalThis.fetch = async () => {
  externalRequests += 1;
  throw new Error("External requests are forbidden in workspace authorization contract tests.");
};

const authorizationModuleUrl = new URL("./workspace-management-authorization.mjs", import.meta.url);
const localMembershipModuleUrl = new URL("./local-workspace-membership.mjs", import.meta.url);
const ownershipModuleUrl = new URL("./local-workspace-ownership.mjs", import.meta.url);
const serverUrl = new URL("./server.mjs", import.meta.url);
const testUrl = new URL("./workspace-management-authorization.contract.test.mjs", import.meta.url);
const authorizationModule = await import(authorizationModuleUrl.href);
const localMembershipModule = await import(localMembershipModuleUrl.href);
const ownershipModule = await import(ownershipModuleUrl.href);
const { requireWorkspaceManagementAccess } = authorizationModule;
const { resolveLocalWorkspaceManagementMembership } = localMembershipModule;
const { validateLocalOwnershipState } = ownershipModule;
const [authorizationSource, localMembershipSource, ownershipSource, serverSource, testSource] = await Promise.all([
  readFile(authorizationModuleUrl, "utf8"),
  readFile(localMembershipModuleUrl, "utf8"),
  readFile(ownershipModuleUrl, "utf8"),
  readFile(serverUrl, "utf8"),
  readFile(testUrl, "utf8")
]);

const USER = "11111111-1111-4111-8111-111111111111";
const SECOND_USER = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WORKSPACE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = Date.parse("2026-08-02T21:00:00.000Z");
const FUTURE = "2026-08-03T21:00:00.000Z";
const LOCAL_USER = "user-owner-a";
const LOCAL_SECOND_USER = "user-owner-b";
const LOCAL_WORKSPACE = "workspace-owner-a";
const LOCAL_SECOND_WORKSPACE = "workspace-owner-b";
const LOCAL_CREATED = "2026-08-30T12:00:00.000Z";
const LOCAL_SECOND_CREATED = "2026-08-30T12:01:00.000Z";
let passed = 0;
let identityPolicyChecks = 0;
let hostileMutationCount = 0;
let httpProbeCount = 0;
const categoryCounts = Object.create(null);

function membership(role, workspaceId = WORKSPACE_A, userId = USER) {
  return { workspace_id: workspaceId, user_id: userId, role };
}

function localMembership(role = "owner", workspaceId = LOCAL_WORKSPACE, userId = LOCAL_USER, status = "active") {
  return { workspace_id: workspaceId, user_id: userId, role, status };
}

function session(overrides = {}) {
  const userId = overrides.userId || USER;
  const workspaceId = Object.hasOwn(overrides, "workspaceId") ? overrides.workspaceId : WORKSPACE_A;
  return {
    user: {
      id: userId,
      supabaseUserId: userId,
      workspaceId: overrides.userWorkspaceId || workspaceId,
      role: overrides.globalRole || "Member",
      raw_user_meta_data: overrides.rawUserMetaData || {}
    },
    device: {
      userId: overrides.deviceUserId || userId,
      workspaceId,
      trusted: overrides.trusted !== false,
      revokedAt: overrides.revokedAt || null,
      expiresAt: overrides.expiresAt || FUTURE
    },
    token: overrides.token || "contract-session-token"
  };
}

function localSession(overrides = {}) {
  const userId = Object.hasOwn(overrides, "userId") ? overrides.userId : LOCAL_USER;
  const workspaceId = Object.hasOwn(overrides, "workspaceId") ? overrides.workspaceId : LOCAL_WORKSPACE;
  return {
    user: {
      id: userId,
      email: overrides.email || "local-owner-a@example.test",
      role: overrides.globalRole || "Member",
      raw_user_meta_data: overrides.rawUserMetaData || {},
      profile: overrides.profile || {},
      providerMetadata: overrides.providerMetadata || {},
      stripeMetadata: overrides.stripeMetadata || {}
    },
    device: {
      userId: Object.hasOwn(overrides, "deviceUserId") ? overrides.deviceUserId : userId,
      workspaceId,
      trusted: overrides.trusted !== false,
      revokedAt: overrides.revokedAt || null,
      expiresAt: overrides.expiresAt || FUTURE
    },
    token: overrides.token || "local-contract-session-token"
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function localWorkspace(id = LOCAL_WORKSPACE, ownerUserId = LOCAL_USER, createdAt = LOCAL_CREATED, extra = {}) {
  return { id, ownerUserId, createdAt, name: `Canonical ${id}`, ...extra };
}

function localCanonicalModel({
  userId = LOCAL_USER,
  workspaceId = LOCAL_WORKSPACE,
  createdAt = LOCAL_CREATED,
  workspaceExtra = {},
  modelExtra = {}
} = {}) {
  const active = localWorkspace(workspaceId, userId, createdAt, workspaceExtra);
  return {
    currentUser: { id: userId, email: "local-owner-a@example.test", role: "Member" },
    workspace: clone(active),
    workspaces: [
      clone(active),
      localWorkspace(LOCAL_SECOND_WORKSPACE, LOCAL_SECOND_USER, LOCAL_SECOND_CREATED)
    ],
    profile: {},
    providerMetadata: {},
    stripeMetadata: {},
    ...modelExtra
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function localLookup(model, calls = []) {
  return async ({ workspaceId, userId }) => {
    calls.push({ workspaceId, userId });
    return resolveLocalWorkspaceManagementMembership({
      localMode: true,
      authenticatedUserId: userId,
      activeWorkspaceId: workspaceId,
      canonicalModel: model
    });
  };
}

function membershipLookup(rows = [], calls = []) {
  return async ({ workspaceId, userId }) => {
    calls.push({ workspaceId, userId });
    return rows.find(row => row.workspace_id === workspaceId && row.user_id === userId) || null;
  };
}

async function denied(options, expectedCategory = null) {
  let captured;
  await assert.rejects(
    requireWorkspaceManagementAccess({ now: NOW, ...options }),
    error => {
      captured = error;
      assert.equal(error.name, "WorkspaceManagementAuthorizationError");
      assert.equal(error.code, "WORKSPACE_MANAGEMENT_ACCESS_DENIED");
      assert.equal(error.message, "Workspace management access denied.");
      if (expectedCategory) assert.equal(error.category, expectedCategory);
      return true;
    }
  );
  return captured;
}

async function check(name, fn, category = "baseline") {
  await fn();
  passed += 1;
  categoryCounts[category] = Number(categoryCounts[category] || 0) + 1;
  if (category !== "baseline") identityPolicyChecks += 1;
  console.log(`ok ${passed} - ${name}`);
}

await check("unauthenticated requests are denied", async () => {
  await denied({ session: null, lookupMembership: membershipLookup([]) }, "unauthenticated");
});

await check("invalid, revoked, and expired sessions are denied", async () => {
  await denied({ session: session({ deviceUserId: SECOND_USER }), lookupMembership: membershipLookup([membership("owner")]) }, "invalid_session");
  await denied({ session: session({ revokedAt: "2026-08-02T20:00:00.000Z" }), lookupMembership: membershipLookup([membership("owner")]) }, "invalid_session");
  await denied({ session: session({ expiresAt: "2026-08-02T20:59:59.000Z" }), lookupMembership: membershipLookup([membership("owner")]) }, "invalid_session");
});

await check("a missing active workspace is denied", async () => {
  await denied({ session: session({ workspaceId: "" }), lookupMembership: membershipLookup([]) }, "missing_active_workspace");
});

await check("an active workspace owner is allowed", async () => {
  const access = await requireWorkspaceManagementAccess({ session: session(), lookupMembership: membershipLookup([membership("owner")]), now: NOW });
  assert.deepEqual(access, { userId: USER, workspaceId: WORKSPACE_A, role: "owner" });
});

await check("an active workspace administrator is allowed", async () => {
  const access = await requireWorkspaceManagementAccess({ session: session(), lookupMembership: membershipLookup([membership("admin")]), now: NOW });
  assert.deepEqual(access, { userId: USER, workspaceId: WORKSPACE_A, role: "admin" });
});

await check("an ordinary workspace member is denied management", async () => {
  await denied({ session: session(), lookupMembership: membershipLookup([membership("member")]) }, "insufficient_workspace_role");
});

await check("a removed membership is denied under the row-existence status model", async () => {
  const rows = [membership("owner")];
  rows.splice(0, 1);
  await denied({ session: session(), lookupMembership: membershipLookup(rows) }, "missing_membership");
});

await check("a user with no membership row is denied", async () => {
  await denied({ session: session(), lookupMembership: membershipLookup([]) }, "missing_membership");
});

await check("a global product owner role cannot replace workspace membership", async () => {
  await denied({ session: session({ globalRole: "Owner" }), lookupMembership: membershipLookup([]) }, "missing_membership");
});

await check("raw user metadata cannot grant workspace management", async () => {
  await denied({ session: session({ rawUserMetaData: { role: "owner", is_admin: true } }), lookupMembership: membershipLookup([]) }, "missing_membership");
});

await check("an owner of Workspace A cannot manage Workspace B", async () => {
  const calls = [];
  await denied({ session: session({ workspaceId: WORKSPACE_B }), lookupMembership: membershipLookup([membership("owner", WORKSPACE_A)], calls) }, "missing_membership");
  assert.deepEqual(calls, [{ workspaceId: WORKSPACE_B, userId: USER }]);
});

await check("an administrator of Workspace A cannot manage Workspace B", async () => {
  await denied({ session: session({ workspaceId: WORKSPACE_B }), lookupMembership: membershipLookup([membership("admin", WORKSPACE_A)]) }, "missing_membership");
});

await check("memberships in multiple workspaces do not combine authority", async () => {
  const rows = [membership("owner", WORKSPACE_A), membership("member", WORKSPACE_B)];
  await denied({ session: session({ workspaceId: WORKSPACE_B }), lookupMembership: membershipLookup(rows) }, "insufficient_workspace_role");
});

await check("the trusted device workspace controls authorization", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: session({ workspaceId: WORKSPACE_A, userWorkspaceId: WORKSPACE_B, globalRole: "Owner" }),
    lookupMembership: membershipLookup([membership("owner", WORKSPACE_A)]),
    now: NOW
  });
  assert.equal(access.workspaceId, WORKSPACE_A);
});

await check("a browser workspace ID cannot override the active session", async () => {
  const calls = [];
  await denied({
    session: session(),
    requestedWorkspaceId: WORKSPACE_B,
    lookupMembership: membershipLookup([membership("owner")], calls)
  }, "workspace_context_mismatch");
  assert.equal(calls.length, 0, "workspace mismatch must fail before membership lookup");
});

await check("guessed and known foreign workspace IDs return the same denial", async () => {
  const known = await denied({ session: session(), requestedWorkspaceId: WORKSPACE_B, lookupMembership: membershipLookup([membership("owner")]) });
  const guessed = await denied({ session: session(), requestedWorkspaceId: WORKSPACE_C, lookupMembership: membershipLookup([membership("owner")]) });
  assert.equal(known.code, guessed.code);
  assert.equal(known.message, guessed.message);
  assert.equal(known.status, guessed.status);
});

await check("object and connected-account identifiers cannot establish authority", async () => {
  await denied({
    session: session(),
    resourceWorkspaceId: WORKSPACE_B,
    connectedAccountId: "provider-account-one",
    lookupMembership: membershipLookup([membership("owner")])
  }, "workspace_context_mismatch");
  await denied({
    session: session(),
    connectedAccountId: "provider-account-one",
    lookupMembership: membershipLookup([])
  }, "missing_membership");
});

await check("legitimate owner and admin context remains minimal and immutable", async () => {
  for (const role of ["owner", "admin"]) {
    const access = await requireWorkspaceManagementAccess({ session: session(), lookupMembership: membershipLookup([membership(role)]), now: NOW });
    assert.deepEqual(Object.keys(access).sort(), ["role", "userId", "workspaceId"]);
    assert.equal(Object.isFrozen(access), true);
  }
});

await check("member-management routes preserve their intended response contracts", async () => {
  for (const route of ["/api/workspace/members", "/api/workspace/invites", "/api/workspace/invites/revoke"]) {
    assert.ok(serverSource.includes(`url.pathname === "${route}"`), `${route} is missing`);
  }
  assert.ok(serverSource.includes("Sign in before reading workspace members."));
  assert.ok(serverSource.includes("Only a workspace owner or admin can invite members."));
  assert.ok(serverSource.includes("Only a workspace owner or admin can revoke invitations."));
  assert.match(serverSource, /const workspaceId = managementAccess\.workspaceId;/u);
  assert.match(serverSource, /const ownerUserId = managementAccess\.userId;/u);
});

await check("unrelated authentication and entitlement decisions stay outside workspace authorization", async () => {
  assert.ok(serverSource.includes("function resolvedAppUserRole"));
  assert.doesNotMatch(authorizationSource, /resolvedAppUserRole|entitlement|raw_user_meta_data|user_metadata|signup|email|subscription|billing/iu);
  assert.doesNotMatch(authorizationSource, /process\.env|\bfetch\b|console\./u);
  assert.doesNotMatch(authorizationSource, /server\.mjs/u);
  assert.doesNotMatch(testSource, /(?:from\s+["'][^"']*server\.mjs["']|import\s*\(\s*["'][^"']*server\.mjs["'])/u);
});

await check("database lookup failures fail closed", async () => {
  await denied({
    session: session(),
    lookupMembership: async () => { throw new Error("database unavailable with internal details"); }
  }, "membership_lookup_failed");
});

await check("denial errors and audits omit sensitive session details", async () => {
  const audits = [];
  const sensitiveSession = session({ token: "top-secret-token", rawUserMetaData: { cookie: "secret-cookie" } });
  sensitiveSession.cookie = "secret-cookie";
  const error = await denied({
    session: sensitiveSession,
    requestedWorkspaceId: WORKSPACE_B,
    lookupMembership: membershipLookup([membership("owner")]),
    auditDenied: async entry => audits.push(entry),
    action: "workspace.invites.create"
  }, "workspace_context_mismatch");
  assert.equal(audits.length, 1);
  assert.deepEqual(Object.keys(audits[0]).sort(), ["action", "at", "category", "userId", "workspaceId"]);
  const serialized = JSON.stringify({ error: { code: error.code, message: error.message }, audit: audits[0] });
  for (const forbidden of ["top-secret-token", "secret-cookie", WORKSPACE_B, "raw_user_meta_data"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

await check("malformed workspace identifiers fail before database access", async () => {
  const calls = [];
  await denied({ session: session(), requestedWorkspaceId: "not-a-workspace-id", lookupMembership: membershipLookup([membership("owner")], calls) }, "workspace_context_mismatch");
  assert.equal(calls.length, 0);
});

await check("a missing identity policy preserves the hosted UUID default", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: session(),
    lookupMembership: membershipLookup([membership("owner")]),
    now: NOW
  });
  assert.deepEqual(access, { userId: USER, workspaceId: WORKSPACE_A, role: "owner" });
}, "policy-selection");

await check("the explicit hosted UUID policy is accepted", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([membership("owner")]),
    now: NOW
  });
  assert.deepEqual(access, { userId: USER, workspaceId: WORKSPACE_A, role: "owner" });
}, "policy-selection");

await check("the explicit local canonical policy is accepted", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: localSession(),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel()),
    now: NOW
  });
  assert.deepEqual(access, { userId: LOCAL_USER, workspaceId: LOCAL_WORKSPACE, role: "owner" });
}, "policy-selection");

await check("an unknown identity policy fails before membership resolution", async () => {
  const calls = [];
  await denied({
    session: localSession(),
    identityPolicy: "local_or_hosted",
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "invalid_identity_policy");
  assert.equal(calls.length, 0);
}, "policy-selection");

await check("a request-body identity policy cannot select local identities", async () => {
  const calls = [];
  await denied({
    session: localSession(),
    body: { identityPolicy: "local_canonical" },
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "unauthenticated");
  assert.equal(calls.length, 0);
}, "policy-selection");

await check("identity syntax never auto-selects a policy", async () => {
  const calls = [];
  await denied({
    session: localSession(),
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "unauthenticated");
  assert.equal(calls.length, 0);
}, "policy-selection");

await check("hosted owner behavior remains available under an explicit policy", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([membership("owner")]),
    now: NOW
  });
  assert.equal(access.role, "owner");
}, "hosted-preservation");

await check("hosted admin behavior remains available under an explicit policy", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([membership("admin")]),
    now: NOW
  });
  assert.equal(access.role, "admin");
}, "hosted-preservation");

await check("hosted members remain denied", async () => {
  await denied({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([membership("member")])
  }, "insufficient_workspace_role");
}, "hosted-preservation");

await check("an explicitly inactive hosted membership is denied", async () => {
  await denied({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([{ ...membership("owner"), status: "inactive" }])
  }, "missing_membership");
}, "hosted-preservation");

await check("a hosted membership without a status preserves row-existence behavior", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([membership("owner")]),
    now: NOW
  });
  assert.equal(access.role, "owner");
}, "hosted-preservation");

await check("a malformed hosted user UUID is rejected before lookup", async () => {
  const calls = [];
  await denied({
    session: session({ userId: "11111111-1111-6111-8111-111111111111" }),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([], calls)
  }, "unauthenticated");
  assert.equal(calls.length, 0);
}, "hosted-preservation");

await check("a malformed hosted workspace UUID is rejected before lookup", async () => {
  const calls = [];
  await denied({
    session: session({ workspaceId: "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa" }),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([], calls)
  }, "missing_active_workspace");
  assert.equal(calls.length, 0);
}, "hosted-preservation");

await check("a local canonical user ID is rejected in hosted mode", async () => {
  const calls = [];
  await denied({
    session: localSession(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([], calls)
  }, "unauthenticated");
  assert.equal(calls.length, 0);
}, "hosted-preservation");

await check("a local canonical workspace ID is rejected in hosted mode", async () => {
  const calls = [];
  const mixed = session();
  mixed.device.workspaceId = LOCAL_WORKSPACE;
  await denied({
    session: mixed,
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([], calls)
  }, "missing_active_workspace");
  assert.equal(calls.length, 0);
}, "hosted-preservation");

await check("the hosted callback still receives only normalized workspace and user IDs", async () => {
  const calls = [];
  const access = await requireWorkspaceManagementAccess({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([membership("owner")], calls),
    now: NOW
  });
  assert.deepEqual(calls, [{ workspaceId: WORKSPACE_A, userId: USER }]);
  assert.deepEqual(access, { userId: USER, workspaceId: WORKSPACE_A, role: "owner" });
}, "hosted-preservation");

for (const userId of ["usr", "user-owner-a", "User.Owner:01", "9_local-id", "local:user.name-1"]) {
  await check(`OI1-valid local user ID ${userId} is accepted`, async () => {
    const model = localCanonicalModel({ userId });
    const access = await requireWorkspaceManagementAccess({
      session: localSession({ userId }),
      identityPolicy: "local_canonical",
      lookupMembership: localLookup(model),
      now: NOW
    });
    assert.equal(access.userId, userId);
  }, "local-syntax");
}

for (const workspaceId of ["wrk", "workspace-owner-a", "Workspace.Owner:01", "9_local-id", "local:workspace.name-1"]) {
  await check(`OI1-valid local workspace ID ${workspaceId} is accepted`, async () => {
    const model = localCanonicalModel({ workspaceId });
    const access = await requireWorkspaceManagementAccess({
      session: localSession({ workspaceId }),
      identityPolicy: "local_canonical",
      lookupMembership: localLookup(model),
      now: NOW
    });
    assert.equal(access.workspaceId, workspaceId);
  }, "local-syntax");
}

await check("OI1-compatible surrounding whitespace is normalized without changing internal identity", async () => {
  const access = await requireWorkspaceManagementAccess({
    session: localSession({ userId: ` ${LOCAL_USER} `, workspaceId: ` ${LOCAL_WORKSPACE} ` }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel()),
    now: NOW
  });
  assert.equal(access.userId, LOCAL_USER);
  assert.equal(access.workspaceId, LOCAL_WORKSPACE);
}, "local-syntax");

for (const invalidUserId of ["", "a", "ab", "local owner", "owner@example.test", "user/owner", "-owner", "x".repeat(129)]) {
  await check(`OI1-invalid local user ID ${JSON.stringify(invalidUserId)} is denied`, async () => {
    const calls = [];
    await denied({
      session: localSession({ userId: invalidUserId }),
      identityPolicy: "local_canonical",
      lookupMembership: localLookup(localCanonicalModel(), calls)
    }, "unauthenticated");
    assert.equal(calls.length, 0);
  }, "local-syntax");
}

for (const invalidWorkspaceId of ["", "a", "ab", "Local Workspace", "workspace@example.test", "workspace/owner", "-workspace", "x".repeat(129)]) {
  await check(`OI1-invalid local workspace ID ${JSON.stringify(invalidWorkspaceId)} is denied`, async () => {
    const calls = [];
    await denied({
      session: localSession({ workspaceId: invalidWorkspaceId }),
      identityPolicy: "local_canonical",
      lookupMembership: localLookup(localCanonicalModel(), calls)
    }, "missing_active_workspace");
    assert.equal(calls.length, 0);
  }, "local-syntax");
}

await check("a partial local user identity is denied", async () => {
  await denied({
    session: localSession({ userId: "user-owner" }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "local-syntax");

await check("a case-variant local identity is denied", async () => {
  await denied({
    session: localSession({ userId: LOCAL_USER.toUpperCase() }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "local-syntax");

await check("UUID text follows local policy only when OI1 accepts the exact canonical state", async () => {
  const model = localCanonicalModel({ userId: USER, workspaceId: WORKSPACE_A });
  assert.deepEqual(validateLocalOwnershipState({ model, activeWorkspaceId: WORKSPACE_A, authenticatedUserId: USER }), {
    id: WORKSPACE_A,
    ownerUserId: USER,
    createdAt: LOCAL_CREATED
  });
  const access = await requireWorkspaceManagementAccess({
    session: localSession({ userId: USER, workspaceId: WORKSPACE_A }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(model),
    now: NOW
  });
  assert.equal(access.userId, USER);
}, "local-syntax");

await check("a mixed local user and hosted workspace cannot escape canonical ownership", async () => {
  await denied({
    session: localSession({ workspaceId: WORKSPACE_A }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "local-syntax");

await check("a hosted user and local workspace remain invalid under hosted policy", async () => {
  const mixed = session();
  mixed.device.workspaceId = LOCAL_WORKSPACE;
  await denied({
    session: mixed,
    identityPolicy: "hosted_uuid",
    lookupMembership: membershipLookup([])
  }, "missing_active_workspace");
}, "local-syntax");

await check("a local authenticated user must exactly match the device user", async () => {
  const calls = [];
  await denied({
    session: localSession({ deviceUserId: LOCAL_SECOND_USER }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "invalid_session");
  assert.equal(calls.length, 0);
}, "device-binding");

await check("a malformed local device user fails before membership lookup", async () => {
  const calls = [];
  await denied({
    session: localSession({ deviceUserId: "invalid device" }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "invalid_session");
  assert.equal(calls.length, 0);
}, "device-binding");

await check("a local requested workspace must match the trusted device workspace", async () => {
  const calls = [];
  await denied({
    session: localSession(),
    identityPolicy: "local_canonical",
    requestedWorkspaceId: LOCAL_SECOND_WORKSPACE,
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "workspace_context_mismatch");
  assert.equal(calls.length, 0);
}, "device-binding");

await check("a local resource workspace must match the trusted device workspace", async () => {
  const calls = [];
  await denied({
    session: localSession(),
    identityPolicy: "local_canonical",
    resourceWorkspaceId: LOCAL_SECOND_WORKSPACE,
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "workspace_context_mismatch");
  assert.equal(calls.length, 0);
}, "device-binding");

await check("a malformed requested local workspace fails before membership lookup", async () => {
  const calls = [];
  await denied({
    session: localSession(),
    identityPolicy: "local_canonical",
    requestedWorkspaceId: "foreign workspace",
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "workspace_context_mismatch");
  assert.equal(calls.length, 0);
}, "device-binding");

await check("a foreign local device workspace cannot resolve the active owner", async () => {
  await denied({
    session: localSession({ workspaceId: LOCAL_SECOND_WORKSPACE }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "device-binding");

await check("membership lookup is reached only after local device binding passes", async () => {
  const calls = [];
  const access = await requireWorkspaceManagementAccess({
    session: localSession(),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel(), calls),
    now: NOW
  });
  assert.deepEqual(calls, [{ workspaceId: LOCAL_WORKSPACE, userId: LOCAL_USER }]);
  assert.equal(access.role, "owner");
}, "device-binding");

await check("a local membership user must exactly match the authenticated user", async () => {
  await denied({
    session: localSession(),
    identityPolicy: "local_canonical",
    lookupMembership: async () => localMembership("owner", LOCAL_WORKSPACE, LOCAL_SECOND_USER)
  }, "missing_membership");
}, "device-binding");

await check("a local membership workspace must exactly match the active workspace", async () => {
  await denied({
    session: localSession(),
    identityPolicy: "local_canonical",
    lookupMembership: async () => localMembership("owner", LOCAL_SECOND_WORKSPACE, LOCAL_USER)
  }, "missing_membership");
}, "device-binding");

await check("a local membership must be explicitly active", async () => {
  await denied({
    session: localSession(),
    identityPolicy: "local_canonical",
    lookupMembership: async () => localMembership("owner", LOCAL_WORKSPACE, LOCAL_USER, "")
  }, "missing_membership");
  await denied({
    session: localSession(),
    identityPolicy: "local_canonical",
    lookupMembership: async () => localMembership("owner", LOCAL_WORKSPACE, LOCAL_USER, "inactive")
  }, "missing_membership");
}, "device-binding");

await check("the pure resolver returns one exact active owner membership", async () => {
  const result = resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: localCanonicalModel()
  });
  assert.deepEqual(result, {
    workspace_id: LOCAL_WORKSPACE,
    user_id: LOCAL_USER,
    role: "owner",
    status: "active"
  });
}, "local-resolver");

await check("the pure resolver output is frozen and field-allowlisted", async () => {
  const result = resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: localCanonicalModel()
  });
  assert.deepEqual(Object.keys(result).sort(), ["role", "status", "user_id", "workspace_id"]);
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.role = "admin"; }, TypeError);
}, "local-resolver");

await check("the pure resolver leaves canonical inputs unchanged", async () => {
  const model = localCanonicalModel();
  const before = JSON.stringify(model);
  resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: model
  });
  assert.equal(JSON.stringify(model), before);
}, "local-resolver");

await check("the pure resolver requires explicit local mode", async () => {
  assert.equal(resolveLocalWorkspaceManagementMembership({
    localMode: false,
    authenticatedUserId: LOCAL_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: localCanonicalModel()
  }), null);
}, "local-resolver");

await check("the pure resolver denies a wrong authenticated user", async () => {
  assert.equal(resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_SECOND_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: localCanonicalModel()
  }), null);
}, "local-resolver");

await check("a missing canonical model is denied", async () => {
  assert.equal(resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: null
  }), null);
}, "canonical-state");

await check("a missing top-level active workspace is denied", async () => {
  const model = localCanonicalModel();
  delete model.workspace;
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

await check("a missing matching collection workspace is denied", async () => {
  const model = localCanonicalModel();
  model.workspaces = model.workspaces.filter(workspace => workspace.id !== LOCAL_WORKSPACE);
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

await check("a duplicate matching collection workspace is denied", async () => {
  const model = localCanonicalModel();
  model.workspaces.push(clone(model.workspace));
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

await check("a top-level and collection workspace ID conflict is denied", async () => {
  const model = localCanonicalModel();
  model.workspace.id = LOCAL_SECOND_WORKSPACE;
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

await check("a top-level and collection owner conflict is denied", async () => {
  const model = localCanonicalModel();
  model.workspace.ownerUserId = LOCAL_SECOND_USER;
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

await check("a protected creation-identity conflict is denied", async () => {
  const model = localCanonicalModel();
  model.workspace.createdAt = LOCAL_SECOND_CREATED;
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

await check("a malformed canonical workspace collection is denied", async () => {
  const model = localCanonicalModel();
  model.workspaces = "not-a-workspace-collection";
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

await check("a missing canonical owner is denied", async () => {
  const model = localCanonicalModel();
  delete model.workspace.ownerUserId;
  delete model.workspaces[0].ownerUserId;
  assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
}, "canonical-state");

for (const [label, workspaceExtra] of [
  ["active false", { active: false }],
  ["deleted flag", { deleted: true }],
  ["archived flag", { archived: true }],
  ["deleted timestamp", { deletedAt: LOCAL_CREATED }],
  ["archived timestamp", { archivedAt: LOCAL_CREATED }],
  ["inactive status", { status: "inactive" }],
  ["revoked status", { status: "revoked" }]
]) {
  await check(`canonical workspace ${label} is denied`, async () => {
    const model = localCanonicalModel({ workspaceExtra });
    assert.equal(resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: model }), null);
  }, "canonical-state");
}

await check("a session Owner role cannot grant local management to a non-owner", async () => {
  await denied({
    session: localSession({ userId: LOCAL_SECOND_USER, globalRole: "Owner" }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "hostile-authority");

await check("a session Admin role cannot grant local management to a non-owner", async () => {
  await denied({
    session: localSession({ userId: LOCAL_SECOND_USER, globalRole: "Admin" }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "hostile-authority");

await check("a matching owner email cannot grant management to a different user", async () => {
  await denied({
    session: localSession({ userId: LOCAL_SECOND_USER, email: "local-owner-a@example.test" }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "hostile-authority");

await check("a body owner ID cannot grant local management", async () => {
  await denied({
    session: localSession({ userId: LOCAL_SECOND_USER }),
    identityPolicy: "local_canonical",
    body: { ownerUserId: LOCAL_USER },
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "hostile-authority");

await check("a body user ID cannot grant local management", async () => {
  await denied({
    session: localSession({ userId: LOCAL_SECOND_USER }),
    identityPolicy: "local_canonical",
    body: { userId: LOCAL_USER },
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "hostile-authority");

await check("a body workspace ID cannot redirect local management", async () => {
  const calls = [];
  await denied({
    session: localSession({ userId: LOCAL_SECOND_USER }),
    identityPolicy: "local_canonical",
    body: { workspaceId: LOCAL_WORKSPACE },
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "missing_membership");
  assert.deepEqual(calls, [{ workspaceId: LOCAL_WORKSPACE, userId: LOCAL_SECOND_USER }]);
}, "hostile-authority");

await check("a query workspace ID cannot redirect local management", async () => {
  const calls = [];
  await denied({
    session: localSession({ userId: LOCAL_SECOND_USER }),
    identityPolicy: "local_canonical",
    query: { workspaceId: LOCAL_WORKSPACE },
    lookupMembership: localLookup(localCanonicalModel(), calls)
  }, "missing_membership");
  assert.deepEqual(calls, [{ workspaceId: LOCAL_WORKSPACE, userId: LOCAL_SECOND_USER }]);
}, "hostile-authority");

for (const [label, sessionValue] of [
  ["provider metadata", localSession({ userId: LOCAL_SECOND_USER, providerMetadata: { role: "owner", ownerUserId: LOCAL_USER } })],
  ["Stripe metadata", localSession({ userId: LOCAL_SECOND_USER, stripeMetadata: { role: "owner", workspaceId: LOCAL_WORKSPACE } })],
  ["profile metadata", localSession({ userId: LOCAL_SECOND_USER, profile: { role: "owner", ownerUserId: LOCAL_USER } })],
  ["raw user metadata", localSession({ userId: LOCAL_SECOND_USER, rawUserMetaData: { role: "owner", is_admin: true } })]
]) {
  await check(`${label} cannot grant local management`, async () => {
    await denied({
      session: sessionValue,
      identityPolicy: "local_canonical",
      lookupMembership: localLookup(localCanonicalModel())
    }, "missing_membership");
  }, "hostile-authority");
}

await check("display-name workspace matching cannot grant local management", async () => {
  const model = localCanonicalModel();
  model.workspace.name = "Workspace Owner A";
  await denied({
    session: localSession({ workspaceId: "Workspace-Owner-A" }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(model)
  }, "missing_membership");
}, "hostile-authority");

await check("fuzzy local identity matching cannot grant management", async () => {
  await denied({
    session: localSession({ userId: `${LOCAL_USER}-suffix` }),
    identityPolicy: "local_canonical",
    lookupMembership: localLookup(localCanonicalModel())
  }, "missing_membership");
}, "hostile-authority");

await check("the resolver never emits a local admin membership", async () => {
  const model = localCanonicalModel({ modelExtra: { role: "Admin", adminUserIds: [LOCAL_USER] } });
  const result = resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: model
  });
  assert.equal(result.role, "owner");
  assert.equal(JSON.stringify(result).includes("admin"), false);
}, "local-admin-unsupported");

await check("an injected local admin membership remains unsupported", async () => {
  await denied({
    session: localSession({ globalRole: "Admin" }),
    identityPolicy: "local_canonical",
    lookupMembership: async () => localMembership("admin")
  }, "insufficient_workspace_role");
}, "local-admin-unsupported");

await check("browser admin claims cannot alter canonical local resolution", async () => {
  const model = localCanonicalModel({ modelExtra: { browser: { role: "admin", ownerUserId: LOCAL_SECOND_USER } } });
  assert.equal(resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_SECOND_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: model
  }), null);
}, "local-admin-unsupported");

await check("email allowlist admin claims cannot alter canonical local resolution", async () => {
  const model = localCanonicalModel({ modelExtra: { adminEmails: ["local-owner-b@example.test"] } });
  assert.equal(resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_SECOND_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: model
  }), null);
}, "local-admin-unsupported");

await check("provider and profile admin claims cannot alter canonical local resolution", async () => {
  const model = localCanonicalModel({
    modelExtra: {
      profile: { role: "admin", ownerUserId: LOCAL_SECOND_USER },
      providerMetadata: { isAdmin: true, ownerUserId: LOCAL_SECOND_USER }
    }
  });
  assert.equal(resolveLocalWorkspaceManagementMembership({
    localMode: true,
    authenticatedUserId: LOCAL_SECOND_USER,
    activeWorkspaceId: LOCAL_WORKSPACE,
    canonicalModel: model
  }), null);
}, "local-admin-unsupported");

await check("hosted no-row denial has no local fallback", async () => {
  let localFallbackCalls = 0;
  await denied({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: async () => null,
    localResolver: () => { localFallbackCalls += 1; }
  }, "missing_membership");
  assert.equal(localFallbackCalls, 0);
}, "hosted-isolation");

await check("hosted inactive-row denial has no local fallback", async () => {
  let localFallbackCalls = 0;
  await denied({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: async () => ({ ...membership("owner"), status: "revoked" }),
    localResolver: () => { localFallbackCalls += 1; }
  }, "missing_membership");
  assert.equal(localFallbackCalls, 0);
}, "hosted-isolation");

await check("hosted query errors fail closed without local fallback", async () => {
  let localFallbackCalls = 0;
  await denied({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: async () => { throw new Error("hosted query failed"); },
    localResolver: () => { localFallbackCalls += 1; }
  }, "membership_lookup_failed");
  assert.equal(localFallbackCalls, 0);
}, "hosted-isolation");

await check("hosted timeout errors fail closed without local fallback", async () => {
  let localFallbackCalls = 0;
  await denied({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: async () => { throw new Error("hosted membership timeout"); },
    localResolver: () => { localFallbackCalls += 1; }
  }, "membership_lookup_failed");
  assert.equal(localFallbackCalls, 0);
}, "hosted-isolation");

await check("a malformed hosted membership fails without local fallback", async () => {
  let localFallbackCalls = 0;
  await denied({
    session: session(),
    identityPolicy: "hosted_uuid",
    lookupMembership: async () => ({ workspace_id: "malformed", user_id: USER, role: "owner" }),
    localResolver: () => { localFallbackCalls += 1; }
  }, "missing_membership");
  assert.equal(localFallbackCalls, 0);
}, "hosted-isolation");

function boundedFunctionSource(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.ok(start >= 0 && end > start, `bounded source missing for ${signature}`);
  return source.slice(start, end);
}

const serverAuthorizationWrapperSource = boundedFunctionSource(
  serverSource,
  "async function requireWorkspaceManagementAccess(session = null, options = {})",
  "async function workspaceMembershipView(session = null)"
);
const hostedMembershipQuery = "/workspace_members?workspace_id=eq.${encodeURIComponent(workspaceId)}&user_id=eq.${encodeURIComponent(userId)}&select=workspace_id,user_id,role,created_at,updated_at&limit=1";

await check("server imports the tracked pure local membership resolver", async () => {
  assert.ok(serverSource.includes('import { resolveLocalWorkspaceManagementMembership } from "./local-workspace-membership.mjs";'));
  assert.equal(typeof resolveLocalWorkspaceManagementMembership, "function");
}, "server-boundary");

await check("the local resolver imports only the OI1 ownership validator", async () => {
  assert.match(localMembershipSource, /^import \{ validateLocalOwnershipState \} from "\.\/local-workspace-ownership\.mjs";/u);
  assert.doesNotMatch(localMembershipSource, /process\.env|node:fs|node:http|node:https|\bfetch\b|server\.mjs|supabase|stripe|vizard/iu);
}, "server-boundary");

await check("server selects local identity policy only from trusted persistence mode", async () => {
  assert.ok(serverAuthorizationWrapperSource.includes('const localWorkspaceMembershipEnabled = runtimeMode === "local" && !supabaseEnabled;'));
  assert.ok(serverAuthorizationWrapperSource.includes('const identityPolicy = localWorkspaceMembershipEnabled ? "local_canonical" : "hosted_uuid";'));
  assert.ok(serverAuthorizationWrapperSource.includes("identityPolicy,"));
}, "server-boundary");

await check("browser-controlled data cannot select the identity policy", async () => {
  const selection = serverAuthorizationWrapperSource.slice(0, serverAuthorizationWrapperSource.indexOf("return authorizeWorkspaceManagement"));
  assert.doesNotMatch(selection, /\breq\b|\brequest\b|\bbody\b|\bquery\b|\bheaders\b|session\?\.|user\.|workspace\.|process\.env/iu);
  assert.doesNotMatch(authorizationSource, /body\??\.|query\??\.|headers\??\.|process\.env/iu);
}, "server-boundary");

await check("the local callback loads the canonical persisted model", async () => {
  assert.ok(serverAuthorizationWrapperSource.includes("let canonicalModel = await getModel();"));
  assert.ok(serverAuthorizationWrapperSource.includes("localWorkspacePersistence.view(canonicalModel, workspaceId)"));
  assert.ok(serverAuthorizationWrapperSource.includes("resolveLocalWorkspaceManagementMembership({"));
  assert.ok(serverAuthorizationWrapperSource.includes("authenticatedUserId: userId"));
  assert.ok(serverAuthorizationWrapperSource.includes("activeWorkspaceId: workspaceId"));
  assert.ok(serverAuthorizationWrapperSource.includes("canonicalModel"));
}, "server-boundary");

await check("the local callback input is bounded and excludes request authority", async () => {
  const resolverCall = serverAuthorizationWrapperSource.slice(
    serverAuthorizationWrapperSource.indexOf("return resolveLocalWorkspaceManagementMembership({"),
    serverAuthorizationWrapperSource.indexOf("});", serverAuthorizationWrapperSource.indexOf("return resolveLocalWorkspaceManagementMembership({")) + 3
  );
  assert.match(resolverCall, /localMode: true/u);
  assert.doesNotMatch(resolverCall, /req|request|body|query|header|email|role|provider|stripe/iu);
}, "server-boundary");

await check("hosted and local membership callbacks remain distinct", async () => {
  const hostedStart = serverAuthorizationWrapperSource.indexOf("if (supabaseEnabled) {");
  const localStart = serverAuthorizationWrapperSource.indexOf("if (!localWorkspaceMembershipEnabled) return null;");
  assert.ok(hostedStart >= 0 && localStart > hostedStart);
  assert.ok(serverAuthorizationWrapperSource.slice(hostedStart, localStart).includes(hostedMembershipQuery));
  assert.doesNotMatch(serverAuthorizationWrapperSource.slice(hostedStart, localStart), /resolveLocalWorkspaceManagementMembership/u);
}, "server-boundary");

await check("the exact hosted Supabase membership query remains unchanged", async () => {
  assert.ok(serverAuthorizationWrapperSource.includes(hostedMembershipQuery));
  assert.equal(serverAuthorizationWrapperSource.split(hostedMembershipQuery).length - 1, 1);
}, "server-boundary");

await check("workspace management authorization remains the common server gate", async () => {
  for (const route of [
    "/api/workspace/members",
    "/api/workspace/invites",
    "/api/workspace/invites/revoke",
    "/api/accounts/vizard/status",
    "/api/accounts/vizard/connect",
    "/api/accounts/vizard/replace",
    "/api/accounts/vizard/disconnect"
  ]) {
    assert.ok(serverSource.includes(route), `${route} is missing`);
  }
  assert.ok(serverSource.includes("managementAccess = await requireWorkspaceManagementAccess(session"));
}, "server-boundary");

await check("hosted-only membership views explicitly retain hosted UUID policy", async () => {
  const viewSource = boundedFunctionSource(
    serverSource,
    "async function workspaceMembershipView(session = null)",
    "async function recordAuthAlert"
  );
  assert.ok(viewSource.includes('identityPolicy: "hosted_uuid"'));
  assert.match(viewSource, /if \(!supabaseEnabled \|\| !isUuid\(userId\) \|\| !isUuid\(workspaceId\)/u);
}, "server-boundary");

await check("the pure local resolver exposes no secret-bearing fields", async () => {
  const result = resolveLocalWorkspaceManagementMembership({ localMode: true, authenticatedUserId: LOCAL_USER, activeWorkspaceId: LOCAL_WORKSPACE, canonicalModel: localCanonicalModel() });
  const serialized = JSON.stringify(result);
  for (const forbidden of ["email", "token", "secret", "password", "stripe", "provider", "model", "settings", "plan", "entitlement"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
}, "server-boundary");

function implementationViolations({
  authorization = authorizationSource,
  resolver = localMembershipSource,
  server = serverSource
} = {}) {
  const violations = [];
  const requiredAuthorizationFragments = [
    "const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;",
    "const localCanonicalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;",
    'const identityPolicies = new Set(["hosted_uuid", "local_canonical"]);',
    'identityPolicy = "hosted_uuid"',
    "identityPolicies.has(identityPolicy)",
    "deviceUserId !== userId",
    "candidate.value !== workspaceId",
    "membershipWorkspaceId !== workspaceId",
    "membershipUserId !== userId",
    'policy === "local_canonical" ? role === "owner" : managementRoles.has(role)'
  ];
  for (const fragment of requiredAuthorizationFragments) {
    if (!authorization.includes(fragment)) violations.push(`authorization:${fragment}`);
  }
  if (/session\?\.(?:body|query|headers)|user\?\.(?:email|role|profile|providerMetadata|stripeMetadata)/u.test(authorization)) {
    violations.push("authorization:untrusted-authority");
  }
  const requiredResolverFragments = [
    "validateLocalOwnershipState({",
    "matches.length !== 1",
    "identity.ownerUserId !== userId",
    'role: "owner"',
    'status: "active"'
  ];
  for (const fragment of requiredResolverFragments) {
    if (!resolver.includes(fragment)) violations.push(`resolver:${fragment}`);
  }
  if (!/return Object\.freeze\(\{\s*workspace_id: workspaceId,\s*user_id: userId,\s*role: "owner",\s*status: "active"\s*\}\);/u.test(resolver)) {
    violations.push("resolver:minimal-output");
  }
  if (/\b(?:email|providerMetadata|stripeMetadata|profile|roleClaim)\b/u.test(resolver)) violations.push("resolver:untrusted-authority");
  if (!server.includes('const localWorkspaceMembershipEnabled = runtimeMode === "local" && !supabaseEnabled;')) violations.push("server:local-mode-boundary");
  if (!server.includes('const identityPolicy = localWorkspaceMembershipEnabled ? "local_canonical" : "hosted_uuid";')) violations.push("server:policy-selection");
  if (!server.includes(hostedMembershipQuery)) violations.push("server:hosted-query");
  const serverWrapper = server.includes("async function workspaceMembershipView(session = null)")
    ? server.slice(server.indexOf("async function requireWorkspaceManagementAccess(session = null, options = {})"), server.indexOf("async function workspaceMembershipView(session = null)"))
    : server;
  const hostedBranch = serverWrapper.slice(serverWrapper.indexOf("if (supabaseEnabled) {"), serverWrapper.indexOf("if (!localWorkspaceMembershipEnabled) return null;"));
  if (hostedBranch.includes("resolveLocalWorkspaceManagementMembership") || /catch\s*\(/u.test(hostedBranch)) violations.push("server:hosted-local-fallback");
  return violations;
}

assert.deepEqual(implementationViolations(), []);

function mutateServerAuthorizationWrapper(source, find, replacement) {
  const start = source.indexOf("async function requireWorkspaceManagementAccess(session = null, options = {})");
  const end = source.indexOf("async function workspaceMembershipView(session = null)", start);
  const wrapper = source.slice(start, end);
  const mutatedWrapper = wrapper.replace(find, replacement);
  assert.notEqual(mutatedWrapper, wrapper, "server authorization wrapper mutation did not apply");
  return source.slice(0, start) + mutatedWrapper + source.slice(end);
}

const hostileMutations = [
  ["hosted UUID validation removed", "authorization", source => source.replace("const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;", "const uuidPattern = /.+/u;")],
  ["local validation accepts every nonempty string", "authorization", source => source.replace("const localCanonicalPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;", "const localCanonicalPattern = /.+/u;")],
  ["policy inferred from ID shape", "authorization", source => source.replace("identityPolicies.has(identityPolicy)", 'identityPolicy === "local_canonical" || String(session?.user?.id || "").startsWith("user-")')],
  ["policy taken from request body", "authorization", source => source.replace("const policy = identityPolicies.has(identityPolicy) ? identityPolicy : \"\";", "const policy = session?.body?.identityPolicy || identityPolicy;")],
  ["device-user equality skipped", "authorization", source => source.replace("deviceUserId !== userId", "false")],
  ["requested workspace equality skipped", "authorization", source => source.replace("candidate.value !== workspaceId", "false")],
  ["membership workspace equality skipped", "authorization", source => source.replace("membershipWorkspaceId !== workspaceId", "false")],
  ["membership user equality skipped", "authorization", source => source.replace("membershipUserId !== userId", "false")],
  ["session role grants authority", "authorization", source => source.replace("const managementRole =", "const injected = session?.user?.role;\n  const managementRole = injected ||")],
  ["email grants authority", "authorization", source => source.replace("const managementRole =", "const injected = session?.user?.email;\n  const managementRole = injected ||")],
  ["provider metadata grants authority", "authorization", source => source.replace("const managementRole =", "const injected = session?.user?.providerMetadata;\n  const managementRole = injected ||")],
  ["Stripe metadata grants authority", "authorization", source => source.replace("const managementRole =", "const injected = session?.user?.stripeMetadata;\n  const managementRole = injected ||")],
  ["local admin accepted", "authorization", source => source.replace('policy === "local_canonical" ? role === "owner" : managementRoles.has(role)', 'policy === "local_canonical" ? managementRoles.has(role) : managementRoles.has(role)')],
  ["OI1 canonical validation skipped", "resolver", source => source.replace("validateLocalOwnershipState({", "(() => ({ id: workspaceId, ownerUserId: userId, createdAt: topLevel?.createdAt }))({")],
  ["duplicate workspace entries accepted", "resolver", source => source.replace("matches.length !== 1", "matches.length < 1")],
  ["resolver returns extra model fields", "resolver", source => source.replace('status: "active"', 'status: "active",\n      model: canonicalModel')],
  ["local-mode boundary removed", "server", source => source.replace('const localWorkspaceMembershipEnabled = runtimeMode === "local" && !supabaseEnabled;', "const localWorkspaceMembershipEnabled = !supabaseEnabled;")],
  ["hosted no-row falls back locally", "server", source => mutateServerAuthorizationWrapper(source, "return Array.isArray(rows) ? rows[0] || null : null;", "return (Array.isArray(rows) ? rows[0] || null : null) || resolveLocalWorkspaceManagementMembership({});")],
  ["hosted query error falls back locally", "server", source => mutateServerAuthorizationWrapper(source, "return Array.isArray(rows) ? rows[0] || null : null;", "return Array.isArray(rows) ? rows[0] || null : resolveLocalWorkspaceManagementMembership({});")]
];

for (const [label, target, mutate] of hostileMutations) {
  await check(`hostile mutation rejected: ${label}`, async () => {
    const sources = { authorization: authorizationSource, resolver: localMembershipSource, server: serverSource };
    const mutated = mutate(sources[target]);
    assert.notEqual(mutated, sources[target], `${label} mutation did not apply`);
    const candidate = { ...sources, [target]: mutated };
    assert.ok(implementationViolations(candidate).length > 0, `${label} escaped the executable contract`);
    hostileMutationCount += 1;
  }, "hostile-mutation");
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const sensitiveEnvironmentPrefixes = /^(?:META|FACEBOOK|INSTAGRAM|THREADS|X_|TWITTER|TIKTOK|PINTEREST|CANVA|SHOPIFY|ETSY|LINKEDIN|PATREON|TWITCH|GOOGLE|YOUTUBE|DISCORD|MANYCHAT|ELEVENLABS|REDDIT|OPENAI|STRIPE|SUPABASE|SENTRY|VERCEL|VAPID|RESEND|VIZARD)_/iu;

function hermeticEnvironment(overrides = {}) {
  const env = { ...process.env };
  const exactSensitiveNames = new Set([
    "VERCEL",
    "AUTH_PROVIDER",
    "AUTH_SESSION_SECRET",
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    "SOCIAL_CUES_PROMO_CODES",
    "SOCIAL_CUES_DATA_DIR",
    "SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG"
  ]);
  for (const name of Object.keys(env)) {
    if (sensitiveEnvironmentPrefixes.test(name) || exactSensitiveNames.has(name.toUpperCase())) delete env[name];
  }
  return { ...env, ...overrides };
}

async function writeExternalGuard(filePath) {
  await writeFile(filePath, `
import { appendFile } from "node:fs/promises";
const originalFetch = globalThis.fetch;
const logPath = process.env.SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG || "";
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
globalThis.fetch = async (input, init = {}) => {
  const rawUrl = input instanceof URL || typeof input === "string" ? String(input) : String(input?.url || "");
  const target = new URL(rawUrl);
  if (["http:", "https:"].includes(target.protocol) && !loopbackHosts.has(target.hostname)) {
    if (logPath) {
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      await appendFile(logPath, JSON.stringify({ method, origin: target.origin }) + "\\n", "utf8");
    }
    throw new Error("External HTTP request blocked by the workspace authorization contract.");
  }
  return originalFetch(input, init);
};
`, "utf8");
}

async function waitForContractServer(child, baseUrl, output) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`workspace authorization test server exited before startup: ${output()}`);
    try {
      const response = await originalFetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The loopback server may still be binding.
    }
    await delay(50);
  }
  throw new Error(`workspace authorization test server did not start: ${output()}`);
}

async function stopContractServer(child) {
  if (child.exitCode !== null) return;
  let exited = new Promise(resolve => child.once("exit", resolve));
  if (child.connected) child.send({ type: "social-cues-local-shutdown" }); else child.kill("SIGTERM");
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await Promise.race([exited, delay(2000)]);
  }
}

async function contractResponse(baseUrl, route, options = {}) {
  const response = await originalFetch(baseUrl + route, { redirect: "manual", ...options });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // The selected management route returns JSON; retain text for bounded diagnostics.
  }
  return { status: response.status, body, text };
}

async function modelSnapshot(dataDir) {
  const raw = await readFile(path.join(dataDir, "model.json"), "utf8");
  return { hash: sha256(raw), model: fixtureModel(JSON.parse(raw)) };
}

async function externalAttempts(logPath) {
  try {
    return (await readFile(logPath, "utf8")).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const httpResults = [];
const httpDataDir = path.join(process.cwd(), ".tmp", `workspace-authorization-contract-${Date.now()}`);
const httpExternalLog = path.join(httpDataDir, "external-requests.ndjson");
const httpGuardPath = path.join(httpDataDir, "external-request-guard.mjs");
await mkdir(httpDataDir, { recursive: true });
await writeExternalGuard(httpGuardPath);
const httpPort = await availablePort();
const httpBase = `http://127.0.0.1:${httpPort}`;
const HTTP_PASSWORD_A = "lm1-owner-a-password-2026";
const HTTP_PASSWORD_B = "lm1-owner-b-password-2026";
const HTTP_SESSION_SECRET = "lm1-synthetic-session-secret-2026-not-production";
const HTTP_ENCRYPTION_KEY = "lm1-synthetic-encryption-key-2026-not-production";
const httpChildEnvironment = hermeticEnvironment({
  PORT: String(httpPort),
  HOST: "127.0.0.1",
  AUTH_PROVIDER: "alpha-local",
  AUTH_SESSION_SECRET: HTTP_SESSION_SECRET,
  SUPABASE_ENABLED: "false",
  SENTRY_DSN: "",
  PUBLIC_APP_URL: "https://socialcuesapp.com",
  SOCIAL_CUES_DATA_DIR: httpDataDir,
  SOCIAL_CUES_TEST_EXTERNAL_REQUEST_LOG: httpExternalLog,
  OAUTH_TOKEN_ENCRYPTION_KEY: HTTP_ENCRYPTION_KEY
});
let httpStdout = "";
let httpStderr = "";
const httpChild = spawn(process.execPath, [`--import=${pathToFileURL(httpGuardPath).href}`, "server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: httpChildEnvironment,
  stdio: ["ignore", "pipe", "pipe", "ipc"]
});
httpChild.stdout.on("data", chunk => { httpStdout += chunk; });
httpChild.stderr.on("data", chunk => { httpStderr += chunk; });

try {
  await waitForContractServer(httpChild, httpBase, () => `${httpStdout}\n${httpStderr}`);
  const signupA = await contractResponse(httpBase, "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "LM1 Local Owner A",
      email: "barton.cory.m+lm1-owner-a@gmail.com",
      password: HTTP_PASSWORD_A,
      workspaceName: "LM1 Local Workspace A"
    })
  });
  assert.equal(signupA.status, 200);
  assert.ok(signupA.body?.session?.token);
  assert.equal(signupA.body?.workspace?.ownerUserId, signupA.body?.user?.id);
  const tokenA = signupA.body.session.token;
  const userA = signupA.body.user.id;
  const workspaceA = signupA.body.workspace.id;
  const authA = { Authorization: `Bearer ${tokenA}` };

  let before = await modelSnapshot(httpDataDir);
  const anonymousStatus = await contractResponse(httpBase, "/api/accounts/vizard/status");
  let after = await modelSnapshot(httpDataDir);
  await check("anonymous management status remains a bounded 401", async () => {
    assert.equal(anonymousStatus.status, 401);
    assert.equal(anonymousStatus.body?.code, "not_authenticated");
    assert.equal(after.hash, before.hash);
  }, "http-management");
  httpProbeCount += 1;
  httpResults.push({ identity: "anonymous", status: anonymousStatus.status, code: anonymousStatus.body?.code, authorization: "pre-session denial", postAuthorization: false, persistenceMutations: 0 });

  before = after;
  const ownerStatus = await contractResponse(httpBase, "/api/accounts/vizard/status", { headers: authA });
  after = await modelSnapshot(httpDataDir);
  await check("the exact canonical owner reaches bounded post-authorization Vizard validation", async () => {
    assert.equal(ownerStatus.status, 400);
    assert.equal(ownerStatus.body?.code, "invalid_request");
    assert.notEqual(ownerStatus.status, 403);
    assert.equal(after.hash, before.hash);
  }, "http-management");
  httpProbeCount += 1;
  httpResults.push({ identity: "canonical-owner", status: ownerStatus.status, code: ownerStatus.body?.code, authorization: "allowed", postAuthorization: true, persistenceMutations: 0 });

  const signupB = await contractResponse(httpBase, "/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "LM1 Local Owner B",
      email: "barton.cory.m+lm1-owner-b@gmail.com",
      password: HTTP_PASSWORD_B,
      workspaceName: "LM1 Local Workspace B"
    })
  });
  assert.equal(signupB.status, 200);
  assert.ok(signupB.body?.session?.token);
  const tokenB = signupB.body.session.token;
  const userB = signupB.body.user.id;
  const workspaceB = signupB.body.workspace.id;
  const authB = { Authorization: `Bearer ${tokenB}` };

  const fixture = await modelSnapshot(httpDataDir);
  const canonicalWorkspaceA = fixture.model.workspaces.find(workspace => workspace.id === workspaceA);
  assert.ok(canonicalWorkspaceA);
  fixture.model.workspace = clone(canonicalWorkspaceA);
  const deviceB = fixture.model.deviceSessions.find(device => device.userId === userB && !device.revokedAt);
  assert.ok(deviceB);
  deviceB.workspaceId = workspaceA;
  await injectSharedFixture(httpDataDir, fixture.model);

  before = await modelSnapshot(httpDataDir);
  const nonOwnerStatus = await contractResponse(httpBase, "/api/accounts/vizard/status", { headers: authB });
  after = await modelSnapshot(httpDataDir);
  await check("an authenticated local non-owner receives the management 403", async () => {
    assert.equal(nonOwnerStatus.status, 403);
    assert.equal(nonOwnerStatus.body?.code, "not_authorized");
    assert.equal(after.hash, before.hash);
  }, "http-management");
  httpProbeCount += 1;
  httpResults.push({ identity: "authenticated-non-owner", status: nonOwnerStatus.status, code: nonOwnerStatus.body?.code, authorization: "membership denied", postAuthorization: false, persistenceMutations: 0 });

  const adminFixture = after.model;
  const storedUserB = adminFixture.authUsers.find(user => user.id === userB);
  assert.ok(storedUserB);
  storedUserB.role = "Admin";
  storedUserB.admin = true;
  storedUserB.profile = { role: "admin", ownerUserId: userA };
  storedUserB.providerMetadata = { role: "owner", ownerUserId: userA };
  storedUserB.stripeMetadata = { role: "owner", workspaceId: workspaceA };
  await injectSharedFixture(httpDataDir, adminFixture);

  before = await modelSnapshot(httpDataDir);
  const adminClaimStatus = await contractResponse(httpBase, "/api/accounts/vizard/status", { headers: authB });
  after = await modelSnapshot(httpDataDir);
  await check("an authenticated admin claim without canonical ownership remains denied", async () => {
    assert.equal(adminClaimStatus.status, 403);
    assert.equal(adminClaimStatus.body?.code, "not_authorized");
    assert.equal(after.hash, before.hash);
  }, "http-management");
  httpProbeCount += 1;
  httpResults.push({ identity: "admin-claim-non-owner", status: adminClaimStatus.status, code: adminClaimStatus.body?.code, authorization: "membership denied", postAuthorization: false, persistenceMutations: 0 });

  before = after;
  const workspaceAttackStatus = await contractResponse(
    httpBase,
    `/api/accounts/vizard/status?workspaceId=${encodeURIComponent(workspaceB)}`,
    { headers: authA }
  );
  after = await modelSnapshot(httpDataDir);
  await check("an owner cannot redirect management to a foreign workspace through request data", async () => {
    assert.equal(workspaceAttackStatus.status, 403);
    assert.equal(workspaceAttackStatus.body?.code, "not_authorized");
    assert.equal(after.hash, before.hash);
  }, "http-management");
  httpProbeCount += 1;
  httpResults.push({ identity: "owner-request-workspace-attack", status: workspaceAttackStatus.status, code: workspaceAttackStatus.body?.code, authorization: "workspace context denied", postAuthorization: false, persistenceMutations: 0 });

  before = after;
  const foreignOwnerStatus = await contractResponse(
    httpBase,
    `/api/accounts/vizard/status?workspaceId=${encodeURIComponent(workspaceB)}`,
    { headers: authB }
  );
  after = await modelSnapshot(httpDataDir);
  await check("a foreign owner cannot name its own workspace while its trusted device selects another", async () => {
    assert.equal(foreignOwnerStatus.status, 403);
    assert.equal(foreignOwnerStatus.body?.code, "not_authorized");
    assert.equal(after.hash, before.hash);
  }, "http-management");
  httpProbeCount += 1;
  httpResults.push({ identity: "foreign-owner", status: foreignOwnerStatus.status, code: foreignOwnerStatus.body?.code, authorization: "workspace context denied", postAuthorization: false, persistenceMutations: 0 });

  before = after;
  const ownerRecheck = await contractResponse(httpBase, "/api/accounts/vizard/status", { headers: authA });
  after = await modelSnapshot(httpDataDir);
  await check("the canonical owner remains authorized after hostile fixture probes", async () => {
    assert.equal(ownerRecheck.status, 400);
    assert.equal(ownerRecheck.body?.code, "invalid_request");
    assert.equal(after.hash, before.hash);
  }, "http-management");
  httpProbeCount += 1;
  httpResults.push({ identity: "canonical-owner-recheck", status: ownerRecheck.status, code: ownerRecheck.body?.code, authorization: "allowed", postAuthorization: true, persistenceMutations: 0 });

  const attempts = await externalAttempts(httpExternalLog);
  await check("management HTTP probes make zero provider or external requests", async () => {
    assert.deepEqual(attempts, []);
    assert.equal(httpResults.every(result => result.persistenceMutations === 0), true);
  }, "http-management");
  await check("management HTTP output omits all synthetic secrets", async () => {
    const output = `${httpStdout}\n${httpStderr}`;
    for (const forbidden of [HTTP_PASSWORD_A, HTTP_PASSWORD_B, HTTP_SESSION_SECRET, HTTP_ENCRYPTION_KEY]) {
      assert.equal(output.includes(forbidden), false);
      assert.equal(httpResults.some(result => JSON.stringify(result).includes(forbidden)), false);
    }
  }, "http-management");
} finally {
  await stopContractServer(httpChild);
}

await check("the focused contract makes zero external requests", async () => {
  assert.equal(externalRequests, 0);
});

globalThis.fetch = originalFetch;
assert.deepEqual(Object.keys(authorizationModule), ["requireWorkspaceManagementAccess"]);
assert.deepEqual(Object.keys(localMembershipModule), ["resolveLocalWorkspaceManagementMembership"]);
assert.ok(identityPolicyChecks >= 87, `expected at least 87 identity-policy checks, received ${identityPolicyChecks}`);
assert.ok(hostileMutationCount >= 19, `expected at least 19 hostile mutations, received ${hostileMutationCount}`);
assert.ok(httpProbeCount >= 7, `expected at least 7 HTTP probes, received ${httpProbeCount}`);
console.log(JSON.stringify({
  ok: true,
  checks: passed,
  originalChecks: 24,
  identityPolicyChecks,
  hostileMutations: hostileMutationCount,
  httpProbes: httpProbeCount,
  httpResults,
  localAdminSupported: false,
  providerRequests: 0,
  externalRequests,
  categoryCounts
}));
