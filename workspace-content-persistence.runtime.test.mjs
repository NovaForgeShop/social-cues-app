import assert from "node:assert/strict";
import { test as nodeTest, after } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openWorkspaceContentStore } from "./workspace-content-persistence.mjs";
import { options, seed, tempRoot, ownedDirectory, removeOwnedDirectory, readFirst, change, rejectsCode } from "./workspace-content-persistence.contract.test.mjs";

const childMode = process.argv[2] === "--storage-child";
const test = childMode ? () => {} : nodeTest;
const thisFile = fileURLToPath(import.meta.url);
const evidence = { platform: process.platform, node: process.version, directories: [], children: [], scenarios: [] };
if (!childMode) after(async () => {
  evidence.cleanupComplete = evidence.directories.every(item => item.removed)
    && evidence.children.every(item => item.absent && item.outputEmpty);
  await fs.mkdir(tempRoot, { recursive: true });
  await fs.writeFile(path.join(tempRoot, "P10-runtime-evidence-" + Date.now() + ".json"), JSON.stringify(evidence, null, 2));
  assert.equal(evidence.cleanupComplete, true, "all owned directories and child processes cleaned up");
});

if (childMode) {
  let store;
  try {
    store = await openWorkspaceContentStore(options(process.argv[3]));
    process.send({ type: "ready" });
    process.on("message", async message => {
      try {
        if (!["initialize", "read", "commit", "close"].includes(message.method)) throw new Error("invalid command");
        const result = await store[message.method](message.input);
        // Synthetic transport-loss injection: do not deliver the committed receipt.
        if (message.dropResponse) process.send({ id: message.id, replySuppressed: true });
        else process.send({ id: message.id, result });
        if (message.method === "close") process.disconnect();
      } catch (error) {
        process.send({ id: message.id, error: { code: error.code || "unexpected", commitStatus: error.commitStatus } });
      }
    });
  } catch (error) {
    process.send({ type: "open-failed", code: error.code || "unexpected" }, () => process.disconnect());
  }
}

async function timeout(promise, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + " timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const directory = await ownedDirectory("runtime");
  const record = { directory, removed: false };
  evidence.directories.push(record);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await removeOwnedDirectory(directory);
    record.removed = true;
  });
  return { directory, keep: close => cleanup.push(close), modelPath: path.join(directory, "model.json"),
    lockPath: path.join(directory, ".workspace-content.lock") };
}

async function open(f, extra = {}, initialize = true) {
  const store = await openWorkspaceContentStore(options(f.directory, extra));
  f.keep(() => store.close());
  if (initialize) await store.initialize(structuredClone(seed));
  return store;
}

function pidAbsent(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
}

async function startChild(f) {
  const allowed = new Set(["systemroot", "windir", "path", "pathext", "comspec", "temp", "tmp", "home", "userprofile"]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase())));
  const child = spawn(process.execPath, [thisFile, "--storage-child", f.directory], {
    env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const record = { pid: child.pid, absent: false, outputEmpty: false };
  evidence.children.push(record);
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const ended = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const call = async (method, input, dropResponse = false) => {
    const id = randomUUID();
    let listener;
    const response = new Promise((resolve, reject) => {
      listener = message => { if (message.id === id) resolve(message); };
      child.on("message", listener);
      child.send({ id, method, input, dropResponse }, error => { if (error) reject(error); });
    });
    try { return await timeout(response, "child operation"); }
    finally { child.off("message", listener); }
  };
  const stop = async () => {
    if (child.connected) {
      try { await call("close"); }
      catch { child.kill(); }
    }
    try { await timeout(ended, "child close"); }
    catch { child.kill("SIGKILL"); await timeout(ended, "forced child close"); }
    assert.ok(pidAbsent(child.pid), "task-owned child process absent");
    assert.equal(output, "", "child emitted no unexpected stdout/stderr");
    Object.assign(record, await ended, { absent: true, outputEmpty: true });
  };
  f.keep(stop);
  const ready = await timeout(new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
  }), "child startup");
  return { ready, call, stop, pid: child.pid, ended, kill: () => child.kill() };
}

test("only confirmed absent storage initializes; existing state is not reseeded", async t => {
  const f = await fixture(t), store = await open(f, {}, false);
  await assert.rejects(fs.access(f.modelPath), { code: "ENOENT" });
  await rejectsCode(() => readFirst(store), "workspace_storage_unavailable");
  await store.initialize(seed);
  const before = await fs.readFile(f.modelPath);
  await rejectsCode(() => store.initialize({ ...seed, shared: {} }), "workspace_already_initialized");
  assert.deepEqual(await fs.readFile(f.modelPath), before);
  await store.close();
  const reopened = await open(f, {}, false);
  assert.equal((await readFirst(reopened)).revision.revision, "0");
});

test("actual separate process restart preserves revision, content and durable receipt", async t => {
  const f = await fixture(t), bootstrap = await open(f);
  const base = (await readFirst(bootstrap)).revision;
  await bootstrap.close();
  const first = await startChild(f);
  assert.equal(first.ready.type, "ready");
  const request = change(base, "restart-operation", { suffix: " + exactly once" }, { kind: "append" });
  const saved = (await first.call("commit", request)).result;
  assert.equal(saved.committedRevision.revision, "1");
  await first.stop();
  assert.equal((await first.ended).code, 0);
  const second = await startChild(f);
  assert.equal(second.ready.type, "ready");
  assert.notEqual(second.pid, first.pid);
  const read = (await second.call("read", { workspaceId: "first", actorId: "alice" })).result;
  assert.deepEqual(read.revision, saved.committedRevision);
  assert.deepEqual(read.content, saved.content);
  const replay = (await second.call("commit", request)).result;
  assert.equal(replay.replayed, true);
  assert.equal(replay.content.campaigns[0].brief, "SYNTHETIC original + exactly once");
  const stale = await second.call("commit", change(base, "stale-new-operation"));
  assert.equal(stale.error.code, "workspace_revision_conflict");
  await second.stop();
  assert.equal((await second.ended).code, 0);
  evidence.scenarios.push({ name: "actual-normal-process-restart", firstPid: first.pid, secondPid: second.pid,
    revision: saved.committedRevision.revision, contentHash: saved.contentHash, receiptReplayed: replay.replayed });
  await assert.rejects(fs.access(f.lockPath), { code: "ENOENT" });
});

test("a live writer excludes a second process, including an alternate realpath spelling", async t => {
  const f = await fixture(t), store = await open(f);
  const rejected = await startChild(f);
  assert.equal(rejected.ready.type, "open-failed");
  assert.equal(rejected.ready.code, "workspace_writer_busy");
  await rejected.stop();
  await rejectsCode(() => openWorkspaceContentStore(options(path.join(f.directory, "."))), "workspace_writer_busy");
  const alias = path.join(f.directory, "synthetic-directory-alias");
  await fs.symlink(f.directory, alias, process.platform === "win32" ? "junction" : "dir");
  try { await rejectsCode(() => openWorkspaceContentStore(options(alias)), "workspace_writer_busy"); }
  finally { await fs.unlink(alias); }
  await store.close();
  const admitted = await startChild(f);
  assert.equal(admitted.ready.type, "ready");
  await admitted.stop();
});

test("an unclean process stop leaves its lock; the module never steals it", async t => {
  const f = await fixture(t), bootstrap = await open(f);
  await bootstrap.close();
  const owner = await startChild(f);
  assert.equal(owner.ready.type, "ready");
  owner.kill();
  await timeout(owner.ended, "killed writer exit");
  assert.ok(pidAbsent(owner.pid));
  const lockBytes = await fs.readFile(f.lockPath);
  await rejectsCode(() => openWorkspaceContentStore(options(f.directory)), "workspace_writer_busy");
  assert.deepEqual(await fs.readFile(f.lockPath), lockBytes);
  // Only this test's offline cleanup removes the retained marker with its directory.
});

test("corrupt JSON, invalid UTF-8 and legacy server documents are preserved on failed open", async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from("{broken"), Buffer.from('{"version":"legacy-server-model"}'),
    Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')])]) {
    await fs.writeFile(f.modelPath, bytes);
    await rejectsCode(() => openWorkspaceContentStore(options(f.directory)), "workspace_storage_unavailable");
    assert.deepEqual(await fs.readFile(f.modelPath), bytes);
    await assert.rejects(fs.access(f.lockPath), { code: "ENOENT" });
  }
});

test("a real non-file read failure is not mistaken for absence or seeded over", async t => {
  const f = await fixture(t), store = await open(f);
  const original = await fs.readFile(f.modelPath);
  const backup = path.join(f.directory, "synthetic-original.json");
  await fs.rename(f.modelPath, backup);
  await fs.mkdir(f.modelPath);
  await rejectsCode(() => readFirst(store), "workspace_storage_unavailable");
  await rejectsCode(() => store.initialize(seed), "workspace_storage_unavailable");
  assert.equal((await fs.stat(f.modelPath)).isDirectory(), true);
  assert.deepEqual(await fs.readFile(backup), original);
});

test("injected read error before commit is definite failure and leaves storage unchanged", async t => {
  const f = await fixture(t);
  let armed = false;
  const store = await open(f, { fault: stage => {
    if (armed && stage === "before-read") { armed = false; throw Object.assign(new Error("synthetic read failure"), { code: "EIO" }); }
  } });
  const request = change((await readFirst(store)).revision), before = await fs.readFile(f.modelPath);
  armed = true;
  await rejectsCode(() => store.commit(request), "workspace_storage_unavailable");
  assert.deepEqual(await fs.readFile(f.modelPath), before);
  assert.equal((await store.commit(request)).committedRevision.revision, "1");
});

for (const stage of ["before-temp-open", "before-temp-write", "before-temp-sync", "before-rename"]) {
  test("injected " + stage + " failure is not committed and retry is safe", async t => {
    const f = await fixture(t);
    let armed = false;
    const store = await open(f, { fault: point => {
      if (armed && point === stage) { armed = false; throw Object.assign(new Error("synthetic storage failure"), { code: "ENOSPC" }); }
    } });
    const request = change((await readFirst(store)).revision), before = await fs.readFile(f.modelPath);
    armed = true;
    await rejectsCode(() => store.commit(request), "workspace_storage_unavailable");
    assert.deepEqual(await fs.readFile(f.modelPath), before);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), [".workspace-content.lock", "model.json"]);
    assert.equal((await store.commit(request)).committedRevision.revision, "1");
  });
}

test("actual rename rejection is conservative unknown, never fallback success", async t => {
  const f = await fixture(t);
  let armed = false;
  const backup = path.join(f.directory, "synthetic-before-rename.json");
  const store = await open(f, { fault: async stage => {
    if (armed && stage === "before-rename") {
      armed = false;
      await fs.rename(f.modelPath, backup);
      await fs.mkdir(f.modelPath);
    }
  } });
  const request = change((await readFirst(store)).revision), before = await fs.readFile(f.modelPath);
  armed = true;
  await rejectsCode(() => store.commit(request), "workspace_commit_unknown", "unknown");
  assert.deepEqual(await fs.readFile(backup), before);
  assert.equal((await fs.stat(f.modelPath)).isDirectory(), true);
  await rejectsCode(() => readFirst(store), "workspace_storage_unavailable");
});

for (const stage of ["after-rename", "before-directory-sync", "before-response"]) {
  test("injected " + stage + " failure reports unknown; receipt reconciles exactly once", async t => {
    const f = await fixture(t);
    let armed = false;
    const store = await open(f, { fault: point => {
      if (armed && point === stage) { armed = false; throw new Error("synthetic late failure"); }
    } });
    const request = change((await readFirst(store)).revision, "unknown-operation", { suffix: " + once" }, { kind: "append" });
    armed = true;
    await rejectsCode(() => store.commit(request), "workspace_commit_unknown", "unknown");
    const read = await readFirst(store);
    assert.equal(read.revision.revision, "1");
    assert.equal(read.content.campaigns[0].brief, "SYNTHETIC original + once");
    const replay = await store.commit(request);
    assert.equal(replay.replayed, true);
    assert.equal(replay.committedRevision.revision, "1");
    assert.equal((await readFirst(store)).revision.revision, "1");
  });
}

test("suppressed child reply reconciles after a real normal process restart", async t => {
  const f = await fixture(t), bootstrap = await open(f);
  const request = change((await readFirst(bootstrap)).revision, "lost-response", { suffix: " + once" }, { kind: "append" });
  await bootstrap.close();
  const first = await startChild(f);
  const lost = await first.call("commit", request, true);
  assert.equal(lost.replySuppressed, true);
  assert.equal(Object.hasOwn(lost, "result"), false);
  await first.stop();
  const second = await startChild(f);
  const result = (await second.call("commit", request)).result;
  assert.equal(result.replayed, true);
  assert.equal(result.committedRevision.revision, "1");
  assert.equal(result.content.campaigns[0].brief, "SYNTHETIC original + once");
  await second.stop();
  evidence.scenarios.push({ name: "injected-ipc-response-loss-with-actual-restart", firstPid: first.pid, secondPid: second.pid,
    revision: result.committedRevision.revision, receiptReplayed: result.replayed });
});

test("a superseded receipt remains historical after an actual process restart", async t => {
  const f = await fixture(t), bootstrap = await open(f);
  const request = change((await readFirst(bootstrap)).revision, "historical-operation");
  const first = await bootstrap.commit(request);
  await bootstrap.commit(change(first.committedRevision, "later-operation", { brief: "SYNTHETIC later saved content" }));
  await bootstrap.close();
  const child = await startChild(f);
  const result = (await child.call("commit", request)).result;
  assert.equal(result.superseded, true);
  assert.equal(result.committedRevision.revision, "1");
  assert.equal(result.currentRevision.revision, "2");
  assert.equal(Object.hasOwn(result, "content"), false);
  const current = (await child.call("read", { workspaceId: "first", actorId: "alice" })).result;
  assert.equal(current.content.campaigns[0].brief, "SYNTHETIC later saved content");
  await child.stop();
});

test("corrupt receipt metadata fails closed without changing the file", async t => {
  const f = await fixture(t), store = await open(f);
  await store.commit(change((await readFirst(store)).revision));
  await store.close();
  const document = JSON.parse(await fs.readFile(f.modelPath, "utf8"));
  document.workspaces.first.receipts["operation-one"].contentHash = "0".repeat(64);
  const bytes = JSON.stringify(document);
  await fs.writeFile(f.modelPath, bytes);
  await rejectsCode(() => openWorkspaceContentStore(options(f.directory)), "workspace_storage_unavailable");
  assert.equal(await fs.readFile(f.modelPath, "utf8"), bytes);
});

test("decimal revisions beyond Number safe integer survive increment, serialization and reopen", async t => {
  const f = await fixture(t), bootstrap = await open(f);
  await bootstrap.close();
  // Offline synthetic fixture, not evidence of having performed quadrillions of writes.
  const document = JSON.parse(await fs.readFile(f.modelPath, "utf8"));
  document.workspaces.first.revision = "9007199254740993";
  await fs.writeFile(f.modelPath, JSON.stringify(document));
  const store = await open(f, {}, false);
  const request = change((await readFirst(store)).revision);
  const saved = await store.commit(request);
  assert.equal(saved.committedRevision.revision, "9007199254740994");
  await store.close();
  const reopened = await open(f, {}, false);
  assert.equal((await readFirst(reopened)).revision.revision, "9007199254740994");
  assert.equal((await reopened.commit(request)).replayed, true);
});

test("close drains an admitted transaction and rejects later operations", async t => {
  const f = await fixture(t), store = await open(f);
  const pending = store.commit(change((await readFirst(store)).revision));
  const closing = store.close();
  await rejectsCode(() => readFirst(store), "workspace_store_closed");
  assert.equal((await pending).committedRevision.revision, "1");
  await closing;
  await assert.rejects(fs.access(f.lockPath), { code: "ENOENT" });
  const reopened = await open(f, {}, false);
  assert.equal((await readFirst(reopened)).revision.revision, "1");
});
