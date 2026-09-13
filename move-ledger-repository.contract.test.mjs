import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const externalRequests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  externalRequests.push(args);
  throw new Error("Move ledger repository attempted an external request.");
};

let repositoryModule;
let ledgerModule;
repositoryModule = await import(new URL("./move-ledger-repository.mjs?repository-contract", import.meta.url));
ledgerModule = await import(new URL("./move-ledger.mjs?repository-contract", import.meta.url));
after(() => {
  assert.equal(externalRequests.length, 0);
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete globalThis.fetch;
});

const {
  MOVE_LEDGER_REPOSITORY_VERSION,
  MoveLedgerRepositoryError,
  openLocalMoveLedgerRepository
} = repositoryModule;
const { createMoveLedger, recordMoveResult } = ledgerModule;

const ACTOR_A = "actor-repository-a";
const ACTOR_B = "actor-repository-b";
const WORKSPACE_A = "workspace-repository-a";
const WORKSPACE_B = "workspace-repository-b";
const WORKSPACE_C = "workspace-repository-c";
const CYCLE = Object.freeze({
  cycleStartAt: "2027-01-01T00:00:00.000Z",
  cycleEndAt: "2027-02-01T00:00:00.000Z"
});

function authorize({ actorId, workspaceId }) {
  return (actorId === ACTOR_A && workspaceId === WORKSPACE_A)
    || (actorId === ACTOR_B && workspaceId === WORKSPACE_B);
}

function ledger(workspaceId = WORKSPACE_A, planId = "business") {
  return createMoveLedger({ workspaceId, planId, ...CYCLE });
}

function resultLedger(current, resultId) {
  return recordMoveResult({
    ledger: current,
    result: {
      workspaceId: current.workspaceId,
      resultId,
      activityId: "text-campaign-generation",
      outcome: "completed",
      units: 1,
      completedAt: "2027-01-15T12:00:00.000Z",
      subscriptionActive: true
    },
    enforcementEnabled: false
  }).ledger;
}

async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), "social-cues-move-repository-"));
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof MoveLedgerRepositoryError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("repository is a local hermetic shadow component", async () => {
  const source = await readFile(new URL("./move-ledger-repository.mjs", import.meta.url), "utf8");
  assert.equal(MOVE_LEDGER_REPOSITORY_VERSION, "social-cues.move-ledger-repository.v1");
  assert.equal(externalRequests.length, 0);
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|https?:\/\//u);
  assert.doesNotMatch(source, /stripe|checkout|webhook|provider|server\.mjs/iu);
});

test("committed ledgers persist across an explicit close and reopen", async t => {
  const directory = await temporaryDirectory();
  let repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const created = await repository.createIfAbsent({
    actorId: ACTOR_A,
    workspaceId: WORKSPACE_A,
    ledger: ledger()
  });
  const commit = {
    actorId: ACTOR_A,
    workspaceId: WORKSPACE_A,
    operationId: "operation-reopen-0001",
    expectedRevision: created.revision,
    ledger: resultLedger(created.ledger, "result-reopen-0001")
  };
  const saved = await repository.compareAndSet(commit);
  assert.equal(saved.revision.revision, "1");
  const replayed = await repository.compareAndSet(commit);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.revision, saved.revision);
  await rejectsCode(repository.compareAndSet({
    ...commit,
    ledger: resultLedger(created.ledger, "result-reopen-conflict")
  }), "move_ledger_operation_conflict");
  await repository.close();

  repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  const reopened = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  assert.deepEqual(reopened.ledger, saved.ledger);
  assert.deepEqual(reopened.revision, saved.revision);
});

test("workspace authorization denies cross-tenant reads, creates, and writes before lookup", async t => {
  const directory = await temporaryDirectory();
  const repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  await rejectsCode(repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A }), "move_ledger_not_found");
  const createdA = await repository.createIfAbsent({ actorId: ACTOR_A, workspaceId: WORKSPACE_A, ledger: ledger() });
  await repository.createIfAbsent({ actorId: ACTOR_B, workspaceId: WORKSPACE_B, ledger: ledger(WORKSPACE_B) });

  await rejectsCode(repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_B }), "move_ledger_not_authorized");
  await rejectsCode(repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_C }), "move_ledger_not_authorized");
  await rejectsCode(repository.createIfAbsent({
    actorId: ACTOR_A,
    workspaceId: WORKSPACE_B,
    ledger: ledger(WORKSPACE_B, "growth")
  }), "move_ledger_not_authorized");
  await rejectsCode(repository.compareAndSet({
    actorId: ACTOR_B,
    workspaceId: WORKSPACE_A,
    operationId: "operation-cross-tenant",
    expectedRevision: createdA.revision,
    ledger: resultLedger(createdA.ledger, "result-cross-tenant")
  }), "move_ledger_not_authorized");

  const unchangedA = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  const unchangedB = await repository.load({ actorId: ACTOR_B, workspaceId: WORKSPACE_B });
  assert.equal(unchangedA.ledger.entries.length, 0);
  assert.equal(unchangedB.ledger.planId, "business");
});

test("first-create races choose one immutable workspace seed without replacement", async t => {
  const directory = await temporaryDirectory();
  const repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const [left, right] = await Promise.all([
    repository.createIfAbsent({ actorId: ACTOR_A, workspaceId: WORKSPACE_A, ledger: ledger(WORKSPACE_A, "business") }),
    repository.createIfAbsent({ actorId: ACTOR_A, workspaceId: WORKSPACE_A, ledger: ledger(WORKSPACE_A, "growth") })
  ]);
  assert.deepEqual(left.ledger, right.ledger);
  assert.deepEqual(left.revision, right.revision);
  assert.equal(["business", "growth"].includes(left.ledger.planId), true);
  const persisted = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  assert.deepEqual(persisted.ledger, left.ledger);
  assert.equal(persisted.revision.revision, "0");
});

test("competing compare-and-set writes cannot lose a debit or double charge", async t => {
  const directory = await temporaryDirectory();
  const repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const created = await repository.createIfAbsent({ actorId: ACTOR_A, workspaceId: WORKSPACE_A, ledger: ledger() });
  const attempts = await Promise.allSettled([
    repository.compareAndSet({
      actorId: ACTOR_A,
      workspaceId: WORKSPACE_A,
      operationId: "operation-race-left",
      expectedRevision: created.revision,
      ledger: resultLedger(created.ledger, "result-race-left")
    }),
    repository.compareAndSet({
      actorId: ACTOR_A,
      workspaceId: WORKSPACE_A,
      operationId: "operation-race-right",
      expectedRevision: created.revision,
      ledger: resultLedger(created.ledger, "result-race-right")
    })
  ]);
  assert.equal(attempts.filter(item => item.status === "fulfilled").length, 1);
  const rejected = attempts.find(item => item.status === "rejected");
  assert.equal(rejected.reason.code, "move_ledger_revision_conflict");

  const persisted = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  assert.equal(persisted.ledger.entries.length, 1);
  assert.equal(persisted.ledger.cycle.remainingMoves, 249);
  assert.equal(persisted.revision.revision, "1");
});

test("semantic storage corruption fails closed and releases the writer lock", async t => {
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  await repository.createIfAbsent({ actorId: ACTOR_A, workspaceId: WORKSPACE_A, ledger: ledger() });
  await repository.close();

  const modelPath = path.join(directory, "model.json");
  const document = JSON.parse(await readFile(modelPath, "utf8"));
  document.workspaces[WORKSPACE_A].content.ledger.cycle.remainingMoves = 249;
  await writeFile(modelPath, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });

  await rejectsCode(openLocalMoveLedgerRepository({ dataDir: directory, authorize }), "move_ledger_storage_corrupt");
  await assert.rejects(readFile(path.join(directory, ".workspace-content.lock"), "utf8"), error => error.code === "ENOENT");
});

test("asynchronous or throwing authorization callbacks fail closed", async t => {
  const asyncDirectory = await temporaryDirectory();
  const asyncRepository = await openLocalMoveLedgerRepository({
    dataDir: asyncDirectory,
    authorize: async () => true
  });
  await rejectsCode(asyncRepository.createIfAbsent({
    actorId: ACTOR_A,
    workspaceId: WORKSPACE_A,
    ledger: ledger()
  }), "move_ledger_not_authorized");

  const throwingDirectory = await temporaryDirectory();
  const throwingRepository = await openLocalMoveLedgerRepository({
    dataDir: throwingDirectory,
    authorize: () => { throw new Error("authorization unavailable"); }
  });
  t.after(async () => {
    await asyncRepository.close();
    await throwingRepository.close();
    await rm(asyncDirectory, { recursive: true, force: true });
    await rm(throwingDirectory, { recursive: true, force: true });
  });
  await rejectsCode(throwingRepository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A }), "move_ledger_not_authorized");
});
