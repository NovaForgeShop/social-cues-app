import assert from "node:assert/strict";
import test from "node:test";

import {
  createHeyGenDurableRepository,
  HEYGEN_DURABLE_CONTRACT_VERSION,
  HEYGEN_DURABLE_INTERFACE_FINGERPRINT,
  heyGenDurableFingerprint,
  sanitizeHeyGenDurableRepositoryError
} from "./heygen-durable-repository.mjs";

const actorId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const stateDigest = "A".repeat(43);
const requestFingerprint = "B".repeat(43);
const encrypted = Object.freeze({
  alg: "aes-256-gcm",
  iv: "I".repeat(16),
  tag: "T".repeat(22),
  value: "C".repeat(48)
});

function accountRow(overrides = {}) {
  return {
    id: accountId,
    workspace_id: workspaceId,
    user_id: actorId,
    provider_account_id: "heygen-account-fixture",
    display_name: "Fixture Creator",
    status: "connected",
    connected_at: "2026-09-13T12:00:00.000Z",
    credential_updated_at: "2026-09-13T12:00:00.000Z",
    token_type: "Bearer",
    expires_at: "2026-09-13T13:00:00.000Z",
    scopes: ["mcp:tools"],
    public_profile: {
      credits: { available: true, remaining: 10 },
      capabilities: [{ id: "current_user", toolName: "get_current_user" }]
    },
    encrypted_token: encrypted,
    encrypted_refresh_token: encrypted,
    ...overrides
  };
}

function jobRow(overrides = {}) {
  return {
    id: jobId,
    workspace_id: workspaceId,
    requesting_user_id: actorId,
    action: "prompt_to_video",
    operation_id: "operation-fixture",
    status: "submitted",
    created_at: "2026-09-13T12:00:00.000Z",
    updated_at: "2026-09-13T12:00:00.000Z",
    ...overrides
  };
}

test("repository health requires the exact durable contract fingerprint", async () => {
  const ready = createHeyGenDurableRepository({
    request: async pathname => {
      assert.equal(pathname, "/rpc/social_cues_heygen_repository_health");
      return { contract_version: HEYGEN_DURABLE_CONTRACT_VERSION, interface_fingerprint: HEYGEN_DURABLE_INTERFACE_FINGERPRINT };
    }
  });
  assert.deepEqual(await ready.probeReadiness(), {
    ready: true,
    contractVersion: HEYGEN_DURABLE_CONTRACT_VERSION,
    interfaceFingerprint: HEYGEN_DURABLE_INTERFACE_FINGERPRINT,
    state: "database_ready"
  });

  const stale = createHeyGenDurableRepository({
    request: async () => ({ contract_version: HEYGEN_DURABLE_CONTRACT_VERSION, interface_fingerprint: "stale-interface" })
  });
  assert.equal((await stale.probeReadiness()).ready, false);
});

test("OAuth state and account RPCs carry only digests and protected envelopes", async () => {
  const calls = [];
  const plaintextCanary = "HEYGEN_PLAINTEXT_CANARY_REPOSITORY";
  const repository = createHeyGenDurableRepository({
    request: async (pathname, options) => {
      const body = JSON.parse(options.body);
      calls.push({ pathname, body });
      if (pathname.endsWith("oauth_state_issue")) return { outcome: "issued" };
      if (pathname.endsWith("oauth_state_consume")) {
        return { outcome: "consumed", state_digest: stateDigest, protected_verifier: encrypted, metadata: { issuer: "https://auth.heygen.com" } };
      }
      if (pathname.endsWith("connection_commit")) return { replayed: false, account: accountRow() };
      throw new Error("unexpected RPC");
    }
  });

  await repository.issueOAuthState({
    actorId,
    workspaceId,
    stateDigest,
    protectedVerifier: encrypted,
    metadata: { issuer: "https://auth.heygen.com" },
    issuedAt: "2026-09-13T12:00:00.000Z",
    expiresAt: "2026-09-13T12:10:00.000Z"
  });
  const consumed = await repository.consumeOAuthState({ actorId, workspaceId, stateDigest });
  const committed = await repository.commitConnection({
    actorId,
    workspaceId,
    stateDigest: consumed.stateDigest,
    account: {
      id: accountId,
      providerAccountId: "heygen-account-fixture",
      displayName: "Fixture Creator",
      scopes: ["mcp:tools"],
      profile: { credits: { available: true, remaining: 10 } },
      credential: encrypted,
      refreshCredential: encrypted,
      tokenType: "Bearer",
      tokenExpiresAt: "2026-09-13T13:00:00.000Z",
      connectedAt: "2026-09-13T12:00:00.000Z"
    }
  });
  assert.equal(committed.account.providerAccountId, "heygen-account-fixture");
  assert.deepEqual(committed.account.credential, encrypted);
  const serialized = JSON.stringify({ calls, committed });
  assert.equal(serialized.includes(plaintextCanary), false);
  assert.equal(serialized.includes("state="), false);
  assert.equal(calls[0].body.p_state_digest, stateDigest);
  assert.equal(calls.every(call => call.body.p_actor_user_id === actorId && call.body.p_workspace_id === workspaceId), true);
});

test("job RPC projection omits private request and fingerprint columns", async () => {
  const requestArguments = { prompt: "Fixture video" };
  const repository = createHeyGenDurableRepository({
    request: async pathname => {
      if (pathname.endsWith("job_reserve")) {
        return { replayed: false, job: jobRow(), request_arguments: requestArguments, account: accountRow() };
      }
      if (pathname.endsWith("jobs_list")) {
        return { jobs: [jobRow({ request_arguments: { secret: "must-not-project" }, request_fingerprint: requestFingerprint })] };
      }
      throw new Error("unexpected RPC");
    }
  });
  const reserved = await repository.reserveJob({
    actorId,
    workspaceId,
    action: "prompt_to_video",
    operationId: "operation-fixture",
    requestFingerprint,
    requestArguments
  });
  assert.deepEqual(reserved.requestArguments, requestArguments);
  assert.equal("requestArguments" in reserved.job, false);
  assert.equal("requestFingerprint" in reserved.job, false);
  const listed = await repository.listJobs({ actorId, workspaceId });
  assert.equal(JSON.stringify(listed).includes("must-not-project"), false);
  assert.equal(JSON.stringify(listed).includes(requestFingerprint), false);
});

test("input validation and transport failures fail closed without leaking detail", async () => {
  let requests = 0;
  const repository = createHeyGenDurableRepository({
    request: async () => {
      requests += 1;
      throw new Error("database detail with SECRET_DATABASE_CANARY");
    }
  });
  await assert.rejects(repository.getAccount({ actorId: "not-a-uuid", workspaceId }), error => error.code === "heygen_actor_invalid" && error.status === 403);
  assert.equal(requests, 0);
  await assert.rejects(repository.getAccount({ actorId, workspaceId }), error => {
    const safe = sanitizeHeyGenDurableRepositoryError(error);
    assert.equal(JSON.stringify(safe).includes("SECRET_DATABASE_CANARY"), false);
    return safe.code === "heygen_durable_repository_unavailable" && safe.status === 503;
  });
  assert.equal(requests, 1);
  assert.equal(heyGenDurableFingerprint({ b: 2, a: 1 }), heyGenDurableFingerprint({ a: 1, b: 2 }));
});

test("operation receipts accept only bounded public outcomes", async () => {
  const calls = [];
  const repository = createHeyGenDurableRepository({
    request: async (pathname, options) => {
      calls.push({ pathname, body: JSON.parse(options.body) });
      if (pathname.endsWith("account_operation_begin")) {
        return {
          outcome: "completed",
          account: null,
          safe_result: { remoteRevocation: { attempted: true, state: "remote_revocation_confirmed" } }
        };
      }
      if (pathname.endsWith("disconnect_complete")) {
        return { replayed: false, safe_result: JSON.parse(options.body).p_safe_result };
      }
      throw new Error("unexpected RPC");
    }
  });
  const operation = await repository.beginAccountOperation({
    actorId,
    workspaceId,
    action: "disconnect",
    operationId: "disconnect-fixture",
    requestFingerprint
  });
  assert.deepEqual(operation.safeResult, {
    remoteRevocation: { attempted: true, state: "remote_revocation_confirmed" }
  });
  const completed = await repository.completeDisconnect({
    actorId,
    workspaceId,
    operationId: "disconnect-fixture",
    requestFingerprint,
    safeResult: { remoteRevocation: { attempted: false, state: "remote_revocation_unavailable" } }
  });
  assert.deepEqual(completed.safeResult, {
    remoteRevocation: { attempted: false, state: "remote_revocation_unavailable" }
  });
  const requestCount = calls.length;
  await assert.rejects(repository.completeDisconnect({
    actorId,
    workspaceId,
    operationId: "disconnect-fixture-unsafe",
    requestFingerprint,
    safeResult: { remoteRevocation: { attempted: true, state: "remote_revocation_confirmed", token: "must-not-persist" } }
  }), error => error.code === "heygen_disconnect_result_invalid" && error.status === 400);
  assert.equal(calls.length, requestCount);
});
