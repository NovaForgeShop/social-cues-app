import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openLocalWorkspacePersistence } from "./local-workspace-persistence.mjs";
import { convertSyntheticLocalWorkspace } from "./scripts/convert-synthetic-local-workspace.mjs";
const user = { id: "owner-one", workspaceId: "workspace-one", email: "one@example.test" };
const other = { id: "owner-two", workspaceId: "workspace-two", email: "two@example.test" };
const seed = { workspaces: [], authUsers: [], campaigns: [], proof: [], deviceSessions: [], settings: {}, activeCampaignId: "" };
const workspace = user => ({ id: user.workspaceId, ownerUserId: user.id, createdAt: "2026-09-01T00:00:00Z" });
async function setup(t, fault) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "p11-adapter-"));
  const store = await openLocalWorkspacePersistence({ dataDir, seed, fault, mergeClient: (request, current) => ({ ...current, ...request }), recoverClient: () => { throw new Error("not used"); } });
  t.after(async () => { await store.close(); await rm(dataDir, { recursive: true }); });
  for (const actor of [user, other]) {
    const model = await store.load();
    model.workspaces.push(workspace(actor)); model.workspace = workspace(actor); model.authUsers.push(actor);
    await store.save(model, actor, "signup");
  }
  const view = async actor => store.view(await store.load(), actor.workspaceId);
  return { store, dataDir, view };
}
test("stale non-content writer merges only its actual changes; newer content and other workspace survive", async t => {
  const { store, view } = await setup(t);
  const stale = await view(user), current = await view(user);
  current.campaigns.push({ id: "campaign-one", ownerUserId: user.id, workspaceId: user.workspaceId, title: "newer" });
  await store.save(current, user);
  stale.deviceSessions.push({ id: "device-one", userId: user.id, lastSeenAt: "synthetic" });
  await store.save(stale, user);
  assert.equal((await view(user)).campaigns[0].title, "newer");
  assert.equal((await view(user)).deviceSessions.length, 1);
  assert.equal((await view(other)).workspaces.length, 2);
});
test("stale content writer conflicts; untracked and wrong-owner writers cannot bypass the boundary", async t => {
  const { store, view, dataDir } = await setup(t);
  const stale = await view(user), fresh = await view(user);
  fresh.settings = { changed: "first" }; await store.save(fresh, user);
  stale.settings = { changed: "second" };
  const before = await readFile(path.join(dataDir, "model.json"));
  await assert.rejects(store.save(stale, user), { code: "workspace_revision_conflict" });
  await assert.rejects(store.save(structuredClone(fresh), user), { code: "workspace_writer_unclassified" });
  await assert.rejects(store.save(fresh, { ...user, id: other.id }), { code: "workspace_authorization_failed" });
  assert.deepEqual(await readFile(path.join(dataDir, "model.json")), before);
});
test("shared concurrent same-field changes conflict without undoing either workspace", async t => {
  const { store, view } = await setup(t);
  const a = await view(user), b = await view(user);
  a.authUsers[0].name = "first"; await store.save(a, user);
  b.authUsers[0].name = "second";
  await assert.rejects(store.save(b, user), { code: "workspace_shared_state_conflict" });
  assert.equal((await view(user)).authUsers[0].name, "first");
});

test("browser snapshots cannot replace shared authentication, provider or billing registry", async t => {
  const { store, view, dataDir } = await setup(t);
  const model = await view(user);
  model.integrations = { preserved: "synthetic-provider-state" };
  model.billing = { preserved: "synthetic-billing-state" };
  await store.save(model, user);
  const before = JSON.parse(await readFile(path.join(dataDir, "model.json"), "utf8"));
  const result = await store.clientSave(user, { operationId: "synthetic-shared-injection", kind: "model-save",
    expectedRevision: store.capability(model, user.workspaceId).revision,
    request: { authUsers: [], deviceSessions: [], integrations: {}, billing: {}, brandKit: { name: "workspace brand" } } });
  const after = JSON.parse(await readFile(path.join(dataDir, "model.json"), "utf8"));
  assert.deepEqual(after.shared, before.shared);
  assert.deepEqual(after.workspaces[other.workspaceId], before.workspaces[other.workspaceId]);
  assert.equal(result.model.brandKit.name, "workspace brand");
});

test("valid storage envelope with invalid application identity is preserved and refused on read and reopen", async t => {
  const { store, dataDir } = await setup(t);
  const file = path.join(dataDir, "model.json");
  const document = JSON.parse(await readFile(file, "utf8"));
  document.shared.authUsers = [];
  const invalid = JSON.stringify(document);
  await writeFile(file, invalid); // Explicit disposable corruption injection.
  await assert.rejects(store.load(), { code: "workspace_storage_unavailable" });
  await store.close();
  await assert.rejects(openLocalWorkspacePersistence({ dataDir, seed, mergeClient: () => {}, recoverClient: () => {} }), { code: "workspace_storage_unavailable" });
  assert.equal(await readFile(file, "utf8"), invalid);
  await assert.rejects(access(path.join(dataDir, ".workspace-content.lock")), { code: "ENOENT" });
});
test("foreign-workspace content cannot be changed by a tracked owner write", async t => {
  const { store, view } = await setup(t);
  const a = await view(user);
  a.proof.push({ id: "foreign", workspaceId: other.workspaceId, ownerUserId: other.id });
  await assert.rejects(store.save(a, user), { code: "workspace_authorization_failed" });
});
test("injected post-rename uncertainty reconciles the identical original application operation", async t => {
  let armed = false;
  const { store, view } = await setup(t, phase => { if (armed && phase === "after-rename") { armed = false; throw new Error("synthetic fault"); } });
  const model = await view(user);
  const operation = { operationId: "synthetic-operation-one", kind: "model-save", expectedRevision: store.capability(model, user.workspaceId).revision, request: { settings: { saved: true } } };
  armed = true;
  await assert.rejects(store.clientSave(user, operation), { code: "workspace_commit_unknown", commitStatus: "unknown" });
  const result = await store.clientSave(user, operation);
  assert.equal(result.receipt.replayed, true);
  assert.equal(result.model.settings.saved, true);
});
test("corrupt or legacy local documents are rejected unchanged, never reset to seed", async t => {
  for (const value of ["{", JSON.stringify(seed)]) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "p11-invalid-"));
    t.after(() => rm(dataDir, { recursive: true }));
    await writeFile(path.join(dataDir, "model.json"), value);
    await assert.rejects(openLocalWorkspacePersistence({ dataDir, seed, mergeClient: () => {}, recoverClient: () => {} }), { code: "workspace_storage_unavailable" });
    assert.equal(await readFile(path.join(dataDir, "model.json"), "utf8"), value);
    await assert.rejects(access(path.join(dataDir, ".workspace-content.lock")), { code: "ENOENT" });
  }
});
test("explicit offline synthetic copy preserves both owners, content and registry; active or existing paths reject", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p11-conversion-")), temp = path.join(root, ".tmp");
  await mkdir(temp); t.after(() => rm(root, { recursive: true }));
  const source = path.join(temp, "legacy.json"), target = path.join(temp, "converted");
  const model = { ...seed, syntheticFixture: "social-cues.p11-offline-copy.v1", workspaces: [workspace(user), workspace(other)], workspace: workspace(user),
    authUsers: [user, other], deviceSessions: [{ id: "preserved-device", userId: user.id }], retainedRegistry: { sentinel: "preserve" },
    campaigns: [user, other].map(actor => ({ id: "campaign-" + actor.id, ownerUserId: actor.id, workspaceId: actor.workspaceId, title: actor.id })) };
  const original = JSON.stringify(model); await writeFile(source, original);
  await assert.rejects(convertSyntheticLocalWorkspace({ source, target }), /explicit_disposable/);
  await writeFile(path.join(temp, "pilot.lock"), "synthetic locked source");
  await assert.rejects(convertSyntheticLocalWorkspace({ source, target, syntheticCopy: true }), /offline/);
  await rm(path.join(temp, "pilot.lock"));
  const result = await convertSyntheticLocalWorkspace({ source, target, syntheticCopy: true });
  assert.equal(result.workspaceCount, 2); assert.equal(result.sourceUnchanged, true);
  assert.equal(await readFile(source, "utf8"), original);
  const doc = JSON.parse(await readFile(path.join(target, "model.json"), "utf8"));
  assert.deepEqual(doc.shared.authUsers, model.authUsers); assert.deepEqual(doc.shared.workspaces, model.workspaces);
  assert.deepEqual(doc.shared.deviceSessions, model.deviceSessions); assert.deepEqual(doc.shared.retainedRegistry, model.retainedRegistry);
  assert.deepEqual(doc.workspaces[other.workspaceId].content.campaigns, [model.campaigns[1]]);
  await assert.rejects(convertSyntheticLocalWorkspace({ source, target, syntheticCopy: true }), /must_not_exist/);
});
