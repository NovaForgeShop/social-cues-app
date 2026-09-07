import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openWorkspaceContentStore } from "./workspace-content-persistence.mjs";

const test = process.argv[1] === fileURLToPath(import.meta.url) ? nodeTest : () => {};
export const tempRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp");
export const seed = {
  actorId: "bootstrap",
  shared: { owners: { first: "alice", second: "bob" }, retained: { value: "SYNTHETIC unrelated registry" } },
  workspaces: {
    first: { campaigns: [{ id: "campaign-a", brief: "SYNTHETIC original" }], proof: [], activeCampaignId: "campaign-a" },
    second: { campaigns: [{ id: "campaign-b", brief: "SYNTHETIC untouched" }], proof: [], activeCampaignId: "campaign-b" }
  }
};

export function options(dataDir, extra = {}) {
  return {
    dataDir,
    // Fixture policy only: the real adapter must use canonical application ownership.
    authorize: ({ actorId, workspaceId, action, shared }) => action === "initialize"
      ? actorId === "bootstrap" : shared.owners[workspaceId] === actorId,
    validateContent: ({ content }) => content && Object.keys(content).sort().join(",") === "activeCampaignId,campaigns,proof"
      && Array.isArray(content.campaigns) && Array.isArray(content.proof)
      && content.campaigns.every(row => typeof row.id === "string" && typeof row.brief === "string")
      && content.campaigns.some(row => row.id === content.activeCampaignId),
    mutations: {
      edit: ({ content, request }) => {
        assert.equal(typeof request.brief, "string");
        content.campaigns[0].brief = request.brief;
        return content;
      },
      append: ({ content, request }) => {
        content.campaigns[0].brief += request.suffix;
        return content;
      }
    },
    ...extra
  };
}

export async function ownedDirectory(label = "case") {
  await fs.mkdir(tempRoot, { recursive: true });
  return fs.mkdtemp(path.join(tempRoot, "p10-" + label + "-"));
}

export async function removeOwnedDirectory(directory) {
  const resolvedRoot = await fs.realpath(tempRoot), resolved = await fs.realpath(directory);
  assert.equal(path.dirname(resolved), resolvedRoot);
  assert.ok(path.basename(resolved).startsWith("p10-"));
  assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
  await fs.rm(resolved, { recursive: true });
  await assert.rejects(fs.access(resolved), { code: "ENOENT" });
}

export async function setup(t, extra = {}) {
  const directory = await ownedDirectory();
  let store;
  t.after(async () => {
    await store?.close();
    await removeOwnedDirectory(directory);
  });
  store = await openWorkspaceContentStore(options(directory, extra));
  await store.initialize(structuredClone(seed));
  return { directory, store };
}

export const readFirst = store => store.read({ workspaceId: "first", actorId: "alice" });
export function change(revision, operationId = "operation-one", request = { brief: "SYNTHETIC edited" }, extra = {}) {
  return { workspaceId: "first", actorId: "alice", kind: "edit", operationId, expectedRevision: revision, request, ...extra };
}
export async function rejectsCode(action, code, commitStatus = "not_committed") {
  await assert.rejects(async () => action(), error => error.code === code && error.commitStatus === commitStatus);
}

test("fresh per-workspace server tokens and public projections exclude private state", async t => {
  const { store } = await setup(t);
  const a = await readFirst(store), b = await store.read({ workspaceId: "second", actorId: "bob" });
  assert.equal(a.revision.revision, "0");
  assert.match(a.revision.epoch, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.revision.epoch, b.revision.epoch);
  assert.deepEqual(Object.keys(a).sort(), ["content", "revision", "workspaceId"]);
  assert.deepEqual(a.content, seed.workspaces.first);
  assert.doesNotMatch(JSON.stringify(a), /receipts|requestHash|retained|bootstrap/);
  a.content.campaigns[0].brief = "SYNTHETIC caller-only mutation";
  a.revision.revision = "99";
  assert.deepEqual((await readFirst(store)).content, seed.workspaces.first);
});

test("same-base competing commits have exactly one winner and preserve other workspace/shared data", async t => {
  const { store, directory } = await setup(t);
  const base = (await readFirst(store)).revision;
  const results = await Promise.allSettled([
    store.commit(change(base, "winner-one", { brief: "SYNTHETIC A" })),
    store.commit(change(base, "winner-two", { brief: "SYNTHETIC B" }))
  ]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.find(item => item.status === "rejected").reason.code, "workspace_revision_conflict");
  const saved = await readFirst(store);
  assert.equal(saved.revision.revision, "1");
  assert.equal(saved.content.campaigns[0].brief, results.find(item => item.status === "fulfilled").value.content.campaigns[0].brief);
  assert.deepEqual((await store.read({ workspaceId: "second", actorId: "bob" })).content, seed.workspaces.second);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "model.json"), "utf8")).shared, seed.shared);
});

test("independent workspace writes retain independent revisions and content", async t => {
  const { store } = await setup(t);
  const a = await readFirst(store), b = await store.read({ workspaceId: "second", actorId: "bob" });
  await store.commit(change(a.revision));
  await store.commit(change(b.revision, "second-op", { brief: "SYNTHETIC second edit" }, { workspaceId: "second", actorId: "bob" }));
  assert.equal((await readFirst(store)).content.campaigns[0].brief, "SYNTHETIC edited");
  assert.equal((await store.read({ workspaceId: "second", actorId: "bob" })).revision.revision, "1");
});

test("missing, malformed, foreign and stale revision preconditions never write", async t => {
  const { store, directory } = await setup(t);
  const before = await fs.readFile(path.join(directory, "model.json"));
  const base = (await readFirst(store)).revision;
  const missing = change(base); delete missing.expectedRevision;
  await rejectsCode(() => store.commit(missing), "workspace_revision_required");
  await rejectsCode(() => store.commit(change({ ...base, revision: 0 })), "workspace_revision_invalid");
  const b = await store.read({ workspaceId: "second", actorId: "bob" });
  await rejectsCode(() => store.commit(change(b.revision)), "workspace_revision_conflict");
  await rejectsCode(() => store.commit(change({ ...base, revision: "99" })), "workspace_revision_conflict");
  assert.deepEqual(await fs.readFile(path.join(directory, "model.json")), before);
});

test("authorization is mandatory for reads, writes and receipt replay; token grants no access", async t => {
  const { store, directory } = await setup(t);
  const base = (await readFirst(store)).revision;
  const request = change(base);
  await store.commit(request);
  const before = await fs.readFile(path.join(directory, "model.json"));
  await rejectsCode(() => store.read({ workspaceId: "first", actorId: "bob" }), "workspace_authorization_failed");
  await rejectsCode(() => store.commit({ ...request, actorId: "bob" }), "workspace_authorization_failed");
  assert.deepEqual(await fs.readFile(path.join(directory, "model.json")), before);
});

test("original request is captured before queuing and canonical key order gives idempotent replay", async t => {
  const { store } = await setup(t);
  const base = (await readFirst(store)).revision;
  const original = change(base, "captured", { brief: "SYNTHETIC captured", annotation: { b: 2, a: 1 } });
  const pending = store.commit(original);
  original.request.brief = "SYNTHETIC changed after submission";
  original.expectedRevision.revision = "999";
  const committed = await pending;
  assert.equal(committed.content.campaigns[0].brief, "SYNTHETIC captured");
  const same = change({ epoch: committed.committedRevision.epoch, revision: "0" }, "captured", {
    annotation: { a: 1, b: 2 }, brief: "SYNTHETIC captured"
  });
  const replay = await store.commit(same);
  assert.equal(replay.replayed, true);
  assert.equal(replay.superseded, false);
  assert.deepEqual(replay.committedRevision, committed.committedRevision);
  assert.equal((await readFirst(store)).revision.revision, "1");
});

test("receipt reuse binds actor, kind, original request and expected revision", async t => {
  const { store } = await setup(t, { authorize: () => true });
  const original = change((await readFirst(store)).revision);
  const saved = await store.commit(original);
  for (const altered of [
    { ...original, actorId: "other-authorized-actor" },
    { ...original, kind: "append" },
    { ...original, request: { brief: "SYNTHETIC different" } },
    { ...original, expectedRevision: saved.committedRevision }
  ]) await rejectsCode(() => store.commit(altered), "workspace_operation_id_reused");
  assert.equal((await readFirst(store)).revision.revision, "1");
});

test("superseded receipt never returns old content as the current workspace", async t => {
  const { store } = await setup(t);
  const original = change((await readFirst(store)).revision, "old", { brief: "SYNTHETIC old commit" });
  const first = await store.commit(original);
  await store.commit(change(first.committedRevision, "later", { brief: "SYNTHETIC later commit" }));
  const replay = await store.commit(original);
  assert.equal(replay.replayed, true);
  assert.equal(replay.superseded, true);
  assert.equal(replay.committedRevision.revision, "1");
  assert.equal(replay.currentRevision.revision, "2");
  assert.equal(Object.hasOwn(replay, "content"), false);
  assert.doesNotMatch(JSON.stringify(replay), /actorId|requestHash|receipts/);
  assert.equal((await readFirst(store)).content.campaigns[0].brief, "SYNTHETIC later commit");
});

test("mutations use fresh target content and cannot reach other workspace/shared/private metadata", async t => {
  const inputs = [];
  const { store } = await setup(t, { mutations: { append: input => {
    inputs.push(structuredClone(input));
    input.content.campaigns[0].brief += input.request.suffix;
    input.request.suffix = "SYNTHETIC handler mutation";
    return input.content;
  } } });
  const first = await store.commit(change((await readFirst(store)).revision, "one", { suffix: " + one" }, { kind: "append" }));
  const secondRequest = change(first.committedRevision, "two", { suffix: " + two" }, { kind: "append" });
  await store.commit(secondRequest);
  const retry = await store.commit(secondRequest);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].content.campaigns[0].brief, "SYNTHETIC original + one");
  assert.deepEqual(Object.keys(inputs[0]).sort(), ["actorId", "content", "request", "workspaceId"]);
  assert.equal(retry.content.campaigns[0].brief, "SYNTHETIC original + one + two");
});

test("invalid mutation output or unsupported kinds leave the file and revision intact", async t => {
  const { store, directory } = await setup(t, { mutations: { invalid: () => ({ receipts: "not supported content" }), boom: () => { throw new Error("private diagnostic"); } } });
  const original = change((await readFirst(store)).revision);
  const bytes = await fs.readFile(path.join(directory, "model.json"));
  await rejectsCode(() => store.commit({ ...original, kind: "invalid" }), "workspace_content_invalid");
  await rejectsCode(() => store.commit({ ...original, kind: "boom" }), "workspace_mutation_invalid");
  await rejectsCode(() => store.commit(original), "workspace_input_invalid");
  assert.deepEqual(await fs.readFile(path.join(directory, "model.json")), bytes);
});

test("non-JSON and accessor requests reject without executing getters or writing", async t => {
  const { store, directory } = await setup(t);
  const base = (await readFirst(store)).revision;
  const before = await fs.readFile(path.join(directory, "model.json"));
  let getterExecuted = false;
  const accessor = Object.defineProperty({}, "brief", { enumerable: true, get() { getterExecuted = true; return "value"; } });
  const cycle = {}; cycle.self = cycle;
  for (const request of [accessor, cycle, { value: undefined }, { value: Infinity }, { value: 1n }, new Date(), [, "hole"]]) {
    await rejectsCode(() => store.commit(change(base, "bad", request)), "workspace_input_invalid");
  }
  assert.equal(getterExecuted, false);
  assert.deepEqual(await fs.readFile(path.join(directory, "model.json")), before);
});

test("callbacks are required and asynchronous authorization cannot accidentally authorize", async t => {
  await rejectsCode(() => openWorkspaceContentStore({ dataDir: tempRoot }), "workspace_store_options_invalid");
  const directory = await ownedDirectory();
  const store = await openWorkspaceContentStore(options(directory, { authorize: async () => true }));
  t.after(async () => { await store.close(); await removeOwnedDirectory(directory); });
  await rejectsCode(() => store.initialize(seed), "workspace_authorization_failed");
  await assert.rejects(fs.access(path.join(directory, "model.json")), { code: "ENOENT" });
});

test("empty bootstrap never creates storage; denied and valid nonempty initialization retain their contracts", async t => {
  const directory = await ownedDirectory("empty-bootstrap");
  let allowed = false, authorizationCalls = 0, validationCalls = 0;
  const store = await openWorkspaceContentStore(options(directory, {
    authorize: () => { authorizationCalls += 1; return allowed; },
    validateContent: () => { validationCalls += 1; return allowed; }
  }));
  t.after(async () => { await store.close(); await removeOwnedDirectory(directory); });
  const modelPath = path.join(directory, "model.json");
  const empty = { actorId: "denied-bootstrap", shared: { marker: "synthetic" }, workspaces: {} };
  const rejectEmpty = async () => {
    await assert.rejects(store.initialize(empty), error => error.code === "workspace_input_invalid"
      && error.status === 400 && error.commitStatus === "not_committed");
    await assert.rejects(fs.access(modelPath), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(directory), [".workspace-content.lock"]);
  };
  await rejectEmpty();
  assert.equal(authorizationCalls, 0);
  assert.equal(validationCalls, 0);
  await rejectsCode(() => store.initialize(seed), "workspace_authorization_failed");
  await assert.rejects(fs.access(modelPath), { code: "ENOENT" });
  assert.equal(authorizationCalls, 1);
  assert.equal(validationCalls, 0);

  allowed = true;
  await rejectEmpty();
  assert.equal(authorizationCalls, 1);
  assert.equal(validationCalls, 0);
  assert.equal((await store.initialize(seed)).initialized, true);
  assert.equal(authorizationCalls, 3);
  assert.equal(validationCalls, 2);
  assert.deepEqual((await readFirst(store)).content, seed.workspaces.first);

  const before = await fs.readFile(modelPath);
  const callsBefore = { authorizationCalls, validationCalls };
  allowed = false;
  await rejectsCode(() => store.initialize(empty), "workspace_already_initialized");
  await rejectsCode(() => store.initialize(seed), "workspace_already_initialized");
  assert.deepEqual(await fs.readFile(modelPath), before);
  assert.deepEqual({ authorizationCalls, validationCalls }, callsBefore);
});
