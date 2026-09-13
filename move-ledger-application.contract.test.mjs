import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const externalRequests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  externalRequests.push(args);
  throw new Error("Move ledger application attempted an external request.");
};
after(() => {
  assert.equal(externalRequests.length, 0);
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete globalThis.fetch;
});

const applicationModule = await import(new URL("./move-ledger-application.mjs?application-contract", import.meta.url));
const repositoryModule = await import(new URL("./move-ledger-repository.mjs?application-contract", import.meta.url));
const ledgerModule = await import(new URL("./move-ledger.mjs?application-contract", import.meta.url));

const {
  MOVE_LEDGER_APPLICATION_VERSION,
  MOVE_LEDGER_RELEASE_STAGE,
  MoveLedgerApplicationError,
  createMoveLedgerApplication
} = applicationModule;
const { openLocalMoveLedgerRepository } = repositoryModule;
const { createMoveLedger, definePurchasedMoveLot } = ledgerModule;

const ACTOR_A = "actor-application-a";
const WORKSPACE_A = "workspace-application-a";
const CYCLE_ONE = Object.freeze({
  cycleStartAt: "2027-01-01T00:00:00.000Z",
  cycleEndAt: "2027-02-01T00:00:00.000Z"
});
const CYCLE_TWO = Object.freeze({
  cycleStartAt: "2027-02-01T00:00:00.000Z",
  cycleEndAt: "2027-03-01T00:00:00.000Z"
});

function trustedFacts(overrides = {}) {
  return {
    workspaceId: WORKSPACE_A,
    planId: "business",
    ...CYCLE_ONE,
    subscriptionActive: true,
    ...overrides
  };
}

function result(overrides = {}) {
  return {
    actorId: ACTOR_A,
    workspaceId: WORKSPACE_A,
    result: {
      resultId: "result-application-default",
      activityId: "text-campaign-generation",
      outcome: "completed",
      units: 1,
      completedAt: "2027-01-15T12:00:00.000Z",
      ...overrides
    }
  };
}

function authorize({ actorId, workspaceId }) {
  return actorId === ACTOR_A && workspaceId === WORKSPACE_A;
}

async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), "social-cues-move-application-"));
}

function application(repository, factsSource = trustedFacts(), lotSource = []) {
  return createMoveLedgerApplication({
    repository,
    resolveTrustedLedgerFacts: async context => typeof factsSource === "function" ? factsSource(context) : factsSource,
    resolveTrustedPurchasedLots: async context => typeof lotSource === "function" ? lotSource(context) : lotSource
  });
}

function memoryRepository(initial = null, options = {}) {
  let state = initial;
  let revision = { epoch: "memory-epoch-0001", revision: "0" };
  let compareCalls = 0;
  return {
    get compareCalls() { return compareCalls; },
    async load() {
      if (!state) throw Object.assign(new Error("not found"), { code: "move_ledger_not_found" });
      return { ledger: state, revision: { ...revision } };
    },
    async createIfAbsent({ ledger }) {
      if (!state) state = ledger;
      return { ledger: state, revision: { ...revision } };
    },
    async compareAndSet({ ledger }) {
      compareCalls += 1;
      if (options.conflicts === "always" || compareCalls <= (options.conflicts || 0)) {
        throw Object.assign(new Error("conflict"), { code: "move_ledger_revision_conflict" });
      }
      state = ledger;
      revision = { ...revision, revision: String(BigInt(revision.revision) + 1n) };
      return { ledger: state, revision: { ...revision }, replayed: false };
    }
  };
}

async function rejectsApplicationCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof MoveLedgerApplicationError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("application is hermetic, shadow-only, and has no route or payment activation", async () => {
  const [source, serverSource, packageSource] = await Promise.all([
    readFile(new URL("./move-ledger-application.mjs", import.meta.url), "utf8"),
    readFile(new URL("./server.mjs", import.meta.url), "utf8"),
    readFile(new URL("./package.json", import.meta.url), "utf8")
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.equal(MOVE_LEDGER_APPLICATION_VERSION, "social-cues.move-ledger-application.v1");
  assert.equal(MOVE_LEDGER_RELEASE_STAGE, "shadow-only");
  assert.equal(packageJson.scripts["test:move-ledger-repository"], "node move-ledger-repository.contract.test.mjs");
  assert.equal(packageJson.scripts["test:move-ledger-application"], "node move-ledger-application.contract.test.mjs");
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|https?:\/\//u);
  assert.doesNotMatch(source, /stripe|checkout|webhook|\/api\/|createServer|listen\s*\(/iu);
  assert.doesNotMatch(serverSource, /move-ledger-(?:application|repository)\.mjs/u);
});

test("only the trusted boundary supplies plan, cycle, subscription, and lot authority", async () => {
  const repository = memoryRepository();
  const contexts = [];
  const app = createMoveLedgerApplication({
    repository,
    resolveTrustedLedgerFacts: async context => {
      contexts.push(context);
      assert.equal(Object.isFrozen(context), true);
      return trustedFacts();
    },
    resolveTrustedPurchasedLots: async context => {
      assert.equal(context.workspaceId, WORKSPACE_A);
      return [];
    }
  });
  const response = await app.recordResult(result());
  assert.equal(response.releaseStage, "shadow-only");
  assert.equal(response.shadowOnly, true);
  assert.equal(response.enforcementEnabled, false);
  assert.equal(response.balance.planId, "business");
  assert.deepEqual(Object.keys(contexts[0]).sort(), ["actorId", "completedAt", "workspaceId"]);

  const callsBeforeInjection = contexts.length;
  await rejectsApplicationCode(app.recordResult({ ...result(), planId: "agency" }), "move_ledger_application_input_invalid");
  await rejectsApplicationCode(app.recordResult(result({ subscriptionActive: false })), "move_ledger_application_input_invalid");
  await rejectsApplicationCode(app.recordResult(result({ purchasedLots: [] })), "move_ledger_application_input_invalid");
  assert.equal(contexts.length, callsBeforeInjection);
});

test("trusted facts accept only Business, Growth, and Agency plan identities", async () => {
  for (const planId of ["business", "growth", "agency"]) {
    const repository = memoryRepository();
    const response = await application(repository, trustedFacts({ planId })).recordResult(
      result({ resultId: `result-plan-${planId}` })
    );
    assert.equal(response.balance.planId, planId);
  }
  for (const planId of ["alpha", "guided", "guided-setup", "guided-pilot"]) {
    const repository = memoryRepository();
    await rejectsApplicationCode(
      application(repository, trustedFacts({ planId })).recordResult(result({ resultId: `result-plan-${planId}` })),
      "move_ledger_trusted_facts_invalid"
    );
    assert.equal(repository.compareCalls, 0);
  }
});

test("a recorded result remains idempotent after close and reopen", async t => {
  const directory = await temporaryDirectory();
  let repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  let app = application(repository);
  const first = await app.recordResult(result({ resultId: "result-durable-replay" }));
  assert.equal(first.recorded, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.balance.remainingMoves, 249);
  await repository.close();

  repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  app = application(repository);
  const replay = await app.recordResult(result({ resultId: "result-durable-replay" }));
  assert.equal(replay.recorded, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reason, "duplicate_result");
  assert.deepEqual(replay.revision, first.revision);

  await assert.rejects(
    app.recordResult(result({ resultId: "result-durable-replay", activityId: "audience-brief" })),
    error => error?.name === "MoveLedgerError" && error.code === "move_ledger_idempotency_conflict"
  );
  const stored = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  assert.equal(stored.ledger.entries.length, 1);
  assert.equal(stored.ledger.cycle.remainingMoves, 249);
});

test("concurrent duplicate and distinct results remain exactly-once under CAS", async t => {
  const directory = await temporaryDirectory();
  const repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const app = application(repository);
  const duplicateInput = result({ resultId: "result-concurrent-same" });
  const duplicates = await Promise.all([app.recordResult(duplicateInput), app.recordResult(duplicateInput)]);
  assert.equal(duplicates.filter(item => item.recorded).length, 1);
  assert.equal(duplicates.filter(item => item.duplicate).length, 1);

  const distinct = await Promise.all([
    app.recordResult(result({ resultId: "result-concurrent-left" })),
    app.recordResult(result({ resultId: "result-concurrent-right" }))
  ]);
  assert.equal(distinct.every(item => item.recorded), true);
  const stored = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  assert.equal(stored.ledger.entries.length, 3);
  assert.equal(new Set(stored.ledger.entries.map(entry => entry.resultId)).size, 3);
  assert.equal(stored.ledger.cycle.remainingMoves, 247);
});

test("CAS conflicts retry from fresh state and exhaust at the explicit bound", async () => {
  const initial = createMoveLedger({ workspaceId: WORKSPACE_A, planId: "business", ...CYCLE_ONE });
  const retryRepository = memoryRepository(initial, { conflicts: 1 });
  const retried = await application(retryRepository).recordResult(result({ resultId: "result-cas-retry" }));
  assert.equal(retryRepository.compareCalls, 2);
  assert.equal(retried.recorded, true);
  assert.equal(retried.balance.remainingMoves, 249);

  const exhaustedRepository = memoryRepository(initial, { conflicts: "always" });
  const exhaustedApp = createMoveLedgerApplication({
    repository: exhaustedRepository,
    resolveTrustedLedgerFacts: async () => trustedFacts(),
    maxCasAttempts: 3
  });
  await rejectsApplicationCode(
    exhaustedApp.recordResult(result({ resultId: "result-cas-exhausted" })),
    "move_ledger_revision_exhausted"
  );
  assert.equal(exhaustedRepository.compareCalls, 3);
});

test("purchased lots require trusted provenance and an active subscription", async t => {
  const directory = await temporaryDirectory();
  const repository = await openLocalMoveLedgerRepository({ dataDir: directory, authorize });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  let facts = trustedFacts({ subscriptionActive: false });
  const purchased = definePurchasedMoveLot({
    workspaceId: WORKSPACE_A,
    lotId: "lot-trusted-provenance",
    moves: 100,
    acquiredAt: "2027-01-10T00:00:00.000Z"
  });
  const app = application(repository, () => facts, () => [purchased]);
  const inactive = await app.recordResult(result({ resultId: "result-inactive-lot", units: 251 }));
  assert.equal(inactive.enforcementEnabled, false);
  assert.equal(inactive.recorded, true);
  assert.equal(inactive.balanceSufficient, false);
  assert.equal(inactive.wouldDenyIfEnforced, true);
  assert.equal(inactive.balance.remainingPurchasedMoves, 0);
  let stored = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  assert.equal(stored.ledger.purchasedLots[0].remainingMoves, 100);
  assert.equal(stored.ledger.entries[0].unfundedMoves, 1);

  facts = trustedFacts({ subscriptionActive: true });
  const active = await app.recordResult(result({ resultId: "result-active-lot" }));
  assert.equal(active.balance.remainingPurchasedMoves, 99);
  stored = await repository.load({ actorId: ACTOR_A, workspaceId: WORKSPACE_A });
  assert.equal(stored.ledger.purchasedLots[0].remainingMoves, 99);

  facts = trustedFacts({ planId: "growth", ...CYCLE_TWO, subscriptionActive: true });
  const rolled = await app.recordResult(result({
    resultId: "result-cycle-two",
    completedAt: "2027-02-15T12:00:00.000Z"
  }));
  assert.equal(rolled.balance.planId, "growth");
  assert.equal(rolled.balance.cycle.remainingIncludedMoves, 749);
  assert.equal(rolled.balance.remainingPurchasedMoves, 99);
});

test("safe application results omit durable ledger internals and provider cost data", async () => {
  const response = await application(memoryRepository()).recordResult(result({ resultId: "result-safe-output" }));
  const serialized = JSON.stringify(response);
  for (const forbidden of [
    "entries", "purchasedLots", "lotId", "priceCents", "customerId", "subscriptionId",
    "provider", "token", "secret", "OPENAI_COST_ACCOUNTING"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `safe response exposed ${forbidden}`);
  }
  assert.deepEqual(Object.keys(response.balance).sort(), [
    "cycle",
    "fundedMovesRecorded",
    "planId",
    "recordedResults",
    "remainingMoves",
    "remainingPurchasedMoves",
    "unfundedMovesRecorded",
    "workspaceId"
  ]);
});
