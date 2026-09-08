import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { test } from "node:test";
import {
  createHostedWorkspacePersistence
} from "./hosted-workspace-persistence.mjs";
import { WorkspaceContentPersistenceError } from "./workspace-content-persistence.mjs";

const CONTRACT_VERSION = "social-cues.hosted-workspace-repository.v2";
const CONTEXT_VERSION = "social-cues.workspace-actor.v2";
const PUBLIC_SCHEMA_VERSION = "social-cues.workspace-public.v2";
const RPC_ROOT = "/rest/v1/rpc/social_cues_workspace_";
const FIXED_START_MS = Date.parse("2026-09-07T19:30:00.000Z");
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,127})$/;
const SECRET_SENTINEL = "p36-private-sentinel-never-store-or-return";
const IDS = Object.freeze({
  workspaceA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workspaceMissing: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ownerA: "11111111-1111-4111-8111-111111111111",
  adminA: "12121212-1212-4121-8121-121212121212",
  memberA: "13131313-1313-4131-8131-131313131313",
  viewerA: "14141414-1414-4141-8141-141414141414",
  outsider: "15151515-1515-4151-8151-151515151515",
  ownerB: "22222222-2222-4222-8222-222222222222",
  epochA: "aaaaaaaa-0000-4000-8000-000000000001",
  epochB: "bbbbbbbb-0000-4000-8000-000000000001",
  leaseA: "eeeeeeee-0000-4000-8000-000000000001",
  leaseB: "eeeeeeee-0000-4000-8000-000000000002",
  jobContent: "dddddddd-0000-4000-8000-000000000001",
  jobProvider: "dddddddd-0000-4000-8000-000000000002",
  jobWorker: "dddddddd-0000-4000-8000-000000000003",
  jobRepair: "dddddddd-0000-4000-8000-000000000004",
  jobSecond: "dddddddd-0000-4000-8000-000000000005"
});

const clone = value => JSON.parse(JSON.stringify(value));
const keyFor = (workspaceId, actorUserId) => workspaceId + ":" + actorUserId;
const receiptKey = (workspaceId, epoch, operationId) => workspaceId + ":" + epoch + ":" + operationId;
const operationId = number => "00000000-0000-4000-8000-" + String(number).padStart(12, "0");

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : stable(value)).digest("hex");
}

function publicModel(label = "initial") {
  return {
    activity: [{ id: "activity-" + label, kind: "note", label }],
    analytics: { cadence: "weekly", score: 1 },
    campaigns: [{ id: "campaign-" + label, brief: label, status: "draft" }],
    drafts: [{ id: "draft-" + label, text: "copy " + label, status: "draft" }],
    media: [{ id: "media-" + label, name: label + ".png", status: "planned" }],
    preferences: { locale: "en-US", timezone: "UTC" },
    profile: { displayName: label + " studio", industry: "software" },
    providerStates: [{ provider: "discord", accountId: "public-account", status: "ready" }],
    schemaVersion: PUBLIC_SCHEMA_VERSION
  };
}

function userContext(actorUserId = IDS.ownerA, role = "owner", workspaceId = IDS.workspaceA, ownerUserId = IDS.ownerA) {
  return {
    activeWorkspaceId: workspaceId,
    actorUserId,
    contextVersion: CONTEXT_VERSION,
    entitlementStatus: "active",
    membershipStatus: "active",
    mode: "user-jwt",
    ownerUserId,
    role,
    sessionStatus: "active",
    sessionUserId: actorUserId,
    source: "verified-session"
  };
}

const JOBS = Object.freeze({
  content: {
    actorUserId: IDS.ownerA,
    allowedIntent: "workspace.content-result",
    jobId: IDS.jobContent,
    leaseId: IDS.leaseA,
    ownerUserId: IDS.ownerA,
    workspaceId: IDS.workspaceA
  },
  provider: {
    actorUserId: IDS.ownerA,
    allowedIntent: "workspace.provider-state-result",
    jobId: IDS.jobProvider,
    leaseId: IDS.leaseA,
    ownerUserId: IDS.ownerA,
    workspaceId: IDS.workspaceA
  },
  worker: {
    actorUserId: IDS.ownerA,
    allowedIntent: "workspace.worker-result",
    jobId: IDS.jobWorker,
    leaseId: IDS.leaseA,
    ownerUserId: IDS.ownerA,
    workspaceId: IDS.workspaceA
  },
  repair: {
    actorUserId: IDS.ownerA,
    allowedIntent: "workspace.system-repair",
    jobId: IDS.jobRepair,
    leaseId: IDS.leaseA,
    ownerUserId: IDS.ownerA,
    workspaceId: IDS.workspaceA
  },
  second: {
    actorUserId: IDS.adminA,
    allowedIntent: "workspace.content-result",
    jobId: IDS.jobSecond,
    leaseId: IDS.leaseB,
    ownerUserId: IDS.ownerA,
    workspaceId: IDS.workspaceA
  }
});

function serviceContext(name = "worker") {
  return {
    ...clone(JOBS[name]),
    contextVersion: CONTEXT_VERSION,
    leaseStatus: "active",
    mode: "service-job",
    source: "claimed-service-job"
  };
}

function bytes(value, space = 0) {
  return Buffer.from(JSON.stringify(value, null, space));
}

function clientEnvelope(base, model, number, kind = "model-save") {
  return {
    expectedRevision: clone(base.revision),
    kind,
    operationId: operationId(number),
    request: kind === "content-recovery"
      ? { sections: { campaigns: clone(model.campaigns), drafts: clone(model.drafts) } }
      : { model: clone(model) }
  };
}

function serviceEnvelope(base, intent, request, number) {
  return {
    expectedRevision: clone(base.revision),
    intent,
    operationId: operationId(number),
    request: clone(request)
  };
}

async function rejectsCode(action, code, status) {
  let seen;
  await assert.rejects(action, error => {
    seen = error;
    assert.equal(error?.code, code);
    assert.equal(error?.status, status);
    assert.equal(error?.message, code);
    return true;
  });
  return seen;
}

function createFakePostgrest() {
  const state = {
    rows: new Map(),
    receipts: new Map(),
    directories: new Map(),
    memberships: new Map(),
    jobs: new Map(),
    requests: [],
    audit: [],
    transactionQueue: Promise.resolve(),
    barriers: new Map(),
    fault: null,
    clientFault: null,
    clockTick: 0,
    epochCounter: 0,
    mutations: 0,
    externalRequests: 0,
    nonLoopbackRequests: 0,
    providerRequests: 0,
    productionMutations: 0
  };

  function resetData() {
    state.rows.clear();
    state.receipts.clear();
    state.directories.clear();
    state.memberships.clear();
    state.jobs.clear();
    state.barriers.clear();
    state.fault = null;
    state.clientFault = null;
    state.transactionQueue = Promise.resolve();
    state.directories.set(IDS.workspaceA, [{ workspaceId: IDS.workspaceA, ownerUserId: IDS.ownerA }]);
    state.directories.set(IDS.workspaceB, [{ workspaceId: IDS.workspaceB, ownerUserId: IDS.ownerB }]);
    state.directories.set(IDS.workspaceMissing, [{ workspaceId: IDS.workspaceMissing, ownerUserId: IDS.ownerA }]);
    for (const [actor, role] of [
      [IDS.ownerA, "owner"],
      [IDS.adminA, "admin"],
      [IDS.memberA, "member"],
      [IDS.viewerA, "viewer"]
    ]) {
      state.memberships.set(keyFor(IDS.workspaceA, actor), [{
        actorUserId: actor,
        entitlementStatus: "active",
        membershipStatus: "active",
        ownerUserId: IDS.ownerA,
        role,
        workspaceId: IDS.workspaceA
      }]);
    }
    state.memberships.set(keyFor(IDS.workspaceB, IDS.ownerB), [{
      actorUserId: IDS.ownerB,
      entitlementStatus: "active",
      membershipStatus: "active",
      ownerUserId: IDS.ownerB,
      role: "owner",
      workspaceId: IDS.workspaceB
    }]);
    state.memberships.set(keyFor(IDS.workspaceMissing, IDS.ownerA), [{
      actorUserId: IDS.ownerA,
      entitlementStatus: "active",
      membershipStatus: "active",
      ownerUserId: IDS.ownerA,
      role: "owner",
      workspaceId: IDS.workspaceMissing
    }]);
    for (const job of Object.values(JOBS)) state.jobs.set(job.jobId, clone(job));
  }

  function timestamp() {
    state.clockTick += 1;
    return new Date(FIXED_START_MS + state.clockTick).toISOString();
  }

  function epoch() {
    state.epochCounter += 1;
    return "f0000000-0000-4000-8000-" + String(state.epochCounter).padStart(12, "0");
  }

  function seedRow(workspaceId, ownerUserId, label = "initial", revision = "0", persistenceEpoch = null) {
    const model = publicModel(label);
    const createdAt = timestamp();
    const row = {
      content_hash: digest(model),
      created_at: createdAt,
      model,
      owner_user_id: ownerUserId,
      persistence_epoch: persistenceEpoch || (workspaceId === IDS.workspaceA ? IDS.epochA : IDS.epochB),
      revision,
      updated_at: createdAt,
      workspace_id: workspaceId
    };
    state.rows.set(workspaceId, [clone(row)]);
    return clone(row);
  }

  function configureBarrier(pathname, target = 2) {
    let release;
    const barrier = {
      arrivals: 0,
      target,
      promise: new Promise(resolve => { release = resolve; }),
      release
    };
    state.barriers.set(pathname, barrier);
  }

  async function waitAtBarrier(pathname) {
    const barrier = state.barriers.get(pathname);
    if (!barrier) return;
    barrier.arrivals += 1;
    if (barrier.arrivals >= barrier.target) {
      state.barriers.delete(pathname);
      barrier.release();
    }
    await barrier.promise;
  }

  function takeFault(name) {
    if (state.fault !== name) return false;
    state.fault = null;
    return true;
  }

  function transact(action) {
    const result = state.transactionQueue.then(action, action);
    state.transactionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function userAuthorization(gateway, workspaceId, write) {
    const directories = state.directories.get(workspaceId) || [];
    const memberships = state.memberships.get(keyFor(workspaceId, gateway.actorUserId)) || [];
    if (directories.length !== 1 || memberships.length !== 1) return false;
    const directory = directories[0];
    const membership = memberships[0];
    return gateway.mode === "user-jwt"
      && gateway.activeWorkspaceId === workspaceId
      && gateway.sessionUserId === gateway.actorUserId
      && gateway.ownerUserId === directory.ownerUserId
      && membership.ownerUserId === directory.ownerUserId
      && membership.role === gateway.role
      && membership.membershipStatus === "active"
      && membership.entitlementStatus === "active"
      && (!write || ["owner", "admin"].includes(membership.role));
  }

  function serviceAuthorization(gateway, body) {
    const job = state.jobs.get(gateway.jobId);
    const directories = state.directories.get(gateway.workspaceId) || [];
    const memberships = state.memberships.get(keyFor(gateway.workspaceId, gateway.actorUserId)) || [];
    return gateway.mode === "service-job"
      && directories.length === 1
      && memberships.length === 1
      && job
      && job.workspaceId === gateway.workspaceId
      && job.ownerUserId === gateway.ownerUserId
      && job.actorUserId === gateway.actorUserId
      && job.leaseId === gateway.leaseId
      && job.allowedIntent === gateway.allowedIntent
      && memberships[0].membershipStatus === "active"
      && memberships[0].entitlementStatus === "active"
      && memberships[0].ownerUserId === job.ownerUserId
      && body.workspace_id === job.workspaceId
      && (!body.kind || body.kind === job.allowedIntent)
      && (!body.job_id || body.job_id === job.jobId)
      && (!body.lease_id || body.lease_id === job.leaseId);
  }

  function authorized(lane, gateway, body, write = false) {
    return lane === "user-jwt"
      ? userAuthorization(gateway, body.workspace_id, write)
      : lane === "service-job" && serviceAuthorization(gateway, body);
  }

  function safeAudit(lane, pathname, body) {
    state.audit.push({
      lane,
      operation: pathname.slice(pathname.lastIndexOf("/") + 1),
      workspaceBound: typeof body?.workspace_id === "string"
    });
  }

  function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json"
    });
    res.end(body);
  }

  function deny(res, code = "workspace_authorization_failed", status = 403) {
    json(res, status, { code });
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  function responseFault(req, res, result) {
    if (takeFault("after-commit-disconnect")) {
      req.socket.destroy();
      return true;
    }
    if (takeFault("malformed-success-after")) {
      json(res, 200, { outcome: result.outcome });
      return true;
    }
    if (takeFault("zero-success-after")) {
      json(res, 200, { outcome: result.outcome, receipts: [], rows: [] });
      return true;
    }
    if (takeFault("multiple-success-after")) {
      json(res, 200, {
        outcome: result.outcome,
        receipts: [result.receipts[0], clone(result.receipts[0])],
        rows: [result.rows[0], clone(result.rows[0])]
      });
      return true;
    }
    return false;
  }

  async function initialize(body, gateway, lane) {
    return transact(() => {
      if (!authorized(lane, gateway, body, true)) {
        throw new WorkspaceContentPersistenceError("workspace_authorization_failed", 403);
      }
      if (takeFault("transaction-exception") || takeFault("clock-failure")) {
        throw new WorkspaceContentPersistenceError("workspace_storage_unavailable", 503);
      }
      const rows = state.rows.get(body.workspace_id) || [];
      if (rows.length > 1) throw new WorkspaceContentPersistenceError("workspace_storage_unavailable", 503);
      if (rows.length === 1) {
        const row = rows[0];
        if (row.owner_user_id !== gateway.ownerUserId) {
          throw new WorkspaceContentPersistenceError("workspace_authorization_failed", 403);
        }
        const saved = state.receipts.get(receiptKey(row.workspace_id, row.persistence_epoch, body.operation_id));
        if (saved) {
          if (saved.actor_user_id !== body.actor_user_id
            || saved.kind !== body.kind
            || saved.expected_revision !== null
            || saved.request_hash !== body.request_hash) {
            throw new WorkspaceContentPersistenceError("workspace_operation_id_reused", 409);
          }
          return { outcome: "replayed", receipts: [clone(saved)], rows: [clone(row)] };
        }
        return { outcome: "existing", receipts: [], rows: [clone(row)] };
      }
      const now = timestamp();
      const row = {
        content_hash: body.content_hash,
        created_at: now,
        model: clone(body.model),
        owner_user_id: gateway.ownerUserId,
        persistence_epoch: epoch(),
        revision: "0",
        updated_at: now,
        workspace_id: body.workspace_id
      };
      const receipt = {
        actor_user_id: body.actor_user_id,
        committed_at: now,
        content_hash: body.content_hash,
        expected_revision: null,
        kind: body.kind,
        operation_id: body.operation_id,
        persistence_epoch: row.persistence_epoch,
        request_hash: body.request_hash,
        result_revision: "0",
        workspace_id: body.workspace_id
      };
      state.rows.set(body.workspace_id, [clone(row)]);
      state.receipts.set(receiptKey(row.workspace_id, row.persistence_epoch, body.operation_id), clone(receipt));
      state.mutations += 1;
      return { outcome: "committed", receipts: [receipt], rows: [row] };
    });
  }

  async function commit(body, gateway, lane) {
    return transact(() => {
      if (!authorized(lane, gateway, body, true)) {
        throw new WorkspaceContentPersistenceError("workspace_authorization_failed", 403);
      }
      if (takeFault("transaction-exception")) {
        throw new WorkspaceContentPersistenceError("workspace_storage_unavailable", 503);
      }
      const rows = state.rows.get(body.workspace_id) || [];
      if (rows.length !== 1) throw new WorkspaceContentPersistenceError("workspace_storage_unavailable", 503);
      const row = rows[0];
      if (row.owner_user_id !== gateway.ownerUserId) {
        throw new WorkspaceContentPersistenceError("workspace_authorization_failed", 403);
      }
      const saved = state.receipts.get(receiptKey(row.workspace_id, row.persistence_epoch, body.operation_id));
      if (saved) {
        if (saved.actor_user_id !== body.actor_user_id
          || saved.kind !== body.kind
          || saved.expected_revision !== body.expected_revision
          || saved.request_hash !== body.request_hash) {
          throw new WorkspaceContentPersistenceError("workspace_operation_id_reused", 409);
        }
        return { outcome: "replayed", receipts: [clone(saved)], rows: [clone(row)] };
      }
      if (body.expected_epoch !== row.persistence_epoch || body.expected_revision !== row.revision) {
        throw new WorkspaceContentPersistenceError("workspace_revision_conflict", 409);
      }
      if (!HASH.test(body.content_hash) || body.content_hash !== digest(body.model)) {
        throw new WorkspaceContentPersistenceError("workspace_input_invalid", 400);
      }
      const now = timestamp();
      const next = {
        ...clone(row),
        content_hash: body.content_hash,
        model: clone(body.model),
        revision: String(BigInt(row.revision) + 1n),
        updated_at: now
      };
      const receipt = {
        actor_user_id: body.actor_user_id,
        committed_at: now,
        content_hash: body.content_hash,
        expected_revision: body.expected_revision,
        kind: body.kind,
        operation_id: body.operation_id,
        persistence_epoch: row.persistence_epoch,
        request_hash: body.request_hash,
        result_revision: next.revision,
        workspace_id: row.workspace_id
      };
      state.rows.set(body.workspace_id, [clone(next)]);
      state.receipts.set(receiptKey(row.workspace_id, row.persistence_epoch, body.operation_id), clone(receipt));
      state.mutations += 1;
      return { outcome: "committed", receipts: [receipt], rows: [next] };
    });
  }

  async function reconcile(body, gateway, lane) {
    return transact(() => {
      if (!authorized(lane, gateway, body, false)) {
        throw new WorkspaceContentPersistenceError("workspace_authorization_failed", 403);
      }
      const rows = state.rows.get(body.workspace_id) || [];
      if (rows.length === 0) return { outcome: "absent", receipts: [], rows: [] };
      if (rows.length !== 1) throw new WorkspaceContentPersistenceError("workspace_storage_unavailable", 503);
      const row = rows[0];
      const saved = state.receipts.get(receiptKey(row.workspace_id, row.persistence_epoch, body.operation_id));
      if (!saved) return { outcome: "not_found", receipts: [], rows: [clone(row)] };
      if (saved.actor_user_id !== body.actor_user_id
        || saved.kind !== body.kind
        || saved.expected_revision !== body.expected_revision
        || saved.request_hash !== body.request_hash) {
        throw new WorkspaceContentPersistenceError("workspace_operation_id_reused", 409);
      }
      return { outcome: "replayed", receipts: [clone(saved)], rows: [clone(row)] };
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const lane = String(req.headers["x-contract-lane"] || "");
      if (req.method !== "POST" || !url.pathname.startsWith(RPC_ROOT) || !["user-jwt", "service-job"].includes(lane)) {
        state.providerRequests += 1;
        return json(res, 404, { code: "workspace_storage_unavailable" });
      }
      const input = await readBody(req);
      const gateway = input.gateway;
      const body = input.body;
      state.requests.push({ lane, method: req.method, pathname: url.pathname });
      safeAudit(lane, url.pathname, body);

      if (url.pathname.endsWith("_read_v2") && takeFault("read-reset")) {
        req.socket.destroy();
        return;
      }
      if (url.pathname.endsWith("_read_v2") && takeFault("read-timeout")) {
        await new Promise(resolve => setTimeout(resolve, 1_100));
        if (req.socket.destroyed) return;
      }
      if (takeFault("database-unavailable")) {
        return deny(res, "workspace_storage_unavailable", 503);
      }
      if (takeFault("schema-unavailable")) {
        return deny(res, "workspace_storage_unavailable", 503);
      }
      if (takeFault("denied-grant")) {
        return deny(res);
      }
      if ((url.pathname.endsWith("_commit_v2") || url.pathname.endsWith("_initialize_v2"))
        && takeFault("before-commit-http")) {
        return deny(res, "workspace_storage_unavailable", 503);
      }
      if (url.pathname.endsWith("_receipt_v2") && takeFault("reconcile-reset")) {
        req.socket.destroy();
        return;
      }
      await waitAtBarrier(url.pathname);

      if (url.pathname.endsWith("_read_v2")) {
        if (!authorized(lane, gateway, body, false)) return deny(res);
        const rows = state.rows.get(body.workspace_id) || [];
        if (takeFault("malformed-read")) return json(res, 200, { surprise: true });
        return json(res, 200, {
          outcome: rows.length === 0 ? "absent" : "present",
          rows: clone(rows)
        });
      }

      let result;
      if (url.pathname.endsWith("_initialize_v2")) result = await initialize(body, gateway, lane);
      else if (url.pathname.endsWith("_commit_v2")) result = await commit(body, gateway, lane);
      else if (url.pathname.endsWith("_receipt_v2")) result = await reconcile(body, gateway, lane);
      else return json(res, 404, { code: "workspace_storage_unavailable" });
      if (!responseFault(req, res, result)) json(res, 200, result);
    } catch (error) {
      if (res.headersSent || req.socket.destroyed) return;
      const code = error instanceof WorkspaceContentPersistenceError
        ? error.code
        : "workspace_storage_unavailable";
      const status = error instanceof WorkspaceContentPersistenceError
        ? error.status
        : 503;
      deny(res, code, status);
    }
  });

  resetData();
  return { server, state, resetData, seedRow, configureBarrier };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return "http://127.0.0.1:" + address.port;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

function requestFor(baseUrl, state, lane) {
  return async (pathname, options = {}) => {
    const url = new URL("/rest/v1" + pathname, baseUrl);
    if (url.hostname !== "127.0.0.1") {
      state.externalRequests += 1;
      state.nonLoopbackRequests += 1;
    }
    if (state.clientFault?.phase === "before-request" && state.clientFault.pathname === pathname) {
      state.clientFault = null;
      throw new Error("synthetic transport loss");
    }
    const response = await fetch(url, {
      method: options.method,
      headers: {
        "Content-Type": "application/json",
        "X-Contract-Lane": lane
      },
      body: JSON.stringify({ body: options.body, gateway: options.context }),
      signal: AbortSignal.timeout(1_000)
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (state.clientFault?.phase === "after-response" && state.clientFault.pathname === pathname) {
      state.clientFault = null;
      throw new Error("synthetic response loss");
    }
    if (!response.ok) {
      const code = typeof parsed?.code === "string" ? parsed.code : "workspace_storage_unavailable";
      throw new WorkspaceContentPersistenceError(code, response.status);
    }
    return parsed;
  };
}

function adapterFor(baseUrl, state) {
  return createHostedWorkspacePersistence({
    serviceJobRequest: requestFor(baseUrl, state, "service-job"),
    userJwtRequest: requestFor(baseUrl, state, "user-jwt")
  });
}

function currentRow(state, workspaceId = IDS.workspaceA) {
  const rows = state.rows.get(workspaceId) || [];
  assert.equal(rows.length, 1);
  return clone(rows[0]);
}

function privateStateSnapshot(state) {
  return {
    audit: clone(state.audit),
    receipts: [...state.receipts.values()].map(clone),
    rows: [...state.rows.values()].flat().map(clone)
  };
}

test("repository v2 remains inert while R4 and external content stay held", async () => {
  const [serverSource, moduleSource, writerContractSource] = await Promise.all([
    readFile(new URL("./server.mjs", import.meta.url), "utf8"),
    readFile(new URL("./hosted-workspace-persistence.mjs", import.meta.url), "utf8"),
    readFile(new URL("./hosted-workspace-writers.contract.test.mjs", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(serverSource, /hosted-workspace-persistence\.mjs/);
  assert.doesNotMatch(serverSource, /createHostedWorkspacePersistence/);
  assert.match(serverSource, /hostedPersistence:\s*Object\.freeze\(\{\s*review:\s*"R4",\s*status:\s*"HOLD"\s*\}\)/);
  assert.match(serverSource, /externalUserContent:\s*"HOLD"/);
  assert.match(writerContractSource, /206/);
  assert.doesNotMatch(moduleSource, /process\.env|node:fs|localSaveModel|ensureModel|app_state|fetch\s*\(/);
  assert.doesNotMatch(moduleSource, /\bserverSave\s*\(|\bnew\s+WeakMap\s*\(|\bmutex\b|\bsendEmail\s*\(/i);

  const inert = createHostedWorkspacePersistence({
    serviceJobRequest: async () => ({ outcome: "absent", rows: [] }),
    userJwtRequest: async () => ({ outcome: "absent", rows: [] })
  });
  assert.equal(inert.contractVersion, CONTRACT_VERSION);
  assert.equal(inert.contextVersion, CONTEXT_VERSION);
  assert.equal(inert.publicSchemaVersion, PUBLIC_SCHEMA_VERSION);
  assert.deepEqual(inert.intents, [
    "workspace.initialize",
    "workspace.client-save",
    "workspace.content-recovery",
    "workspace.content-result",
    "workspace.provider-state-result",
    "workspace.worker-result",
    "workspace.system-repair"
  ]);
  assert.deepEqual(Object.keys(inert).sort(), [
    "commitClient",
    "commitService",
    "contextVersion",
    "contractVersion",
    "initializeUser",
    "intents",
    "publicSchemaVersion",
    "readService",
    "readUser"
  ]);
});

test("hosted repository v2 hermetic contract", async t => {
  const fake = createFakePostgrest();
  const baseUrl = await listen(fake.server);
  const scenarios = [];
  const races = [];
  const receiptCases = [];
  let cleanupComplete = false;

  async function scenario(name, action) {
    scenarios.push(name);
    await t.test(name, action);
  }

  try {
    await scenario("initialization creates one server-owned epoch at revision zero", async () => {
      fake.resetData();
      const adapter = adapterFor(baseUrl, fake.state);
      const model = publicModel("bootstrap");
      const input = { operationId: operationId(1), request: { model } };
      const before = fake.state.mutations;
      const result = await adapter.initializeUser(userContext(), input, bytes(input));
      assert.deepEqual(Object.keys(result).sort(), [
        "commitStatus",
        "committedRevision",
        "currentRevision",
        "durability",
        "operationId",
        "replayed",
        "superseded"
      ]);
      assert.equal(result.committedRevision.revision, "0");
      assert.equal(result.currentRevision.revision, "0");
      assert.equal(result.replayed, false);
      assert.equal(result.superseded, false);
      assert.deepEqual(result.durability, {
        atomicCompareAndSwap: true,
        driver: "supabase-postgres"
      });
      assert.equal(fake.state.mutations - before, 1);

      const row = currentRow(fake.state);
      assert.equal(row.owner_user_id, IDS.ownerA);
      assert.equal(row.workspace_id, IDS.workspaceA);
      assert.match(row.persistence_epoch, /^[0-9a-f-]{36}$/);
      assert.equal(row.revision, "0");
      assert.equal(row.content_hash, digest(model));
      assert.equal(row.created_at, row.updated_at);
      assert.deepEqual(Object.keys(row).sort(), [
        "content_hash",
        "created_at",
        "model",
        "owner_user_id",
        "persistence_epoch",
        "revision",
        "updated_at",
        "workspace_id"
      ]);
      const read = await adapter.readUser(userContext());
      assert.deepEqual(read, { state: "present", model, revision: result.currentRevision });
    });

    await scenario("barrier-controlled two-instance bootstrap creates one row and one epoch", async () => {
      races.push("bootstrap/bootstrap");
      fake.resetData();
      const before = fake.state.mutations;
      const first = adapterFor(baseUrl, fake.state);
      const second = adapterFor(baseUrl, fake.state);
      fake.configureBarrier(RPC_ROOT + "initialize_v2");
      const one = { operationId: operationId(2), request: { model: publicModel("bootstrap-one") } };
      const two = { operationId: operationId(3), request: { model: publicModel("bootstrap-two") } };
      const results = await Promise.all([
        first.initializeUser(userContext(), one, bytes(one)),
        second.initializeUser(userContext(), two, bytes(two))
      ]);
      assert.equal(fake.state.mutations - before, 1);
      assert.equal((fake.state.rows.get(IDS.workspaceA) || []).length, 1);
      assert.equal(results.filter(result => result.commitStatus === "committed").length, 1);
      assert.equal(results.filter(result => result.initialized === false && result.state === "present").length, 1);
      assert.equal(new Set(results.map(result => result.currentRevision?.epoch || result.revision.epoch)).size, 1);
      const restarted = adapterFor(baseUrl, fake.state);
      const loaded = await restarted.readUser(userContext());
      assert.equal(loaded.state, "present");
      assert.equal(loaded.revision.revision, "0");
    });

    await scenario("initialization replay survives adapter restart", async () => {
      receiptCases.push("initialize-restart-replay");
      fake.resetData();
      const input = { operationId: operationId(4), request: { model: publicModel("init-replay") } };
      const first = adapterFor(baseUrl, fake.state);
      const committed = await first.initializeUser(userContext(), input, bytes(input));
      const before = fake.state.mutations;
      const restarted = adapterFor(baseUrl, fake.state);
      const replay = await restarted.initializeUser(userContext(), input, bytes(input));
      assert.equal(replay.replayed, true);
      assert.equal(replay.superseded, false);
      assert.deepEqual(replay.committedRevision, committed.committedRevision);
      assert.equal(fake.state.mutations, before);
      assert.equal(fake.state.receipts.size, 1);

      const changed = {
        operationId: input.operationId,
        request: { model: publicModel("changed-init") }
      };
      await rejectsCode(
        () => restarted.initializeUser(userContext(), changed, bytes(changed)),
        "workspace_operation_id_reused",
        409
      );
    });

    await scenario("bootstrap foreign-owner collision and clock failure write nothing", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerB, "foreign", "0", IDS.epochA);
      const adapter = adapterFor(baseUrl, fake.state);
      const input = { operationId: operationId(5), request: { model: publicModel("attack") } };
      const before = fake.state.mutations;
      await rejectsCode(
        () => adapter.initializeUser(userContext(), input, bytes(input)),
        "workspace_authorization_failed",
        403
      );
      assert.equal(fake.state.mutations, before);
      assert.equal(currentRow(fake.state).owner_user_id, IDS.ownerB);

      fake.resetData();
      fake.state.fault = "clock-failure";
      await rejectsCode(
        () => adapter.initializeUser(userContext(), input, bytes(input)),
        "workspace_storage_unavailable",
        503
      );
      assert.equal((fake.state.rows.get(IDS.workspaceA) || []).length, 0);
      assert.equal(fake.state.receipts.size, 0);
    });

    await scenario("user context enforces session membership entitlement role and tenant binding", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      for (const [actor, role] of [
        [IDS.ownerA, "owner"],
        [IDS.adminA, "admin"],
        [IDS.memberA, "member"],
        [IDS.viewerA, "viewer"]
      ]) {
        const result = await adapter.readUser(userContext(actor, role));
        assert.equal(result.state, "present");
      }

      const outsiderError = await rejectsCode(
        () => adapter.readUser(userContext(IDS.outsider, "member")),
        "workspace_authorization_failed",
        403
      );
      assert.doesNotMatch(JSON.stringify(outsiderError), /revision|aaaaaaaa/i);

      const removed = clone(fake.state.memberships.get(keyFor(IDS.workspaceA, IDS.memberA))[0]);
      removed.membershipStatus = "removed";
      fake.state.memberships.set(keyFor(IDS.workspaceA, IDS.memberA), [removed]);
      await rejectsCode(
        () => adapter.readUser(userContext(IDS.memberA, "member")),
        "workspace_authorization_failed",
        403
      );

      await rejectsCode(
        () => adapter.readUser({ ...userContext(), sessionStatus: "expired" }),
        "workspace_authorization_failed",
        403
      );
      await rejectsCode(
        () => adapter.readUser({ ...userContext(), entitlementStatus: "inactive" }),
        "workspace_authorization_failed",
        403
      );
      await rejectsCode(
        () => adapter.readUser({ ...userContext(), sessionStatus: "revoked" }),
        "workspace_authorization_failed",
        403
      );
      await rejectsCode(
        () => adapter.readUser({ ...userContext(), jobId: IDS.jobWorker }),
        "workspace_authorization_failed",
        403
      );
      await rejectsCode(
        () => adapter.readUser({ ...userContext(), requestedWorkspaceId: IDS.workspaceB }),
        "workspace_authorization_failed",
        403
      );
      await rejectsCode(
        () => adapter.readUser({ ...userContext(), actorUserId: "not-a-uuid", sessionUserId: "not-a-uuid" }),
        "workspace_authorization_failed",
        403
      );
      await rejectsCode(
        () => adapter.readUser(null),
        "authentication_required",
        401
      );
      await rejectsCode(
        () => adapter.readUser(userContext(IDS.ownerA, "owner", IDS.workspaceB, IDS.ownerB)),
        "workspace_authorization_failed",
        403
      );
      await rejectsCode(
        () => adapter.readUser(userContext(IDS.ownerA, "admin")),
        "workspace_authorization_failed",
        403
      );

      const inactiveEntitlement = clone(fake.state.memberships.get(keyFor(IDS.workspaceA, IDS.adminA))[0]);
      inactiveEntitlement.entitlementStatus = "inactive";
      fake.state.memberships.set(keyFor(IDS.workspaceA, IDS.adminA), [inactiveEntitlement]);
      await rejectsCode(
        () => adapter.readUser(userContext(IDS.adminA, "admin")),
        "workspace_authorization_failed",
        403
      );
    });

    await scenario("member and viewer reads stay allowed while every interactive write is owner or admin only", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      for (const [actor, role] of [[IDS.memberA, "member"], [IDS.viewerA, "viewer"]]) {
        const base = await adapter.readUser(userContext(actor, role));
        const input = clientEnvelope(base, publicModel("denied-" + role), 10 + scenarios.length);
        const beforeRequests = fake.state.requests.length;
        await rejectsCode(
          () => adapter.commitClient(userContext(actor, role), base, input, bytes(input)),
          "workspace_authorization_failed",
          403
        );
        assert.equal(fake.state.requests.length, beforeRequests);
      }

      const admin = userContext(IDS.adminA, "admin");
      const adminBase = await adapter.readUser(admin);
      const adminInput = clientEnvelope(adminBase, publicModel("admin-write"), 20);
      const result = await adapter.commitClient(admin, adminBase, adminInput, bytes(adminInput));
      assert.equal(result.currentRevision.revision, "1");
      assert.equal(currentRow(fake.state).model.profile.displayName, "admin-write studio");
    });

    await scenario("reads distinguish authorized absence, forbidden tenants, and unavailable storage", async () => {
      fake.resetData();
      const adapter = adapterFor(baseUrl, fake.state);
      const before = fake.state.mutations;
      assert.deepEqual(
        await adapter.readUser(userContext(IDS.ownerA, "owner", IDS.workspaceMissing, IDS.ownerA)),
        { state: "absent" }
      );
      assert.equal(fake.state.mutations, before);
      await rejectsCode(
        () => adapter.readUser(userContext(IDS.outsider, "member", IDS.workspaceMissing, IDS.ownerA)),
        "workspace_authorization_failed",
        403
      );
      fake.state.fault = "database-unavailable";
      await rejectsCode(() => adapter.readUser(userContext()), "workspace_storage_unavailable", 503);
      fake.state.fault = "read-reset";
      await rejectsCode(() => adapter.readUser(userContext()), "workspace_storage_unavailable", 503);
      fake.state.fault = "read-timeout";
      await rejectsCode(() => adapter.readUser(userContext()), "workspace_storage_unavailable", 503);
      fake.state.fault = "schema-unavailable";
      await rejectsCode(() => adapter.readUser(userContext()), "workspace_storage_unavailable", 503);
    });

    await scenario("malformed, zero, and multiple read results fail closed without writes", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const before = fake.state.mutations;
      fake.state.fault = "malformed-read";
      await rejectsCode(() => adapter.readUser(userContext()), "workspace_storage_unavailable", 503);

      const row = currentRow(fake.state);
      fake.state.rows.set(IDS.workspaceA, [row, clone(row)]);
      await rejectsCode(() => adapter.readUser(userContext()), "workspace_storage_unavailable", 503);
      assert.equal(fake.state.mutations, before);
    });

    await scenario("strict client envelope rejects malformed noncanonical and unbounded input before writes", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const valid = clientEnvelope(base, publicModel("valid"), 30);
      const cases = [];
      const missing = clone(valid);
      delete missing.expectedRevision;
      cases.push([missing, "workspace_revision_required", 428, bytes(missing)]);
      cases.push([{ ...clone(valid), expectedRevision: null }, "workspace_revision_required", 428, bytes({ ...clone(valid), expectedRevision: null })]);
      cases.push([{ ...clone(valid), extra: true }, "workspace_input_invalid", 400, bytes({ ...clone(valid), extra: true })]);
      cases.push([{ ...clone(valid), kind: "raw-model-write" }, "workspace_input_invalid", 400, bytes({ ...clone(valid), kind: "raw-model-write" })]);
      cases.push([{ ...clone(valid), operationId: "not-a-uuid" }, "workspace_input_invalid", 400, bytes({ ...clone(valid), operationId: "not-a-uuid" })]);
      cases.push([{ ...clone(valid), expectedRevision: { epoch: IDS.epochA, revision: "01" } }, "workspace_input_invalid", 400, bytes({ ...clone(valid), expectedRevision: { epoch: IDS.epochA, revision: "01" } })]);
      cases.push([{ ...clone(valid), expectedRevision: { epoch: "bad", revision: "0" } }, "workspace_input_invalid", 400, bytes({ ...clone(valid), expectedRevision: { epoch: "bad", revision: "0" } })]);
      cases.push([{ ...clone(valid), request: [] }, "workspace_input_invalid", 400, bytes({ ...clone(valid), request: [] })]);
      cases.push([valid, "workspace_input_invalid", 400, bytes({ ...valid, kind: "content-recovery" })]);

      const oversized = clientEnvelope(base, publicModel("large"), 31);
      oversized.request.model.drafts[0].text = "x".repeat(70 * 1024);
      cases.push([oversized, "workspace_input_invalid", 400, bytes(oversized)]);

      const deep = clientEnvelope(base, publicModel("deep"), 32);
      let cursor = deep.request.model.profile;
      for (let index = 0; index < 24; index += 1) {
        cursor.child = {};
        cursor = cursor.child;
      }
      cases.push([deep, "workspace_input_invalid", 400, bytes(deep)]);

      const cyclic = clientEnvelope(base, publicModel("cycle"), 33);
      cyclic.request.model.profile.loop = cyclic.request.model;
      cases.push([cyclic, "workspace_input_invalid", 400, Buffer.from("{}")]);

      const sparse = clientEnvelope(base, publicModel("sparse"), 34);
      sparse.request.model.campaigns = new Array(2);
      sparse.request.model.campaigns[1] = { id: "late", brief: "late", status: "draft" };
      cases.push([sparse, "workspace_input_invalid", 400, bytes(sparse)]);

      const getter = clientEnvelope(base, publicModel("getter"), 35);
      Object.defineProperty(getter.request.model.profile, "derived", {
        enumerable: true,
        get() { return "unsafe"; }
      });
      cases.push([getter, "workspace_input_invalid", 400, bytes(valid)]);

      const beforeRequests = fake.state.requests.length;
      const beforeMutations = fake.state.mutations;
      for (const [input, code, status, raw] of cases) {
        await rejectsCode(() => adapter.commitClient(userContext(), base, input, raw), code, status);
      }
      assert.equal(fake.state.requests.length, beforeRequests);
      assert.equal(fake.state.mutations, beforeMutations);
    });

    await scenario("foreign valid epoch conflicts only after an authorized database check", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const loaded = await adapter.readUser(userContext());
      const foreign = {
        ...loaded,
        revision: { epoch: IDS.epochB, revision: loaded.revision.revision }
      };
      const input = clientEnvelope(foreign, publicModel("foreign-epoch"), 36);
      const before = fake.state.requests.length;
      await rejectsCode(
        () => adapter.commitClient(userContext(), foreign, input, bytes(input)),
        "workspace_revision_conflict",
        409
      );
      assert.ok(fake.state.requests.length > before);
      assert.equal(currentRow(fake.state).revision, "0");
    });

    await scenario("private-field aliases and nonprojection top-level data are rejected before transport", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const forbidden = [
        "authentication",
        "authUsers",
        "password",
        "device_credentials",
        "deviceSecret",
        "oauthState",
        "accessToken",
        "refresh_token",
        "providerCiphertext",
        "providerTokenCiphertext",
        "webhookBody",
        "webhookEvents",
        "billingPrivate",
        "stripeCustomerId",
        "serviceCredentials",
        "serviceRoleKey",
        "leaseToken",
        "workerLease",
        "commitReceipts",
        "privateReceipt",
        "workspaceId",
        "owner_user_id"
      ];
      const beforeRequests = fake.state.requests.length;
      const beforeMutations = fake.state.mutations;
      let index = 40;
      for (const name of forbidden) {
        const model = publicModel("private");
        model.campaigns[0].details = { [name]: SECRET_SENTINEL };
        const input = clientEnvelope(base, model, index);
        index += 1;
        await rejectsCode(
          () => adapter.commitClient(userContext(), base, input, bytes(input)),
          "workspace_input_invalid",
          400
        );
      }
      const extra = publicModel("extra");
      extra.queue = [];
      const extraInput = clientEnvelope(base, extra, index);
      await rejectsCode(
        () => adapter.commitClient(userContext(), base, extraInput, bytes(extraInput)),
        "workspace_input_invalid",
        400
      );
      assert.equal(fake.state.requests.length, beforeRequests);
      assert.equal(fake.state.mutations, beforeMutations);
      assert.doesNotMatch(JSON.stringify(privateStateSnapshot(fake.state)), new RegExp(SECRET_SENTINEL));
    });

    await scenario("client save uses canonical content hashing and one decimal revision increment", async () => {
      fake.resetData();
      const seeded = fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const model = publicModel("canonical");
      model.profile = { industry: "software", displayName: "canonical studio" };
      const input = clientEnvelope(base, model, 60);
      const before = fake.state.mutations;
      const result = await adapter.commitClient(userContext(), base, input, bytes(input));
      const row = currentRow(fake.state);
      assert.equal(result.currentRevision.revision, "1");
      assert.equal(result.committedRevision.revision, "1");
      assert.equal(row.revision, "1");
      assert.equal(fake.state.mutations - before, 1);
      assert.equal(row.content_hash, digest(model));
      assert.equal(row.created_at, seeded.created_at);
      assert.notEqual(row.updated_at, row.created_at);
      assert.doesNotMatch(JSON.stringify(result), /content_hash|request_hash|model|receipt/i);

      const reordered = clone(model);
      reordered.profile = { displayName: "canonical studio", industry: "software" };
      assert.equal(digest(reordered), row.content_hash);
    });

    await scenario("content recovery merges only approved public content sections", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const recovered = publicModel("recovered");
      const input = clientEnvelope(base, recovered, 61, "content-recovery");
      const result = await adapter.commitClient(userContext(), base, input, bytes(input));
      assert.equal(result.currentRevision.revision, "1");
      const row = currentRow(fake.state);
      assert.equal(row.model.campaigns[0].brief, "recovered");
      assert.deepEqual(row.model.profile, base.model.profile);
      assert.deepEqual(row.model.providerStates, base.model.providerStates);

      const nextBase = await adapter.readUser(userContext());
      const invalid = {
        expectedRevision: nextBase.revision,
        kind: "content-recovery",
        operationId: operationId(62),
        request: { sections: { providerStates: [] } }
      };
      await rejectsCode(
        () => adapter.commitClient(userContext(), nextBase, invalid, bytes(invalid)),
        "workspace_input_invalid",
        400
      );
    });

    async function assertOneWinner(label, firstAction, secondAction, beforeMutations) {
      races.push(label);
      fake.configureBarrier(RPC_ROOT + "commit_v2");
      const settled = await Promise.allSettled([firstAction(), secondAction()]);
      assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
      const loser = settled.find(item => item.status === "rejected");
      assert.equal(loser?.reason?.code, "workspace_revision_conflict");
      assert.equal(loser?.reason?.status, 409);
      assert.equal(fake.state.mutations - beforeMutations, 1);
      assert.equal(currentRow(fake.state).revision, "1");
    }

    await scenario("two independent client adapters racing from one base produce exactly one winner", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const first = adapterFor(baseUrl, fake.state);
      const second = adapterFor(baseUrl, fake.state);
      const firstBase = await first.readUser(userContext());
      const secondBase = await second.readUser(userContext());
      const one = clientEnvelope(firstBase, publicModel("client-one"), 70);
      const two = clientEnvelope(secondBase, publicModel("client-two"), 71);
      const before = fake.state.mutations;
      await assertOneWinner(
        "client/client",
        () => first.commitClient(userContext(), firstBase, one, bytes(one)),
        () => second.commitClient(userContext(), secondBase, two, bytes(two)),
        before
      );
    });

    await scenario("independent client and service adapters share the same durable CAS", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const client = adapterFor(baseUrl, fake.state);
      const service = adapterFor(baseUrl, fake.state);
      const clientBase = await client.readUser(userContext());
      const serviceBase = await service.readService(serviceContext("content"));
      const clientInput = clientEnvelope(clientBase, publicModel("client-race"), 72);
      const serviceInput = serviceEnvelope(
        serviceBase,
        "workspace.content-result",
        { collection: "campaigns", item: { id: "service-race", brief: "service", status: "ready" } },
        73
      );
      const before = fake.state.mutations;
      await assertOneWinner(
        "client/service",
        () => client.commitClient(userContext(), clientBase, clientInput, bytes(clientInput)),
        () => service.commitService(serviceContext("content"), serviceBase, serviceInput, bytes(serviceInput)),
        before
      );
    });

    await scenario("two independently claimed service jobs cannot overwrite each other", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const first = adapterFor(baseUrl, fake.state);
      const second = adapterFor(baseUrl, fake.state);
      const firstBase = await first.readService(serviceContext("content"));
      const secondBase = await second.readService(serviceContext("second"));
      const one = serviceEnvelope(
        firstBase,
        "workspace.content-result",
        { collection: "campaigns", item: { id: "job-one", brief: "one", status: "ready" } },
        74
      );
      const two = serviceEnvelope(
        secondBase,
        "workspace.content-result",
        { collection: "campaigns", item: { id: "job-two", brief: "two", status: "ready" } },
        75
      );
      const before = fake.state.mutations;
      await assertOneWinner(
        "service/service",
        () => first.commitService(serviceContext("content"), firstBase, one, bytes(one)),
        () => second.commitService(serviceContext("second"), secondBase, two, bytes(two)),
        before
      );
    });

    await scenario("recovery and normal save race through one revision boundary", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const first = adapterFor(baseUrl, fake.state);
      const second = adapterFor(baseUrl, fake.state);
      const recoveryBase = await first.readUser(userContext());
      const normalBase = await second.readUser(userContext());
      const recovery = clientEnvelope(recoveryBase, publicModel("recovery-race"), 76, "content-recovery");
      const normal = clientEnvelope(normalBase, publicModel("normal-race"), 77);
      const before = fake.state.mutations;
      await assertOneWinner(
        "recovery/normal",
        () => first.commitClient(userContext(), recoveryBase, recovery, bytes(recovery)),
        () => second.commitClient(userContext(), normalBase, normal, bytes(normal)),
        before
      );
    });

    await scenario("unrelated workspaces commit concurrently without sharing revisions", async () => {
      races.push("workspace-a/workspace-b");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA, "workspace-a", "0", IDS.epochA);
      fake.seedRow(IDS.workspaceB, IDS.ownerB, "workspace-b", "0", IDS.epochB);
      const first = adapterFor(baseUrl, fake.state);
      const second = adapterFor(baseUrl, fake.state);
      const contextA = userContext();
      const contextB = userContext(IDS.ownerB, "owner", IDS.workspaceB, IDS.ownerB);
      const baseA = await first.readUser(contextA);
      const baseB = await second.readUser(contextB);
      const one = clientEnvelope(baseA, publicModel("workspace-a-next"), 78);
      const two = clientEnvelope(baseB, publicModel("workspace-b-next"), 79);
      fake.configureBarrier(RPC_ROOT + "commit_v2");
      const before = fake.state.mutations;
      const results = await Promise.all([
        first.commitClient(contextA, baseA, one, bytes(one)),
        second.commitClient(contextB, baseB, two, bytes(two))
      ]);
      assert.equal(results.length, 2);
      assert.equal(fake.state.mutations - before, 2);
      assert.equal(currentRow(fake.state, IDS.workspaceA).revision, "1");
      assert.equal(currentRow(fake.state, IDS.workspaceB).revision, "1");
      assert.equal(currentRow(fake.state, IDS.workspaceA).persistence_epoch, IDS.epochA);
      assert.equal(currentRow(fake.state, IDS.workspaceB).persistence_epoch, IDS.epochB);
    });

    await scenario("lost request before commit is known uncommitted and exact retry commits once", async () => {
      receiptCases.push("lost-before-commit");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const input = clientEnvelope(base, publicModel("lost-before"), 80);
      const before = fake.state.mutations;
      fake.state.clientFault = {
        pathname: "/rpc/social_cues_workspace_commit_v2",
        phase: "before-request"
      };
      await rejectsCode(
        () => adapter.commitClient(userContext(), base, input, bytes(input)),
        "workspace_storage_unavailable",
        503
      );
      assert.equal(fake.state.mutations, before);
      const committed = await adapter.commitClient(userContext(), base, input, bytes(input));
      assert.equal(committed.replayed, false);
      assert.equal(fake.state.mutations - before, 1);
    });

    await scenario("lost response after commit reconciles through the durable receipt", async () => {
      receiptCases.push("lost-after-commit");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const input = clientEnvelope(base, publicModel("disconnect"), 81);
      const before = fake.state.mutations;
      fake.state.fault = "after-commit-disconnect";
      const result = await adapter.commitClient(userContext(), base, input, bytes(input));
      assert.equal(result.replayed, true);
      assert.equal(result.superseded, false);
      assert.equal(result.currentRevision.revision, "1");
      assert.equal(fake.state.mutations - before, 1);
    });

    await scenario("lost response after parsing also replays without another mutation", async () => {
      receiptCases.push("lost-after-response");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const input = clientEnvelope(base, publicModel("response-loss"), 82);
      const before = fake.state.mutations;
      fake.state.clientFault = {
        pathname: "/rpc/social_cues_workspace_commit_v2",
        phase: "after-response"
      };
      const result = await adapter.commitClient(userContext(), base, input, bytes(input));
      assert.equal(result.replayed, true);
      assert.equal(result.currentRevision.revision, "1");
      assert.equal(fake.state.mutations - before, 1);
    });

    await scenario("one operation ID rejects changed bytes kind actor and expected revision", async () => {
      receiptCases.push("operation-id-evidence-binding");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const input = clientEnvelope(base, publicModel("evidence"), 83);
      await adapter.commitClient(userContext(), base, input, bytes(input));
      const before = fake.state.mutations;

      await rejectsCode(
        () => adapter.commitClient(userContext(), base, input, bytes(input, 2)),
        "workspace_operation_id_reused",
        409
      );

      const changedKind = {
        expectedRevision: clone(base.revision),
        kind: "content-recovery",
        operationId: input.operationId,
        request: { sections: { campaigns: publicModel("changed-kind").campaigns } }
      };
      await rejectsCode(
        () => adapter.commitClient(userContext(), base, changedKind, bytes(changedKind)),
        "workspace_operation_id_reused",
        409
      );

      await rejectsCode(
        () => adapter.commitClient(userContext(IDS.adminA, "admin"), base, input, bytes(input)),
        "workspace_operation_id_reused",
        409
      );

      const current = await adapter.readUser(userContext());
      const changedRevision = { ...clone(input), expectedRevision: clone(current.revision) };
      await rejectsCode(
        () => adapter.commitClient(userContext(), current, changedRevision, bytes(changedRevision)),
        "workspace_operation_id_reused",
        409
      );
      assert.equal(fake.state.mutations, before);
    });

    await scenario("old receipt remains replayable and superseded after later commits", async () => {
      receiptCases.push("old-receipt-after-newer-write");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const first = adapterFor(baseUrl, fake.state);
      const originalBase = await first.readUser(userContext());
      const original = clientEnvelope(originalBase, publicModel("receipt-one"), 84);
      const firstResult = await first.commitClient(userContext(), originalBase, original, bytes(original));

      const second = adapterFor(baseUrl, fake.state);
      const nextBase = await second.readUser(userContext());
      const next = clientEnvelope(nextBase, publicModel("receipt-two"), 85);
      const secondResult = await second.commitClient(userContext(), nextBase, next, bytes(next));
      assert.equal(secondResult.currentRevision.revision, "2");

      const restarted = adapterFor(baseUrl, fake.state);
      const replay = await restarted.commitClient(userContext(), originalBase, original, bytes(original));
      assert.equal(replay.replayed, true);
      assert.equal(replay.superseded, true);
      assert.deepEqual(replay.committedRevision, firstResult.committedRevision);
      assert.equal(replay.committedRevision.revision, "1");
      assert.equal(replay.currentRevision.revision, "2");
      assert.doesNotMatch(JSON.stringify(replay), /receipt-one|receipt-two|model/);
      assert.equal(fake.state.receipts.size, 2);
    });

    await scenario("adapter restart reads acknowledged revision and replays exact bytes", async () => {
      receiptCases.push("adapter-restart-replay");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const first = adapterFor(baseUrl, fake.state);
      const base = await first.readUser(userContext());
      const input = clientEnvelope(base, publicModel("restart"), 86);
      const committed = await first.commitClient(userContext(), base, input, bytes(input));
      const before = fake.state.mutations;
      const second = adapterFor(baseUrl, fake.state);
      const loaded = await second.readUser(userContext());
      assert.deepEqual(loaded.revision, committed.currentRevision);
      const replay = await second.commitClient(userContext(), base, input, bytes(input));
      assert.equal(replay.replayed, true);
      assert.equal(fake.state.mutations, before);
    });

    await scenario("malformed zero and multiple commit returns reconcile committed state", async () => {
      for (const [fault, number] of [
        ["malformed-success-after", 87],
        ["zero-success-after", 88],
        ["multiple-success-after", 89]
      ]) {
        receiptCases.push(fault);
        fake.resetData();
        fake.seedRow(IDS.workspaceA, IDS.ownerA);
        const adapter = adapterFor(baseUrl, fake.state);
        const base = await adapter.readUser(userContext());
        const input = clientEnvelope(base, publicModel(fault), number);
        const before = fake.state.mutations;
        fake.state.fault = fault;
        const result = await adapter.commitClient(userContext(), base, input, bytes(input));
        assert.equal(result.replayed, true);
        assert.equal(result.currentRevision.revision, "1");
        assert.equal(fake.state.mutations - before, 1);
      }
    });

    await scenario("transaction and grant failures write nothing while irreconcilable outcomes stay unknown", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      let base = await adapter.readUser(userContext());
      let input = clientEnvelope(base, publicModel("transaction-failure"), 90);
      let before = fake.state.mutations;
      fake.state.fault = "transaction-exception";
      await rejectsCode(
        () => adapter.commitClient(userContext(), base, input, bytes(input)),
        "workspace_storage_unavailable",
        503
      );
      assert.equal(fake.state.mutations, before);

      fake.state.fault = "denied-grant";
      await rejectsCode(
        () => adapter.readUser(userContext()),
        "workspace_authorization_failed",
        403
      );

      base = await adapter.readUser(userContext());
      input = clientEnvelope(base, publicModel("unknown"), 91);
      before = fake.state.mutations;
      fake.state.clientFault = {
        pathname: "/rpc/social_cues_workspace_commit_v2",
        phase: "after-response"
      };
      fake.state.fault = "reconcile-reset";
      const error = await rejectsCode(
        () => adapter.commitClient(userContext(), base, input, bytes(input)),
        "workspace_commit_unknown",
        503
      );
      assert.equal(error.commitStatus, "unknown");
      assert.equal(fake.state.mutations - before, 1);
      assert.doesNotMatch(JSON.stringify(error), /unknown studio|request_hash|content_hash/i);
    });

    await scenario("all closed service intents use only the service-job request lane", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const beforeRequests = fake.state.requests.length;
      const cases = [
        [
          "content",
          "workspace.content-result",
          { collection: "drafts", item: { id: "content-result", status: "ready", text: "generated" } },
          100
        ],
        [
          "provider",
          "workspace.provider-state-result",
          { provider: "twitch", state: { accountId: "public-twitch", status: "limited" } },
          101
        ],
        [
          "worker",
          "workspace.worker-result",
          {
            jobId: IDS.jobWorker,
            result: { status: "ready", text: "render complete" },
            target: { collection: "drafts", id: "worker-result" }
          },
          102
        ],
        [
          "repair",
          "workspace.system-repair",
          {
            patch: { preferences: { locale: "en-US", timezone: "America/New_York" } },
            repairId: operationId(902)
          },
          103
        ]
      ];
      for (const [jobName, intent, request, number] of cases) {
        const context = serviceContext(jobName);
        const base = await adapter.readService(context);
        const input = serviceEnvelope(base, intent, request, number);
        const result = await adapter.commitService(context, base, input, bytes(input));
        assert.equal(result.commitStatus, "committed");
      }
      const requests = fake.state.requests.slice(beforeRequests);
      assert.ok(requests.length >= 8);
      assert.ok(requests.every(item => item.lane === "service-job"));
      assert.equal(currentRow(fake.state).revision, "4");
      assert.equal(currentRow(fake.state).model.preferences.timezone, "America/New_York");
      assert.equal(currentRow(fake.state).model.providerStates.some(item => item.provider === "twitch"), true);
    });

    await scenario("service jobs reject mixed identity wrong leases wrong intent and generic writes", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const context = serviceContext("worker");
      const base = await adapter.readService(context);
      const validRequest = {
        jobId: IDS.jobWorker,
        result: { status: "ready", text: "bounded" },
        target: { collection: "drafts", id: "bounded-worker" }
      };
      const generic = serviceEnvelope(base, "server-write", { model: publicModel("generic") }, 110);
      await rejectsCode(
        () => adapter.commitService(context, base, generic, bytes(generic)),
        "workspace_writer_unclassified",
        400
      );

      const mixed = { ...context, role: "owner" };
      const worker = serviceEnvelope(base, "workspace.worker-result", validRequest, 111);
      await rejectsCode(
        () => adapter.commitService(mixed, base, worker, bytes(worker)),
        "workspace_authorization_failed",
        403
      );

      const wrongLease = { ...context, leaseId: IDS.leaseB };
      await rejectsCode(
        () => adapter.commitService(wrongLease, base, worker, bytes(worker)),
        "workspace_authorization_failed",
        403
      );

      const removedMembership = clone(fake.state.memberships.get(keyFor(IDS.workspaceA, IDS.ownerA))[0]);
      removedMembership.membershipStatus = "removed";
      fake.state.memberships.set(keyFor(IDS.workspaceA, IDS.ownerA), [removedMembership]);
      await rejectsCode(
        () => adapter.commitService(context, base, worker, bytes(worker)),
        "workspace_authorization_failed",
        403
      );
      removedMembership.membershipStatus = "active";
      fake.state.memberships.set(keyFor(IDS.workspaceA, IDS.ownerA), [removedMembership]);

      const wrongJobRequest = {
        ...clone(worker),
        operationId: operationId(112),
        request: { ...validRequest, jobId: IDS.jobContent }
      };
      await rejectsCode(
        () => adapter.commitService(context, base, wrongJobRequest, bytes(wrongJobRequest)),
        "workspace_input_invalid",
        400
      );

      const rawModel = {
        ...clone(worker),
        operationId: operationId(113),
        request: { model: publicModel("raw") }
      };
      await rejectsCode(
        () => adapter.commitService(context, base, rawModel, bytes(rawModel)),
        "workspace_input_invalid",
        400
      );
      assert.equal(currentRow(fake.state).revision, "0");
    });

    await scenario("receipt ledger stores only bounded private evidence and unique result revisions", async () => {
      receiptCases.push("durable-private-ledger");
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      let base = await adapter.readUser(userContext());
      for (const [label, number] of [["ledger-one", 120], ["ledger-two", 121]]) {
        const input = clientEnvelope(base, publicModel(label), number);
        await adapter.commitClient(userContext(), base, input, bytes(input));
        base = await adapter.readUser(userContext());
      }
      const receipts = [...fake.state.receipts.values()];
      assert.equal(receipts.length, 2);
      assert.deepEqual(receipts.map(item => item.result_revision), ["1", "2"]);
      assert.equal(new Set(receipts.map(item => item.result_revision)).size, 2);
      for (const receipt of receipts) {
        assert.deepEqual(Object.keys(receipt).sort(), [
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
        assert.match(receipt.request_hash, HASH);
        assert.match(receipt.content_hash, HASH);
        assert.doesNotMatch(JSON.stringify(receipt), /ledger-one|ledger-two|model|credential|token/i);
      }
    });

    await scenario("secret sentinels never enter transport logs database receipts results errors stdout or stderr", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const base = await adapter.readUser(userContext());
      const model = publicModel("secret-check");
      model.profile.details = { access_token: SECRET_SENTINEL };
      const input = clientEnvelope(base, model, 130);
      const capturedOut = [];
      const capturedErr = [];
      const originalOut = process.stdout.write;
      const originalErr = process.stderr.write;
      let error;
      try {
        process.stdout.write = function (chunk) {
          capturedOut.push(String(chunk));
          return true;
        };
        process.stderr.write = function (chunk) {
          capturedErr.push(String(chunk));
          return true;
        };
        error = await rejectsCode(
          () => adapter.commitClient(userContext(), base, input, bytes(input)),
          "workspace_input_invalid",
          400
        );
      } finally {
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
      }
      const surfaces = [
        privateStateSnapshot(fake.state),
        fake.state.requests,
        fake.state.audit,
        error,
        capturedOut,
        capturedErr
      ];
      for (const surface of surfaces) {
        assert.doesNotMatch(JSON.stringify(surface), new RegExp(SECRET_SENTINEL));
      }
      assert.equal(currentRow(fake.state).revision, "0");
    });

    await scenario("request functions stay structurally distinct and no timestamp is a concurrency token", async () => {
      fake.resetData();
      fake.seedRow(IDS.workspaceA, IDS.ownerA);
      const adapter = adapterFor(baseUrl, fake.state);
      const userBase = await adapter.readUser(userContext());
      const userInput = clientEnvelope(userBase, publicModel("user-lane"), 140);
      await adapter.commitClient(userContext(), userBase, userInput, bytes(userInput));

      const serviceBase = await adapter.readService(serviceContext("content"));
      const serviceInput = serviceEnvelope(
        serviceBase,
        "workspace.content-result",
        { collection: "activity", item: { id: "lane-proof", kind: "proof", label: "service" } },
        141
      );
      await adapter.commitService(serviceContext("content"), serviceBase, serviceInput, bytes(serviceInput));
      assert.ok(fake.state.requests.some(item => item.lane === "user-jwt"));
      assert.ok(fake.state.requests.some(item => item.lane === "service-job"));
      assert.ok(fake.state.audit.every(item => !Object.hasOwn(item, "created_at") && !Object.hasOwn(item, "updated_at")));
      assert.ok(fake.state.requests.every(item => item.method === "POST" && item.pathname.startsWith(RPC_ROOT)));
    });

    assert.equal(fake.state.externalRequests, 0);
    assert.equal(fake.state.nonLoopbackRequests, 0);
    assert.equal(fake.state.providerRequests, 0);
    assert.equal(fake.state.productionMutations, 0);
    assert.ok(fake.state.requests.length > 0);
  } finally {
    await close(fake.server);
    cleanupComplete = fake.server.listening === false;
  }

  assert.equal(cleanupComplete, true);
  const evidence = {
    cleanupComplete,
    contractVersion: CONTRACT_VERSION,
    externalRequests: fake.state.externalRequests,
    nonLoopbackRequests: fake.state.nonLoopbackRequests,
    productionMutations: fake.state.productionMutations,
    providerRequests: fake.state.providerRequests,
    raceCases: races,
    receiptCaseCount: receiptCases.length,
    receiptCases,
    scenarioCount: scenarios.length,
    scenarios,
    status: "PASS"
  };
  await mkdir(new URL("./.tmp/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("./.tmp/hosted-workspace-persistence-v2.json.log", import.meta.url),
    JSON.stringify(evidence, null, 2) + "\n",
    "utf8"
  );
  console.log(JSON.stringify({
    ok: true,
    cleanupComplete,
    scenarios: scenarios.length,
    races: races.length,
    receipts: receiptCases.length,
    externalRequests: fake.state.externalRequests,
    productionMutations: fake.state.productionMutations
  }));
});
