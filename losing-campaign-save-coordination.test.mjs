import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";

// Shipped controller/queue source; synthetic state, DOM and HTTP seams only.
const baseline = process.argv.includes("--baseline");
const html = baseline
  ? execFileSync("git", ["show", "8302728ee1dfd8cb6bd5d8760b1499ec572d4c00:social-cues-app.html"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  : await readFile(new URL("./social-cues-app.html", import.meta.url), "utf8");
const section = (start, end, optional = false) => {
  const first = html.indexOf(start), last = html.indexOf(end, first);
  if (optional && first < 0) return "";
  assert.ok(first >= 0 && last > first, start);
  return html.slice(first, last);
};
const queue = section("let workspaceSaveDispatchChain =", "const saveRevisionKey =", true);
const helpers = section("function assertLosingCampaignSaveState(", "async function reviewLosingCampaign()", true);
const pure = section("// Losing campaign: content-only projection", "// End losing campaign pure helpers.");
const create = section("async function createLosingCampaign()", "const recoveryState =");
const review = section("async function reviewLosingCampaign()", "async function openLosingCampaign(");
const send = section("async function sendWorkspaceSave(envelope)", "function enqueueHostedModelSave(");
const ordinaryReview = section("async function reviewWorkspaceSave()", "async function sendWorkspaceSave(envelope)");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const contextKey = JSON.stringify(["synthetic-user", "synthetic-workspace"]);
const revision = { epoch: "11111111-1111-4111-8111-111111111111", revision: "4" };
const operation = id => ({ operationId: id, kind: "model-save", expectedRevision: structuredClone(revision), request: { sentinel: "original-exact-retry-body" } });

function harness(phase = "review", actualSend = false) {
  const model = { currentUser: { id: "synthetic-user" }, workspace: { id: "synthetic-workspace" },
    persistence: { conditionalSave: true, revision: structuredClone(revision) }, campaigns: [{ id: "winner", title: "Saved winner", variants: [] }] };
  const file = { copyId: "abcdef12-3456-4789-8abc-123456789abc", sourceCampaignId: "winner",
    campaign: { title: "Retained losing text", brief: "Keep losing text", variants: [] } };
  const state = { phase, busy: false, context: contextKey, current: structuredClone(model), files: [file], selected: 0,
    operation: null, created: model.campaigns[0], reviewGeneration: 0, reviewSaveRevision: JSON.stringify(revision) };
  const saveState = { blocked: "", pending: null, generation: 0 };
  const sent = [], ui = { opened: 0 };
  const env = {
    URL, TextEncoder, crypto: { randomUUID: () => "12345678-1234-4123-8123-123456789abc" },
    losingCampaignState: state, workspaceSaveState: saveState, workspaceSaveContexts: new WeakMap(),
    hostedModelSaveChain: Promise.resolve(), losingContext: () => contextKey,
    sanitizedModelSnapshot: structuredClone, clone: structuredClone, normalizeModel: value => value,
    ownSaveRevisions: new Map(), saveRevisionKey: (id, rev) => JSON.stringify([id, rev]), model,
    render() {}, renderLosingCampaign() {}, workspaceSaveNotice() {}, persistModelSnapshot() {}, jump() {}, setStudioMode() {},
    $: () => ({ close() { ui.opened++; }, focus() {} }),
    async authedFetch() { return { ok: true, json: async () => structuredClone(model) }; },
    async sendWorkspaceSave(envelope) { sent.push(JSON.stringify(envelope)); return { json: async () => envelope.request }; },
    async captureSaveFailure(code, envelope) { saveState.blocked = "unknown"; saveState.pending = envelope; saveState.generation++; },
    afterWorkspaceSaves: action => Promise.resolve().then(action)
  };
  const context = vm.createContext(env);
  vm.runInContext(queue + "\n" + pure + "\n" + helpers + "\n" + ordinaryReview + "\n" + review + "\n" + create + (actualSend ? "\n" + send : ""), context);
  return { context, state, saveState, sent, ui, model, run: code => vm.runInContext(code, context) };
}

for (const phase of ["review", "exists"]) {
  test(phase + ": another unknown original cannot be cleared or bypassed", async () => {
    const h = harness(phase), original = operation("other-normal"), before = JSON.stringify(original);
    h.saveState.pending = original; h.saveState.blocked = "unknown";
    await h.run("createLosingCampaign()");
    assert.equal(h.sent.length, 0); assert.equal(h.ui.opened, 0);
    assert.equal(h.saveState.pending, original); assert.equal(JSON.stringify(original), before);
    assert.equal(h.saveState.blocked, "unknown"); assert.equal(h.context.model, h.model);
    assert.equal(h.state.files[0].campaign.brief, "Keep losing text");
  });
  test(phase + ": queued normal response settles before copy confirmation", async () => {
    const h = harness(phase), wait = deferred(), original = operation("delayed-normal");
    h.context.hostedModelSaveChain = wait.promise;
    const pending = h.run("createLosingCampaign()");
    await tick(); assert.equal(h.sent.length, 0); assert.equal(h.ui.opened, 0);
    h.saveState.pending = original; h.saveState.blocked = "unknown"; h.saveState.generation++;
    wait.resolve(); await pending;
    assert.equal(h.sent.length, 0); assert.equal(h.ui.opened, 0);
    assert.equal(h.saveState.pending, original); assert.equal(h.saveState.blocked, "unknown");
  });
}

test("context is checked again after waiting for prior normal saves", async () => {
  const h = harness(), wait = deferred();
  h.context.hostedModelSaveChain = wait.promise;
  const pending = h.run("createLosingCampaign()"); await tick();
  h.context.losingContext = () => "another-context"; wait.resolve(); await pending;
  assert.equal(h.sent.length, 0); assert.equal(h.ui.opened, 0); assert.equal(h.context.model, h.model);
});

test("acknowledged normal save after preview requires another explicit review", async () => {
  const h = harness();
  h.model.persistence.revision.revision = "5";
  await h.run("createLosingCampaign()");
  assert.equal(h.sent.length, 0); assert.equal(h.state.phase, "conflict"); assert.equal(h.ui.opened, 0);
});

test("own unknown creation retries the exact original operation and body", async () => {
  const h = harness("unknown");
  h.state.created = h.run('losingCampaignDraft(losingCampaignState.files[0], "2026-09-06T12:00:00Z")');
  const original = { ...operation("own-creation"), request: { ...structuredClone(h.model), campaigns: [h.state.created] } };
  h.state.operation = original; h.saveState.pending = original; h.saveState.blocked = "unknown";
  const before = JSON.stringify(original);
  await h.run("createLosingCampaign()");
  assert.deepEqual(h.sent, [before]); assert.equal(h.saveState.pending, null); assert.equal(h.ui.opened, 1);
});

test("existing-copy review retains a different definitely-rejected operation record", async () => {
  const h = harness("exists"), rejected = operation("rejected-normal");
  h.saveState.pending = rejected; h.saveState.blocked = "conflict";
  await h.run("createLosingCampaign()");
  assert.equal(h.saveState.pending, rejected); assert.equal(h.sent.length, 0); assert.equal(h.ui.opened, 1);
});

test("refresh does not replace current review if another outcome becomes unknown during its GET", async () => {
  const h = harness(), wait = deferred(), original = operation("unknown-during-get"), reviewed = h.state.current;
  h.context.authedFetch = async () => { await wait.promise; return { ok: true, json: async () => structuredClone(h.model) }; };
  const pending = h.run("reviewLosingCampaign()"); await tick();
  h.saveState.pending = original; h.saveState.blocked = "unknown"; wait.resolve(); await pending;
  assert.equal(h.saveState.pending, original); assert.equal(h.state.current, reviewed);
  assert.notEqual(h.state.phase, "review");
});

test("conditional-send boundary refuses a different unknown original before HTTP", async () => {
  const h = harness("review", true), original = operation("unknown-normal");
  let calls = 0;
  h.saveState.pending = original; h.saveState.blocked = "unknown"; h.context.newOperation = operation("other-operation");
  h.context.authedFetch = async () => { calls++; throw new Error("must not dispatch"); };
  await assert.rejects(h.run("sendWorkspaceSave(newOperation)"), /workspace_save_pending/);
  assert.equal(calls, 0); assert.equal(h.saveState.pending, original);
});

test("conditional-send confirmation clears only its matching pending record", async () => {
  const h = harness("review", true), other = operation("rejected-original"), sent = operation("confirmed-operation");
  h.saveState.pending = other; h.saveState.blocked = "conflict"; h.context.newOperation = sent;
  const body = { receipt: { operationId: sent.operationId }, persistence: { conditionalSave: true, revision } };
  h.context.authedFetch = async () => ({ ok: true, clone: () => ({ json: async () => body }) });
  await h.run("sendWorkspaceSave(newOperation)");
  assert.equal(h.saveState.pending, other);
  h.saveState.pending = sent; h.saveState.blocked = "unknown";
  await h.run("sendWorkspaceSave(newOperation)");
  assert.equal(h.saveState.pending, null); assert.equal(h.saveState.blocked, "conflict");
});

test("copy confirmation also waits for a direct in-flight conditional send", async () => {
  const h = harness("exists", true), wait = deferred(), original = operation("direct-normal");
  h.context.newOperation = original;
  h.context.authedFetch = async () => { await wait.promise; throw new TypeError("Synthetic lost normal response"); };
  const normal = h.run("sendWorkspaceSave(newOperation)").catch(error => error.message);
  await tick();
  const copy = h.run("createLosingCampaign()"); await tick();
  assert.equal(h.ui.opened, 0);
  wait.resolve(); assert.equal(await normal, "workspace_commit_unknown"); await copy;
  assert.equal(h.ui.opened, 0); assert.equal(h.saveState.pending, original); assert.equal(h.saveState.blocked, "unknown");
});

test("ordinary current-review cannot erase an unknown result that arrives during its read", async () => {
  const h = harness(), wait = deferred(), original = operation("normal-during-current-review");
  h.context.authedFetch = async () => { await wait.promise; return { ok: true, json: async () => structuredClone(h.model) }; };
  const review = h.run("reviewWorkspaceSave()"); await tick();
  h.saveState.blocked = "unknown"; h.saveState.pending = original; wait.resolve();
  assert.equal(await review, false); assert.equal(h.saveState.pending, original); assert.equal(h.context.model, h.model);
});
