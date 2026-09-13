import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("./move-ledger.mjs", import.meta.url);
const externalRequests = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (...args) => {
  externalRequests.push(args);
  throw new Error("Move ledger import attempted an external request.");
};

let moveLedgerModule;
try {
  moveLedgerModule = await import(`${moduleUrl.href}?move-ledger-contract`);
} finally {
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete globalThis.fetch;
}

const {
  MOVE_LEDGER_ENFORCEMENT_DEFAULT,
  MOVE_LEDGER_SCHEMA_VERSION,
  MoveLedgerError,
  createMoveLedger,
  definePurchasedMoveLot,
  evaluateMoveAllowance,
  hydrateMoveLedger,
  recordMoveResult,
  rollMoveLedgerCycle,
  summarizeMoveLedger
} = moveLedgerModule;

const WORKSPACE_A = "workspace-a-0001";
const WORKSPACE_B = "workspace-b-0002";
const CYCLE_ONE = Object.freeze({
  cycleStartAt: "2026-01-01T00:00:00.000Z",
  cycleEndAt: "2026-02-01T00:00:00.000Z"
});
const CYCLE_TWO = Object.freeze({
  cycleStartAt: "2026-02-01T00:00:00.000Z",
  cycleEndAt: "2026-03-01T00:00:00.000Z"
});

function ledger(options = {}) {
  return createMoveLedger({
    workspaceId: WORKSPACE_A,
    planId: "business",
    ...CYCLE_ONE,
    ...options
  });
}

function completedResult(overrides = {}) {
  return {
    workspaceId: WORKSPACE_A,
    resultId: "result-default-0001",
    activityId: "text-campaign-generation",
    outcome: "completed",
    units: 1,
    completedAt: "2026-01-15T12:00:00.000Z",
    subscriptionActive: true,
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertMoveError(callback, code) {
  assert.throws(callback, error => {
    assert.equal(error instanceof MoveLedgerError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function assertDeepFrozen(value, path = "value") {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${path}.${key}`);
}

test("Move ledger is a hermetic local domain with enforcement disabled by default", async () => {
  const source = await readFile(moduleUrl, "utf8");
  const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(MOVE_LEDGER_SCHEMA_VERSION, "social-cues.move-ledger.v1");
  assert.equal(MOVE_LEDGER_ENFORCEMENT_DEFAULT, false);
  assert.equal(externalRequests.length, 0);
  assert.equal(packageJson.scripts["test:move-ledger"], "node move-ledger.contract.test.mjs");
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|https?:\/\//u);
  assert.doesNotMatch(source, /stripe|checkout|webhook|priceCents|OPENAI_COST_ACCOUNTING/iu);
});

test("canonical plan allowances initialize workspace-scoped immutable ledgers", () => {
  const expected = { business: 250, growth: 750, agency: 1500 };
  for (const [planId, includedMoves] of Object.entries(expected)) {
    const state = ledger({ planId });
    assert.equal(state.workspaceId, WORKSPACE_A);
    assert.equal(state.planId, planId);
    assert.equal(state.cycle.includedMoves, includedMoves);
    assert.equal(state.cycle.remainingMoves, includedMoves);
    assert.deepEqual(state.purchasedLots, []);
    assert.deepEqual(state.entries, []);
    assertDeepFrozen(state, planId);
  }
});

test("completed meaningful results use only canonical current Move weights", () => {
  let state = ledger();
  const cases = [
    ["text-campaign-generation", 2, 2],
    ["audience-brief", 3, 3],
    ["automation-execution", 4, 4]
  ];
  for (const [activityId, units, moveCost] of cases) {
    const recorded = recordMoveResult({
      ledger: state,
      result: completedResult({ resultId: `result-${activityId}`, activityId, units })
    });
    assert.equal(recorded.decision.allowed, true);
    assert.equal(recorded.decision.recorded, true);
    assert.equal(recorded.decision.moveCost, moveCost);
    state = recorded.ledger;
  }
  assert.equal(state.cycle.remainingMoves, 241);
  assert.equal(state.entries.length, 3);
});

test("failures and retries without a completed result consume zero Moves", () => {
  const initial = ledger();
  for (const outcome of ["failed", "retrying", "pending", "canceled"]) {
    const result = recordMoveResult({
      ledger: initial,
      result: completedResult({ resultId: `result-${outcome}-0001`, outcome })
    });
    assert.equal(result.decision.allowed, true);
    assert.equal(result.decision.reason, "result_not_completed");
    assert.equal(result.decision.moveCost, 0);
    assert.equal(result.decision.recorded, false);
    assert.deepEqual(result.ledger, initial);
  }

  const retryThenSuccess = recordMoveResult({
    ledger: initial,
    result: completedResult({ resultId: "result-retry-then-success", outcome: "retrying" })
  });
  const completed = recordMoveResult({
    ledger: retryThenSuccess.ledger,
    result: completedResult({ resultId: "result-retry-then-success" })
  });
  assert.equal(completed.decision.recorded, true);
  assert.equal(completed.ledger.cycle.remainingMoves, 249);
});

test("manual and ordinary workspace activity always costs zero Moves", () => {
  const initial = ledger();
  for (const activityId of ["manual-editing", "approvals", "dashboards", "ordinary-workspace-activity"]) {
    const result = recordMoveResult({
      ledger: initial,
      result: completedResult({ resultId: `result-${activityId}`, activityId, units: 999 })
    });
    assert.equal(result.decision.reason, "zero_move_activity");
    assert.equal(result.decision.moveCost, 0);
    assert.equal(result.decision.recorded, false);
    assert.deepEqual(result.ledger, initial);
  }
});

test("planned image and video activities cannot be recorded as live usage", () => {
  const initial = ledger();
  for (const activityId of ["image-generation", "rendered-video-minute"]) {
    const result = recordMoveResult({
      ledger: initial,
      result: completedResult({ resultId: `result-${activityId}`, activityId })
    });
    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.reason, "activity_planned");
    assert.equal(result.decision.recorded, false);
    assert.deepEqual(result.ledger, initial);
  }
});

test("workspace identity isolates results and purchased lots", () => {
  const initial = ledger();
  assertMoveError(() => evaluateMoveAllowance({
    ledger: initial,
    result: completedResult({ workspaceId: WORKSPACE_B })
  }), "move_ledger_workspace_mismatch");

  const foreignLot = definePurchasedMoveLot({
    workspaceId: WORKSPACE_B,
    lotId: "lot-foreign-0001",
    moves: 100,
    acquiredAt: "2025-06-01T00:00:00.000Z"
  });
  assertMoveError(() => ledger({ purchasedLots: [foreignLot] }), "move_ledger_workspace_mismatch");
});

test("stable result identity prevents duplicate debits and rejects conflicting replay", () => {
  const first = recordMoveResult({ ledger: ledger(), result: completedResult() });
  const replay = recordMoveResult({ ledger: first.ledger, result: completedResult() });
  assert.equal(replay.decision.allowed, true);
  assert.equal(replay.decision.duplicate, true);
  assert.equal(replay.decision.recorded, false);
  assert.equal(replay.ledger.entries.length, 1);
  assert.equal(replay.ledger.cycle.remainingMoves, 249);

  assertMoveError(() => recordMoveResult({
    ledger: first.ledger,
    result: completedResult({ activityId: "audience-brief" })
  }), "move_ledger_idempotency_conflict");
  assertMoveError(() => recordMoveResult({
    ledger: first.ledger,
    result: completedResult({ units: 2 })
  }), "move_ledger_idempotency_conflict");
});

test("included Moves are consumed before earliest-expiring purchased lots", () => {
  const earlier = definePurchasedMoveLot({
    workspaceId: WORKSPACE_A,
    lotId: "lot-earlier-0001",
    moves: 10,
    acquiredAt: "2025-05-01T00:00:00.000Z"
  });
  const later = definePurchasedMoveLot({
    workspaceId: WORKSPACE_A,
    lotId: "lot-later-0002",
    moves: 20,
    acquiredAt: "2025-06-01T00:00:00.000Z"
  });
  const recorded = recordMoveResult({
    ledger: ledger({ purchasedLots: [later, earlier] }),
    result: completedResult({ resultId: "result-spend-order-0001", units: 265 })
  });
  assert.deepEqual(recorded.decision.debit, {
    includedMoves: 250,
    purchasedMoves: 15,
    purchasedLots: [
      { lotId: "lot-earlier-0001", moves: 10 },
      { lotId: "lot-later-0002", moves: 5 }
    ],
    unfundedMoves: 0
  });
  assert.equal(recorded.ledger.purchasedLots.find(lot => lot.lotId === "lot-earlier-0001").remainingMoves, 0);
  assert.equal(recorded.ledger.purchasedLots.find(lot => lot.lotId === "lot-later-0002").remainingMoves, 15);
});

test("purchased Move lots expire after twelve calendar months", () => {
  const leapLot = definePurchasedMoveLot({
    workspaceId: WORKSPACE_A,
    lotId: "lot-leap-day-0001",
    moves: 10,
    acquiredAt: "2024-02-29T08:30:00.000Z"
  });
  assert.equal(leapLot.expiresAt, "2025-02-28T08:30:00.000Z");

  const expiringLot = definePurchasedMoveLot({
    workspaceId: WORKSPACE_A,
    lotId: "lot-expiring-0002",
    moves: 10,
    acquiredAt: "2025-01-15T12:00:00.000Z"
  });
  const state = ledger({ purchasedLots: [expiringLot] });
  const before = summarizeMoveLedger({
    ledger: state,
    at: "2026-01-15T11:59:59.999Z",
    subscriptionActive: true
  });
  const atExpiry = summarizeMoveLedger({
    ledger: state,
    at: "2026-01-15T12:00:00.000Z",
    subscriptionActive: true
  });
  assert.equal(before.remainingPurchasedMoves, 10);
  assert.equal(atExpiry.remainingPurchasedMoves, 0);
  assert.equal(atExpiry.expiredPurchasedMoves, 10);
});

test("purchased Moves remain unspent unless the subscription is active", () => {
  const purchased = definePurchasedMoveLot({
    workspaceId: WORKSPACE_A,
    lotId: "lot-inactive-0001",
    moves: 10,
    acquiredAt: "2025-06-01T00:00:00.000Z"
  });
  const result = recordMoveResult({
    ledger: ledger({ purchasedLots: [purchased] }),
    result: completedResult({
      resultId: "result-inactive-subscription",
      units: 251,
      subscriptionActive: false
    })
  });
  assert.equal(result.decision.allowed, true);
  assert.equal(result.decision.reason, "enforcement_disabled");
  assert.equal(result.decision.debit.purchasedMoves, 0);
  assert.equal(result.decision.debit.unfundedMoves, 1);
  assert.equal(result.ledger.purchasedLots[0].remainingMoves, 10);

  const summary = summarizeMoveLedger({
    ledger: result.ledger,
    at: "2026-01-15T12:00:00.000Z",
    subscriptionActive: false
  });
  assert.equal(summary.remainingPurchasedMoves, 0);
  assert.equal(summary.inactivePurchasedMoves, 10);
});

test("billing-cycle rollover resets included Moves without rollover", () => {
  const first = recordMoveResult({
    ledger: ledger(),
    result: completedResult({ resultId: "result-cycle-one-0001", units: 100 })
  });
  assert.equal(first.ledger.cycle.remainingMoves, 150);

  const rolled = rollMoveLedgerCycle({ ledger: first.ledger, planId: "business", ...CYCLE_TWO });
  assert.equal(rolled.cycle.includedMoves, 250);
  assert.equal(rolled.cycle.remainingMoves, 250);
  assert.equal(rolled.entries.length, 1);
  assert.equal(rolled.entries[0].cycleStartAt, CYCLE_ONE.cycleStartAt);

  const replay = recordMoveResult({
    ledger: rolled,
    result: completedResult({ resultId: "result-cycle-one-0001", units: 100 })
  });
  assert.equal(replay.decision.duplicate, true);
  assert.equal(replay.ledger.cycle.remainingMoves, 250);

  assertMoveError(() => rollMoveLedgerCycle({
    ledger: first.ledger,
    cycleStartAt: "2026-01-31T00:00:00.000Z",
    cycleEndAt: "2026-02-28T00:00:00.000Z"
  }), "move_ledger_cycle_conflict");
});

test("disabled enforcement records shortfall without blocking existing flows", () => {
  const initial = ledger();
  const evaluation = evaluateMoveAllowance({
    ledger: initial,
    result: completedResult({ resultId: "result-shortfall-default", units: 251 })
  });
  assert.equal(evaluation.enforcementEnabled, false);
  assert.equal(evaluation.allowed, true);
  assert.equal(evaluation.reason, "enforcement_disabled");
  assert.equal(evaluation.balanceSufficient, false);
  assert.equal(evaluation.wouldDenyIfEnforced, true);
  assert.equal(evaluation.debit.unfundedMoves, 1);

  const recorded = recordMoveResult({
    ledger: initial,
    result: completedResult({ resultId: "result-shortfall-default", units: 251 })
  });
  assert.equal(recorded.decision.recorded, true);
  assert.equal(recorded.ledger.cycle.remainingMoves, 0);
  assert.equal(recorded.ledger.entries[0].unfundedMoves, 1);
  const replay = recordMoveResult({
    ledger: recorded.ledger,
    result: completedResult({ resultId: "result-shortfall-default", units: 251 })
  });
  assert.equal(replay.decision.duplicate, true);
  assert.equal(replay.ledger.entries.length, 1);
});

test("enabled evaluation denies insufficient balance without mutating the ledger", () => {
  const initial = ledger();
  const evaluation = evaluateMoveAllowance({
    ledger: initial,
    result: completedResult({ resultId: "result-shortfall-enforced", units: 251 }),
    enforcementEnabled: true
  });
  assert.equal(evaluation.allowed, false);
  assert.equal(evaluation.reason, "insufficient_balance");
  assert.equal(evaluation.debit.includedMoves, 0);
  assert.equal(evaluation.remainingBalance.totalMoves, 250);

  const result = recordMoveResult({
    ledger: initial,
    result: completedResult({ resultId: "result-shortfall-enforced", units: 251 }),
    enforcementEnabled: true
  });
  assert.equal(result.decision.recorded, false);
  assert.deepEqual(result.ledger, initial);
});

test("completed results outside the active cycle fail closed", () => {
  const initial = ledger();
  for (const completedAt of ["2025-12-31T23:59:59.999Z", CYCLE_ONE.cycleEndAt]) {
    const result = recordMoveResult({
      ledger: initial,
      result: completedResult({ resultId: `result-outside-${completedAt}`, completedAt })
    });
    assert.equal(result.decision.allowed, false);
    assert.equal(result.decision.reason, "billing_cycle_out_of_scope");
    assert.equal(result.decision.recorded, false);
    assert.deepEqual(result.ledger, initial);
  }
});

test("hydration rejects balance and ledger-integrity tampering", () => {
  const recorded = recordMoveResult({ ledger: ledger(), result: completedResult() }).ledger;
  const includedTamper = clone(recorded);
  includedTamper.cycle.remainingMoves = 250;
  assertMoveError(() => hydrateMoveLedger(includedTamper), "move_ledger_state_invalid");

  const entryTamper = clone(recorded);
  entryTamper.entries[0].moveCost = 2;
  assertMoveError(() => hydrateMoveLedger(entryTamper), "move_ledger_entry_invalid");

  const duplicateTamper = clone(recorded);
  duplicateTamper.entries.push(clone(duplicateTamper.entries[0]));
  assertMoveError(() => hydrateMoveLedger(duplicateTamper), "move_ledger_result_conflict");

  const purchased = definePurchasedMoveLot({
    workspaceId: WORKSPACE_A,
    lotId: "lot-hydration-0001",
    moves: 10,
    acquiredAt: "2025-06-01T00:00:00.000Z"
  });
  const purchasedRecord = recordMoveResult({
    ledger: ledger({ purchasedLots: [purchased] }),
    result: completedResult({ resultId: "result-hydration-purchased", units: 251 })
  }).ledger;

  const inactiveTamper = clone(purchasedRecord);
  inactiveTamper.entries[0].subscriptionActive = false;
  assertMoveError(() => hydrateMoveLedger(inactiveTamper), "move_ledger_entry_invalid");

  const spendOrderTamper = clone(purchasedRecord);
  spendOrderTamper.entries[0].includedMovesDebited = 249;
  spendOrderTamper.entries[0].purchasedMovesDebited = 2;
  spendOrderTamper.entries[0].purchasedLotDebits[0].moves = 2;
  spendOrderTamper.cycle.remainingMoves = 1;
  spendOrderTamper.purchasedLots[0].remainingMoves = 8;
  assertMoveError(() => hydrateMoveLedger(spendOrderTamper), "move_ledger_entry_invalid");
});

test("summaries expose only deterministic Move balances and accounting status", () => {
  const initial = ledger();
  const summary = summarizeMoveLedger({
    ledger: initial,
    at: "2026-01-15T12:00:00.000Z",
    subscriptionActive: true
  });
  assert.deepEqual(Object.keys(summary).sort(), [
    "cycle",
    "enforcementEnabled",
    "expiredPurchasedMoves",
    "fundedMovesRecorded",
    "inactivePurchasedMoves",
    "planId",
    "pricingVersion",
    "recordedResults",
    "remainingMoves",
    "remainingPurchasedMoves",
    "unfundedMovesRecorded",
    "version",
    "workspaceId"
  ]);
  assert.equal(summary.enforcementEnabled, false);
  assert.equal(summary.remainingMoves, 250);
  assert.equal(JSON.stringify(summary).includes("microUSD"), false);
  assert.equal(JSON.stringify(summary).includes("priceCents"), false);
  assertDeepFrozen(summary, "summary");
});
