import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { test } from "node:test";
import { createHostedWorkspacePersistence } from "./hosted-workspace-persistence.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const userA = {
  id: "11111111-1111-4111-8111-111111111111",
  supabaseUserId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
};
const userB = {
  id: "22222222-2222-4222-8222-222222222222",
  supabaseUserId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
};
const fixedNow = Date.parse("2026-09-07T02:00:00.123Z");

function workspaceModel(user, label = "initial") {
  return {
    version: "contract",
    currentUser: { id: user.id },
    workspace: { id: user.workspaceId, ownerUserId: user.id, name: `${label} workspace` },
    workspaces: [{ id: user.workspaceId, ownerUserId: user.id, name: `${label} workspace` }],
    campaigns: [{ id: `${label}-campaign`, workspaceId: user.workspaceId, ownerUserId: user.id, brief: label }],
    quickPosts: [],
    actions: [],
    proof: [],
    activity: [],
    connectedAccounts: [],
    workspaceModel: { version: 1, source: "contract" }
  };
}

function bindModel(model, user) {
  const result = clone(model);
  result.currentUser = { id: user.id };
  result.workspace = { ...(result.workspace || {}), id: user.workspaceId, ownerUserId: user.id };
  result.workspaces = [clone(result.workspace)];
  for (const key of ["campaigns", "quickPosts", "actions", "proof", "activity", "connectedAccounts"]) {
    result[key] = (Array.isArray(result[key]) ? result[key] : []).map(item => ({
      ...item,
      workspaceId: user.workspaceId,
      ownerUserId: user.id
    }));
  }
  delete result.persistence;
  delete result.receipt;
  return result;
}

function createFakePostgrest() {
  const state = {
    rows: new Map(),
    requests: [],
    patchMode: "normal",
    failReads: false,
    nonLoopbackRequests: 0
  };

  function json(res, status, value = null) {
    const body = value === null ? "" : JSON.stringify(value);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }

  async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  }

  function filter(url, name) {
    const value = url.searchParams.get(name) || "";
    return value.startsWith("eq.") ? value.slice(3) : "";
  }

  function matches(row, url) {
    return (!filter(url, "workspace_id") || row.workspace_id === filter(url, "workspace_id"))
      && (!filter(url, "owner_user_id") || row.owner_user_id === filter(url, "owner_user_id"))
      && (!filter(url, "updated_at") || row.updated_at === filter(url, "updated_at"));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    state.requests.push({ method: req.method, pathname: url.pathname, search: url.search, prefer: String(req.headers.prefer || "") });
    if (url.pathname !== "/rest/v1/workspace_models") return json(res, 404, { error: "fixture route unavailable" });
    if (req.method === "GET") {
      if (state.failReads) return json(res, 503, { error: "fixture storage unavailable" });
      return json(res, 200, [...state.rows.values()].filter(row => matches(row, url)).map(clone));
    }
    if (req.method === "POST") {
      const values = await body(req);
      for (const row of Array.isArray(values) ? values : [values]) {
        if (!state.rows.has(row.workspace_id)) state.rows.set(row.workspace_id, clone(row));
      }
      return json(res, 201);
    }
    if (req.method === "PATCH") {
      const update = await body(req);
      if (state.patchMode === "before-error") return json(res, 503, { error: "fixture write unavailable" });
      const matched = [...state.rows.values()].filter(row => matches(row, url));
      if (state.patchMode === "zero") return json(res, 200, []);
      const updated = matched.map(row => {
        const next = { ...row, ...clone(update) };
        state.rows.set(next.workspace_id, next);
        return clone(next);
      });
      if (state.patchMode === "after-disconnect") {
        req.socket.destroy();
        return;
      }
      if (state.patchMode === "duplicate" && updated[0]) return json(res, 200, [updated[0], clone(updated[0])]);
      return json(res, 200, updated);
    }
    return json(res, 405, { error: "fixture method unavailable" });
  });

  return { server, state };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

function requestFor(baseUrl, state) {
  return async (pathname, options = {}) => {
    const url = new URL(`/rest/v1${pathname}`, baseUrl);
    if (url.hostname !== "127.0.0.1") state.nonLoopbackRequests += 1;
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      body: options.body,
      signal: AbortSignal.timeout(2_000)
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) throw new Error(`fixture ${response.status}`);
    return parsed;
  };
}

function adapterFor(baseUrl, state, now = fixedNow) {
  return createHostedWorkspacePersistence({
    request: requestFor(baseUrl, state),
    snapshot: bindModel,
    mergeClient: (request, _current, user) => bindModel(request, user),
    recoverClient: (request, current, user) => bindModel({ ...current, ...request }, user),
    clock: () => now
  });
}

test("hosted CAS adapter remains an inert contract boundary", async () => {
  const serverSource = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(serverSource, /hosted-workspace-persistence\.mjs/);
  assert.doesNotMatch(serverSource, /createHostedWorkspacePersistence/);
});

function rowFor(user, label = "initial", updatedAt = "2026-09-07T02:00:00.123000+00:00") {
  return {
    workspace_id: user.workspaceId,
    owner_user_id: user.id,
    model: workspaceModel(user, label),
    updated_at: updatedAt
  };
}

async function load(adapter, user) {
  const row = await adapter.readRow(user);
  assert.ok(row);
  const model = clone(row.model);
  adapter.attach(model, row, user);
  return model;
}

function envelope(model, revision, operationId = randomUUID(), kind = "model-save") {
  return { kind, operationId, expectedRevision: clone(revision), request: clone(model) };
}

function bytes(value, space = 0) {
  return Buffer.from(JSON.stringify(value, null, space));
}

async function rejectsCode(action, code, status = null) {
  await assert.rejects(action, error => {
    assert.equal(error?.code, code);
    if (status !== null) assert.equal(error?.status, status);
    return true;
  });
}

test("hosted workspace persistence adapter contract", async t => {
  const fake = createFakePostgrest();
  const baseUrl = await listen(fake.server);
  try {
    await t.test("valid rows expose stable opaque conditional revisions", async () => {
      fake.state.rows.clear();
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const first = adapterFor(baseUrl, fake.state);
      const firstModel = await load(first, userA);
      const firstCapability = first.capability(firstModel, userA);
      assert.equal(firstCapability.conditionalSave, true);
      assert.match(firstCapability.revision.revision, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(firstCapability.revision.revision, /2026|09|07/);

      const equivalent = rowFor(userA, "equivalent", "2026-09-07T02:00:00.123Z");
      const second = adapterFor(baseUrl, fake.state);
      const equivalentModel = clone(equivalent.model);
      second.attach(equivalentModel, equivalent, userA);
      assert.deepEqual(second.capability(equivalentModel, userA).revision, firstCapability.revision);
    });

    await t.test("missing and invalid row revisions never advertise conditional save", async () => {
      const adapter = adapterFor(baseUrl, fake.state);
      const missing = workspaceModel(userA, "missing");
      adapter.markAbsent(missing, userA);
      assert.deepEqual(adapter.capability(missing, userA), { conditionalSave: false });

      const invalidRow = rowFor(userA, "invalid", "not-a-revision");
      const invalid = clone(invalidRow.model);
      adapter.attach(invalid, invalidRow, userA);
      assert.deepEqual(adapter.capability(invalid, userA), { conditionalSave: false });
      await rejectsCode(() => adapter.serverSave(invalid, userA), "workspace_revision_invalid", 409);
    });

    await t.test("reads are bound to both authenticated owner and workspace", async () => {
      fake.state.rows.clear();
      fake.state.requests.length = 0;
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const adapter = adapterFor(baseUrl, fake.state);
      assert.ok(await adapter.readRow(userA));
      assert.equal(await adapter.readRow({ ...userA, id: userB.id, supabaseUserId: userB.id }), null);
      const reads = fake.state.requests.filter(item => item.method === "GET");
      assert.ok(reads.every(item => item.search.includes(`workspace_id=eq.${userA.workspaceId}`)));
      assert.ok(reads.some(item => item.search.includes(`owner_user_id=eq.${userA.id}`)));
      assert.ok(reads.some(item => item.search.includes(`owner_user_id=eq.${userB.id}`)));
    });

    await t.test("strict envelopes reject bare, missing, malformed and extra input without writes", async () => {
      fake.state.rows.clear();
      fake.state.requests.length = 0;
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const adapter = adapterFor(baseUrl, fake.state);
      const model = await load(adapter, userA);
      const revision = adapter.capability(model, userA).revision;
      const valid = envelope(workspaceModel(userA, "valid"), revision);
      const cases = [
        [workspaceModel(userA, "bare"), "workspace_revision_required", 428],
        [{ kind: "model-save", operationId: randomUUID(), request: {} }, "workspace_revision_required", 428],
        [{ ...valid, extra: true }, "workspace_input_invalid", 400],
        [{ ...valid, kind: "unknown" }, "workspace_input_invalid", 400],
        [{ ...valid, operationId: "not-a-uuid" }, "workspace_input_invalid", 400],
        [{ ...valid, expectedRevision: { epoch: revision.epoch, revision: "bad" } }, "workspace_revision_invalid", 400],
        [{ ...valid, request: [] }, "workspace_input_invalid", 400]
      ];
      for (const [input, code, status] of cases) {
        await rejectsCode(() => adapter.clientSave(userA, model, input, bytes(input)), code, status);
      }
      assert.equal(fake.state.requests.filter(item => item.method === "PATCH").length, 0);
    });

    await t.test("atomic save filters exact owner, workspace and prior timestamp", async () => {
      fake.state.rows.clear();
      fake.state.requests.length = 0;
      fake.state.patchMode = "normal";
      const original = rowFor(userA);
      fake.state.rows.set(userA.workspaceId, original);
      const adapter = adapterFor(baseUrl, fake.state, fixedNow);
      const model = await load(adapter, userA);
      const revision = adapter.capability(model, userA).revision;
      const next = workspaceModel(userA, "saved");
      const operation = envelope(next, revision);
      const saved = await adapter.clientSave(userA, model, operation, bytes(operation));
      assert.equal(saved.receipt.replayed, false);
      assert.equal(saved.receipt.superseded, false);
      assert.equal(saved.model.campaigns[0].brief, "saved");
      const stored = fake.state.rows.get(userA.workspaceId);
      assert.equal(stored.updated_at, "2026-09-07T02:00:00.124Z");
      const patch = fake.state.requests.findLast(item => item.method === "PATCH");
      assert.ok(patch.search.includes(`workspace_id=eq.${userA.workspaceId}`));
      assert.ok(patch.search.includes(`owner_user_id=eq.${userA.id}`));
      assert.ok(patch.search.includes("updated_at=eq.2026-09-07T02%3A00%3A00.123000%2B00%3A00"));
      assert.equal(patch.prefer, "return=representation,handling=strict,max-affected=1");
      const privateReceipt = stored.model.workspaceModel[adapter.privateReceiptKey];
      assert.deepEqual(Object.keys(privateReceipt).sort(), ["expectedRevision", "operationId", "requestDigest", "resultRevision", "status"]);
      assert.equal(privateReceipt.status, "committed");
      assert.equal(saved.model.workspaceModel[adapter.privateReceiptKey], undefined);
      assert.equal(saved.row.model.workspaceModel[adapter.privateReceiptKey], undefined);
    });

    await t.test("two clients cannot overwrite a newer workspace revision", async () => {
      fake.state.rows.clear();
      fake.state.patchMode = "normal";
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const adapter = adapterFor(baseUrl, fake.state);
      const first = await load(adapter, userA);
      const second = await load(adapter, userA);
      const baseRevision = adapter.capability(first, userA).revision;
      const firstOperation = envelope(workspaceModel(userA, "first"), baseRevision);
      await adapter.clientSave(userA, first, firstOperation, bytes(firstOperation));
      const staleOperation = envelope(workspaceModel(userA, "stale"), adapter.capability(second, userA).revision);
      await rejectsCode(() => adapter.clientSave(userA, second, staleOperation, bytes(staleOperation)), "workspace_revision_conflict", 409);
      assert.equal(fake.state.rows.get(userA.workspaceId).model.campaigns[0].brief, "first");
    });

    await t.test("identical lost-response retry replays but byte or revision mismatch fails", async () => {
      fake.state.rows.clear();
      fake.state.patchMode = "normal";
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const firstAdapter = adapterFor(baseUrl, fake.state);
      const firstModel = await load(firstAdapter, userA);
      const prior = firstAdapter.capability(firstModel, userA).revision;
      const operation = envelope(workspaceModel(userA, "retry"), prior);
      const raw = bytes(operation);
      await firstAdapter.clientSave(userA, firstModel, operation, raw);

      const restarted = adapterFor(baseUrl, fake.state);
      const reloaded = await load(restarted, userA);
      const patchCount = fake.state.requests.filter(item => item.method === "PATCH").length;
      const replay = await restarted.clientSave(userA, reloaded, operation, raw);
      assert.equal(replay.receipt.replayed, true);
      assert.equal(fake.state.requests.filter(item => item.method === "PATCH").length, patchCount);
      await rejectsCode(() => restarted.clientSave(userA, reloaded, operation, bytes(operation, 2)), "workspace_operation_id_reused", 409);
      const changedExpected = { ...operation, expectedRevision: restarted.capability(reloaded, userA).revision };
      await rejectsCode(() => restarted.clientSave(userA, reloaded, changedExpected, bytes(changedExpected)), "workspace_operation_id_reused", 409);
    });

    await t.test("a disconnected PostgREST response reconciles an already committed operation", async () => {
      fake.state.rows.clear();
      fake.state.patchMode = "after-disconnect";
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const adapter = adapterFor(baseUrl, fake.state);
      const model = await load(adapter, userA);
      const operation = envelope(workspaceModel(userA, "uncertain"), adapter.capability(model, userA).revision);
      const result = await adapter.clientSave(userA, model, operation, bytes(operation));
      assert.equal(result.receipt.replayed, true);
      assert.equal(result.model, undefined);
      assert.equal(result.row.model.campaigns[0].brief, "uncertain");
      assert.equal(result.row.model.workspaceModel[adapter.privateReceiptKey], undefined);
      fake.state.patchMode = "normal";
    });

    await t.test("server and client writes share one CAS boundary", async () => {
      fake.state.rows.clear();
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const adapter = adapterFor(baseUrl, fake.state);
      const serverModel = await load(adapter, userA);
      const clientModel = await load(adapter, userA);
      serverModel.campaigns[0].brief = "server";
      await adapter.serverSave(serverModel, userA);
      const clientOperation = envelope(workspaceModel(userA, "client-stale"), adapter.capability(clientModel, userA).revision);
      await rejectsCode(() => adapter.clientSave(userA, clientModel, clientOperation, bytes(clientOperation)), "workspace_revision_conflict", 409);
      assert.equal(fake.state.rows.get(userA.workspaceId).model.campaigns[0].brief, "server");
    });

    await t.test("bootstrap is explicit, insert-only and followed by an owner-bound read", async () => {
      fake.state.rows.clear();
      fake.state.requests.length = 0;
      const adapter = adapterFor(baseUrl, fake.state);
      const model = workspaceModel(userA, "bootstrap");
      adapter.markAbsent(model, userA);
      assert.equal(adapter.capability(model, userA).conditionalSave, false);
      const row = await adapter.bootstrap(model, userA);
      assert.equal(row.workspace_id, userA.workspaceId);
      const post = fake.state.requests.find(item => item.method === "POST");
      assert.equal(post.prefer, "resolution=ignore-duplicates,return=minimal");
      assert.ok(fake.state.requests.some(item => item.method === "GET" && item.search.includes(`owner_user_id=eq.${userA.id}`)));
      const loaded = clone(row.model);
      adapter.attach(loaded, row, userA);
      assert.equal(adapter.capability(loaded, userA).conditionalSave, true);
    });

    await t.test("bootstrap clock failures are normalized before any write", async () => {
      fake.state.rows.clear();
      fake.state.requests.length = 0;
      const adapter = adapterFor(baseUrl, fake.state, Number.POSITIVE_INFINITY);
      const model = workspaceModel(userA, "invalid-clock");
      adapter.markAbsent(model, userA);
      await rejectsCode(() => adapter.bootstrap(model, userA), "workspace_storage_unavailable", 503);
      assert.equal(fake.state.requests.length, 0);
      assert.equal(fake.state.rows.size, 0);
    });

    await t.test("bootstrap cannot replace a row owned by another account", async () => {
      fake.state.rows.clear();
      const foreign = { ...rowFor(userB, "foreign"), workspace_id: userA.workspaceId };
      fake.state.rows.set(userA.workspaceId, foreign);
      const adapter = adapterFor(baseUrl, fake.state);
      const model = workspaceModel(userA, "bootstrap-attack");
      adapter.markAbsent(model, userA);
      await rejectsCode(() => adapter.bootstrap(model, userA), "workspace_authorization_failed", 403);
      assert.deepEqual(fake.state.rows.get(userA.workspaceId), foreign);
    });

    await t.test("storage failures and ambiguous write results fail closed", async () => {
      fake.state.rows.clear();
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const adapter = adapterFor(baseUrl, fake.state);
      fake.state.failReads = true;
      await rejectsCode(() => adapter.readRow(userA), "workspace_storage_unavailable", 503);
      fake.state.failReads = false;
      const model = await load(adapter, userA);
      const operation = envelope(workspaceModel(userA, "not-written"), adapter.capability(model, userA).revision);
      fake.state.patchMode = "before-error";
      await assert.rejects(() => adapter.clientSave(userA, model, operation, bytes(operation)), error => {
        assert.equal(error.code, "workspace_commit_unknown");
        assert.equal(error.commitStatus, "unknown");
        return true;
      });
      assert.equal(fake.state.rows.get(userA.workspaceId).model.campaigns[0].brief, "initial");
      fake.state.patchMode = "duplicate";
      await assert.rejects(() => adapter.clientSave(userA, model, operation, bytes(operation)), error => {
        assert.equal(error.code, "workspace_commit_unknown");
        assert.equal(error.commitStatus, "unknown");
        return true;
      });
      fake.state.patchMode = "normal";
    });

    await t.test("workspace and owner state cannot be reused across tenants", async () => {
      fake.state.rows.clear();
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      fake.state.rows.set(userB.workspaceId, rowFor(userB));
      const adapter = adapterFor(baseUrl, fake.state);
      const modelA = await load(adapter, userA);
      const modelB = await load(adapter, userB);
      const revisionA = adapter.capability(modelA, userA).revision;
      const spoofed = workspaceModel(userB, "spoofed");
      const operation = envelope(spoofed, revisionA);
      const saved = await adapter.clientSave(userA, modelA, operation, bytes(operation));
      assert.equal(saved.model.workspace.id, userA.workspaceId);
      assert.equal(saved.model.workspace.ownerUserId, userA.id);
      assert.ok(saved.model.campaigns.every(item => item.workspaceId === userA.workspaceId && item.ownerUserId === userA.id));
      assert.equal(fake.state.rows.get(userB.workspaceId).model.campaigns[0].brief, "initial");
      await rejectsCode(() => adapter.clientSave(userA, modelB, operation, bytes(operation)), "workspace_writer_unclassified", 403);
    });

    await t.test("content recovery uses the same revision and receipt protocol", async () => {
      fake.state.rows.clear();
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const adapter = adapterFor(baseUrl, fake.state);
      const model = await load(adapter, userA);
      const operation = envelope({ campaigns: workspaceModel(userA, "recovered").campaigns }, adapter.capability(model, userA).revision, randomUUID(), "content-recovery");
      const result = await adapter.clientSave(userA, model, operation, bytes(operation));
      assert.equal(result.model.campaigns[0].brief, "recovered");
      assert.equal(result.receipt.replayed, false);
    });

    await t.test("persisted rows survive adapter restart with public receipt material stripped", async () => {
      fake.state.rows.clear();
      fake.state.rows.set(userA.workspaceId, rowFor(userA));
      const first = adapterFor(baseUrl, fake.state);
      const model = await load(first, userA);
      const operation = envelope(workspaceModel(userA, "restart"), first.capability(model, userA).revision);
      const committed = await first.clientSave(userA, model, operation, bytes(operation));
      const second = adapterFor(baseUrl, fake.state);
      const reloaded = await load(second, userA);
      assert.equal(reloaded.campaigns[0].brief, "restart");
      assert.equal(reloaded.workspaceModel[second.privateReceiptKey], undefined);
      assert.deepEqual(second.capability(reloaded, userA).revision, committed.receipt.currentRevision);
    });

    assert.equal(fake.state.nonLoopbackRequests, 0);
    assert.ok(fake.state.requests.length > 0);
    assert.ok(fake.state.requests.every(item => item.pathname === "/rest/v1/workspace_models"));
  } finally {
    await close(fake.server);
    assert.equal(fake.server.listening, false);
  }
});
