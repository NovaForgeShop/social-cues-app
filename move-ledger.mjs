import {
  MOVE_METERING_CONFIGURATION,
  PRICING_CONFIGURATION,
  resolvePricingPlan
} from "./pricing-packaging.mjs";

export const MOVE_LEDGER_SCHEMA_VERSION = "social-cues.move-ledger.v1";
export const MOVE_LEDGER_ENFORCEMENT_DEFAULT = false;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const RESULT_OUTCOMES = new Set(["completed", "failed", "retrying", "pending", "canceled"]);
const MAX_UNITS = 1_000_000;
const PURCHASED_MOVE_LIFETIME_MONTHS = MOVE_METERING_CONFIGURATION.purchasedMoves.expirationMonths;
const WEIGHTS_BY_ID = new Map(MOVE_METERING_CONFIGURATION.weights.map(item => [item.id, item]));
const ZERO_MOVE_IDS = new Set(MOVE_METERING_CONFIGURATION.zeroMoveActivities.map(item => item.id));

export class MoveLedgerError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "MoveLedgerError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) {
  throw new MoveLedgerError(code, message, status);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredId(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!ID_PATTERN.test(normalized)) fail("move_ledger_identity_invalid", `${label} is invalid.`);
  return normalized;
}

function integerInRange(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("move_ledger_amount_invalid", `${label} is invalid.`);
  }
  return value;
}

function timestamp(value, label) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) fail("move_ledger_timestamp_invalid", `${label} is invalid.`);
  return new Date(parsed).toISOString();
}

function calendarMonthsAfter(value, months) {
  const source = new Date(timestamp(value, "Acquisition timestamp"));
  const absoluteMonth = source.getUTCFullYear() * 12 + source.getUTCMonth() + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth % 12;
  const finalDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(source.getUTCDate(), finalDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds()
  )).toISOString();
}

function cycleValue(startAt, endAt) {
  const start = timestamp(startAt, "Billing-cycle start");
  const end = timestamp(endAt, "Billing-cycle end");
  if (Date.parse(end) <= Date.parse(start)) {
    fail("move_ledger_cycle_invalid", "The billing-cycle boundary is invalid.");
  }
  return { startAt: start, endAt: end };
}

function planMoveAllowance(planId) {
  const resolved = resolvePricingPlan(planId);
  if (!resolved.ok) fail("move_ledger_plan_invalid", "The pricing plan is unavailable.", 409);
  const allowance = resolved.plan.allowances.find(item => item.id === "moves");
  if (!allowance
    || allowance.unit !== MOVE_METERING_CONFIGURATION.unit
    || allowance.period !== MOVE_METERING_CONFIGURATION.includedMoves.resetCadence) {
    fail("move_ledger_pricing_invalid", "The canonical Move allowance is unavailable.", 500);
  }
  return {
    planId: resolved.plan.id,
    includedMoves: integerInRange(allowance.limit, "Included Move allowance", 0)
  };
}

function lotValue(value, workspaceId) {
  if (!isRecord(value)) fail("move_ledger_lot_invalid", "Purchased Move lot metadata is invalid.");
  const lot = {
    lotId: requiredId(value.lotId, "Purchased Move lot ID"),
    workspaceId: requiredId(value.workspaceId, "Purchased Move lot workspace"),
    acquiredAt: timestamp(value.acquiredAt, "Purchased Move acquisition timestamp"),
    expiresAt: timestamp(value.expiresAt, "Purchased Move expiration timestamp"),
    originalMoves: integerInRange(value.originalMoves, "Purchased Move quantity", 1),
    remainingMoves: integerInRange(value.remainingMoves, "Purchased Move remaining quantity", 0)
  };
  if (lot.workspaceId !== workspaceId) {
    fail("move_ledger_workspace_mismatch", "Purchased Move lot workspace does not match the ledger.", 403);
  }
  if (lot.remainingMoves > lot.originalMoves
    || lot.expiresAt !== calendarMonthsAfter(lot.acquiredAt, PURCHASED_MOVE_LIFETIME_MONTHS)) {
    fail("move_ledger_lot_invalid", "Purchased Move lot metadata is invalid.");
  }
  return lot;
}

function lotDebitValue(value) {
  if (!isRecord(value)) fail("move_ledger_entry_invalid", "Purchased Move debit metadata is invalid.");
  return {
    lotId: requiredId(value.lotId, "Purchased Move debit lot ID"),
    moves: integerInRange(value.moves, "Purchased Move debit", 1)
  };
}

function entryValue(value, workspaceId) {
  if (!isRecord(value)) fail("move_ledger_entry_invalid", "Move ledger entry is invalid.");
  const activity = WEIGHTS_BY_ID.get(value.activityId);
  const plan = planMoveAllowance(value.planId);
  const units = integerInRange(value.units, "Move result units", 1, MAX_UNITS);
  const moveCost = integerInRange(value.moveCost, "Move result cost", 1);
  const cycleIncludedMoves = integerInRange(value.cycleIncludedMoves, "Move entry allowance", 0);
  const includedMovesDebited = integerInRange(value.includedMovesDebited, "Included Move debit", 0);
  const purchasedMovesDebited = integerInRange(value.purchasedMovesDebited, "Purchased Move debit", 0);
  const unfundedMoves = integerInRange(value.unfundedMoves, "Unfunded Move amount", 0);
  const purchasedLotDebits = Array.isArray(value.purchasedLotDebits)
    ? value.purchasedLotDebits.map(lotDebitValue)
    : fail("move_ledger_entry_invalid", "Purchased Move debit metadata is invalid.");
  const entry = {
    resultId: requiredId(value.resultId, "Move result ID"),
    workspaceId: requiredId(value.workspaceId, "Move result workspace"),
    planId: plan.planId,
    activityId: requiredId(value.activityId, "Move activity ID"),
    units,
    completedAt: timestamp(value.completedAt, "Move completion timestamp"),
    cycleStartAt: timestamp(value.cycleStartAt, "Move entry cycle start"),
    cycleEndAt: timestamp(value.cycleEndAt, "Move entry cycle end"),
    cycleIncludedMoves,
    moveCost,
    includedMovesDebited,
    purchasedMovesDebited,
    purchasedLotDebits,
    unfundedMoves,
    subscriptionActive: value.subscriptionActive === true,
    enforcementEnabled: value.enforcementEnabled === true
  };
  const lotDebitTotal = purchasedLotDebits.reduce((total, debit) => total + debit.moves, 0);
  if (entry.workspaceId !== workspaceId
    || !activity
    || activity.availability !== "available"
    || cycleIncludedMoves !== plan.includedMoves
    || moveCost !== activity.moves * units
    || lotDebitTotal !== purchasedMovesDebited
    || includedMovesDebited + purchasedMovesDebited + unfundedMoves !== moveCost
    || (!entry.subscriptionActive && purchasedMovesDebited > 0)
    || (entry.enforcementEnabled && unfundedMoves > 0)
    || Date.parse(entry.cycleEndAt) <= Date.parse(entry.cycleStartAt)
    || Date.parse(entry.completedAt) < Date.parse(entry.cycleStartAt)
    || Date.parse(entry.completedAt) >= Date.parse(entry.cycleEndAt)) {
    fail("move_ledger_entry_invalid", "Move ledger entry is invalid.");
  }
  return entry;
}

function ledgerValue(value) {
  if (!isRecord(value)
    || value.version !== MOVE_LEDGER_SCHEMA_VERSION
    || value.pricingVersion !== PRICING_CONFIGURATION.version) {
    fail("move_ledger_state_invalid", "Move ledger state is invalid.");
  }
  const workspaceId = requiredId(value.workspaceId, "Move ledger workspace");
  const plan = planMoveAllowance(value.planId);
  if (!isRecord(value.cycle)) fail("move_ledger_cycle_invalid", "The billing-cycle boundary is invalid.");
  const cycle = cycleValue(value.cycle.startAt, value.cycle.endAt);
  cycle.includedMoves = integerInRange(value.cycle.includedMoves, "Included Move allowance", 0);
  cycle.remainingMoves = integerInRange(value.cycle.remainingMoves, "Included Move balance", 0);
  if (cycle.includedMoves !== plan.includedMoves || cycle.remainingMoves > cycle.includedMoves) {
    fail("move_ledger_state_invalid", "Move ledger state does not match canonical pricing.");
  }

  const purchasedLots = Array.isArray(value.purchasedLots)
    ? value.purchasedLots.map(item => lotValue(item, workspaceId))
    : fail("move_ledger_lot_invalid", "Purchased Move lot metadata is invalid.");
  const entries = Array.isArray(value.entries)
    ? value.entries.map(item => entryValue(item, workspaceId))
    : fail("move_ledger_entry_invalid", "Move ledger entries are invalid.");

  const lotsById = new Map();
  for (const lot of purchasedLots) {
    if (lotsById.has(lot.lotId)) fail("move_ledger_lot_conflict", "Purchased Move lot identity is duplicated.");
    lotsById.set(lot.lotId, lot);
  }
  const results = new Set();
  const lotBalances = new Map(purchasedLots.map(lot => [lot.lotId, lot.originalMoves]));
  const cycleBalances = new Map();
  for (const entry of entries) {
    if (results.has(entry.resultId)) fail("move_ledger_result_conflict", "Move result identity is duplicated.");
    results.add(entry.resultId);
    const entryStart = Date.parse(entry.cycleStartAt);
    const entryEnd = Date.parse(entry.cycleEndAt);
    const currentStart = Date.parse(cycle.startAt);
    if (entryStart > currentStart
      || (entryStart < currentStart && entryEnd > currentStart)
      || (entryStart === currentStart
        && (entry.cycleEndAt !== cycle.endAt
          || entry.planId !== plan.planId
          || entry.cycleIncludedMoves !== cycle.includedMoves))) {
      fail("move_ledger_cycle_invalid", "Move entry cycle does not match ledger history.");
    }

    const cycleKey = `${entry.cycleStartAt}|${entry.cycleEndAt}`;
    const cycleBalance = cycleBalances.get(cycleKey) || {
      planId: entry.planId,
      includedMoves: entry.cycleIncludedMoves,
      remainingMoves: entry.cycleIncludedMoves
    };
    if (cycleBalance.planId !== entry.planId || cycleBalance.includedMoves !== entry.cycleIncludedMoves) {
      fail("move_ledger_cycle_invalid", "Move entry cycle does not match ledger history.");
    }
    const point = Date.parse(entry.completedAt);
    const eligibleLots = entry.subscriptionActive
      ? purchasedLots
        .map(lot => ({ ...lot, remainingMoves: lotBalances.get(lot.lotId) }))
        .filter(lot => lot.remainingMoves > 0
          && Date.parse(lot.acquiredAt) <= point
          && point < Date.parse(lot.expiresAt))
        .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt)
          || left.acquiredAt.localeCompare(right.acquiredAt)
          || left.lotId.localeCompare(right.lotId))
      : [];
    const expectedDebit = requestedDebits({
      includedMoves: cycleBalance.remainingMoves,
      eligibleLots
    }, entry.moveCost);
    if (entry.includedMovesDebited !== expectedDebit.includedMoves
      || entry.purchasedMovesDebited !== expectedDebit.purchasedMoves
      || entry.unfundedMoves !== expectedDebit.unfundedMoves
      || !sameLotDebits(entry.purchasedLotDebits, expectedDebit.purchasedLots)) {
      fail("move_ledger_entry_invalid", "Move ledger debit order is invalid.");
    }
    cycleBalance.remainingMoves -= expectedDebit.includedMoves;
    cycleBalances.set(cycleKey, cycleBalance);
    for (const debit of expectedDebit.purchasedLots) {
      lotBalances.set(debit.lotId, lotBalances.get(debit.lotId) - debit.moves);
    }
  }
  const currentCycleKey = `${cycle.startAt}|${cycle.endAt}`;
  const currentCycleBalance = cycleBalances.get(currentCycleKey);
  const expectedCurrentRemaining = currentCycleBalance?.remainingMoves ?? cycle.includedMoves;
  if (cycle.remainingMoves !== expectedCurrentRemaining) {
    fail("move_ledger_state_invalid", "Included Move balance does not match ledger entries.");
  }
  for (const lot of purchasedLots) {
    if (lot.remainingMoves !== lotBalances.get(lot.lotId)) {
      fail("move_ledger_state_invalid", "Purchased Move balance does not match ledger entries.");
    }
  }

  return deepFreeze({
    version: MOVE_LEDGER_SCHEMA_VERSION,
    pricingVersion: PRICING_CONFIGURATION.version,
    workspaceId,
    planId: plan.planId,
    cycle,
    purchasedLots,
    entries
  });
}

function eligiblePurchasedLots(ledger, at, subscriptionActive) {
  if (!subscriptionActive) return [];
  const point = Date.parse(at);
  return ledger.purchasedLots
    .filter(lot => lot.remainingMoves > 0
      && Date.parse(lot.acquiredAt) <= point
      && point < Date.parse(lot.expiresAt))
    .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt)
      || left.acquiredAt.localeCompare(right.acquiredAt)
      || left.lotId.localeCompare(right.lotId));
}

function balanceValue(ledger, at, subscriptionActive) {
  const point = Date.parse(at);
  const cycleActive = Date.parse(ledger.cycle.startAt) <= point && point < Date.parse(ledger.cycle.endAt);
  const includedMoves = cycleActive ? ledger.cycle.remainingMoves : 0;
  const eligibleLots = eligiblePurchasedLots(ledger, at, subscriptionActive);
  const purchasedMoves = eligibleLots.reduce((total, lot) => total + lot.remainingMoves, 0);
  return { cycleActive, includedMoves, purchasedMoves, totalMoves: includedMoves + purchasedMoves, eligibleLots };
}

function zeroDebit() {
  return { includedMoves: 0, purchasedMoves: 0, purchasedLots: [], unfundedMoves: 0 };
}

function requestedDebits(balance, moveCost) {
  const includedMoves = Math.min(balance.includedMoves, moveCost);
  let remaining = moveCost - includedMoves;
  const purchasedLots = [];
  for (const lot of balance.eligibleLots) {
    if (remaining === 0) break;
    const moves = Math.min(lot.remainingMoves, remaining);
    if (moves > 0) purchasedLots.push({ lotId: lot.lotId, moves });
    remaining -= moves;
  }
  const purchasedMoves = purchasedLots.reduce((total, debit) => total + debit.moves, 0);
  return { includedMoves, purchasedMoves, purchasedLots, unfundedMoves: remaining };
}

function sameLotDebits(left, right) {
  return left.length === right.length
    && left.every((debit, index) => debit.lotId === right[index].lotId && debit.moves === right[index].moves);
}

function decisionValue({
  allowed,
  reason,
  request,
  enforcementEnabled,
  duplicate = false,
  moveCost = 0,
  balanceSufficient = true,
  wouldDenyIfEnforced = false,
  currentBalance,
  remainingBalance = currentBalance,
  debit = zeroDebit()
}) {
  return deepFreeze({
    allowed,
    reason,
    enforcementEnabled,
    duplicate,
    wouldDenyIfEnforced,
    workspaceId: request.workspaceId,
    resultId: request.resultId,
    activityId: request.activityId,
    outcome: request.outcome,
    units: request.units,
    moveCost,
    balanceSufficient,
    currentBalance,
    remainingBalance,
    debit
  });
}

function requestValue(value, ledger) {
  if (!isRecord(value)) fail("move_ledger_request_invalid", "Move result request is invalid.");
  const request = {
    workspaceId: requiredId(value.workspaceId, "Move result workspace"),
    resultId: requiredId(value.resultId, "Move result ID"),
    activityId: requiredId(value.activityId, "Move activity ID"),
    outcome: typeof value.outcome === "string" ? value.outcome.trim().toLowerCase() : "",
    units: integerInRange(value.units ?? 1, "Move result units", 1, MAX_UNITS),
    completedAt: timestamp(value.completedAt, "Move result timestamp"),
    subscriptionActive: value.subscriptionActive === true
  };
  if (request.workspaceId !== ledger.workspaceId) {
    fail("move_ledger_workspace_mismatch", "Move result workspace does not match the ledger.", 403);
  }
  if (!RESULT_OUTCOMES.has(request.outcome)) fail("move_ledger_outcome_invalid", "Move result outcome is invalid.");
  return request;
}

export function definePurchasedMoveLot({ workspaceId, lotId, moves, acquiredAt } = {}) {
  const canonicalWorkspaceId = requiredId(workspaceId, "Purchased Move lot workspace");
  const canonicalAcquiredAt = timestamp(acquiredAt, "Purchased Move acquisition timestamp");
  const originalMoves = integerInRange(moves, "Purchased Move quantity", 1);
  return deepFreeze({
    lotId: requiredId(lotId, "Purchased Move lot ID"),
    workspaceId: canonicalWorkspaceId,
    acquiredAt: canonicalAcquiredAt,
    expiresAt: calendarMonthsAfter(canonicalAcquiredAt, PURCHASED_MOVE_LIFETIME_MONTHS),
    originalMoves,
    remainingMoves: originalMoves
  });
}

export function createMoveLedger({
  workspaceId,
  planId,
  cycleStartAt,
  cycleEndAt,
  purchasedLots = []
} = {}) {
  const canonicalWorkspaceId = requiredId(workspaceId, "Move ledger workspace");
  const plan = planMoveAllowance(planId);
  const cycle = cycleValue(cycleStartAt, cycleEndAt);
  return ledgerValue({
    version: MOVE_LEDGER_SCHEMA_VERSION,
    pricingVersion: PRICING_CONFIGURATION.version,
    workspaceId: canonicalWorkspaceId,
    planId: plan.planId,
    cycle: { ...cycle, includedMoves: plan.includedMoves, remainingMoves: plan.includedMoves },
    purchasedLots,
    entries: []
  });
}

export function hydrateMoveLedger(value) {
  return ledgerValue(value);
}

export function summarizeMoveLedger({ ledger, at, subscriptionActive = false } = {}) {
  const canonicalLedger = ledgerValue(ledger);
  const canonicalAt = timestamp(at, "Move ledger summary timestamp");
  const balance = balanceValue(canonicalLedger, canonicalAt, subscriptionActive === true);
  const point = Date.parse(canonicalAt);
  const expiredPurchasedMoves = canonicalLedger.purchasedLots
    .filter(lot => Date.parse(lot.expiresAt) <= point)
    .reduce((total, lot) => total + lot.remainingMoves, 0);
  const inactivePurchasedMoves = subscriptionActive === true
    ? 0
    : canonicalLedger.purchasedLots
      .filter(lot => lot.remainingMoves > 0
        && Date.parse(lot.acquiredAt) <= point
        && point < Date.parse(lot.expiresAt))
      .reduce((total, lot) => total + lot.remainingMoves, 0);
  const recorded = canonicalLedger.entries.reduce((totals, entry) => ({
    fundedMoves: totals.fundedMoves + entry.includedMovesDebited + entry.purchasedMovesDebited,
    unfundedMoves: totals.unfundedMoves + entry.unfundedMoves
  }), { fundedMoves: 0, unfundedMoves: 0 });
  return deepFreeze({
    version: canonicalLedger.version,
    pricingVersion: canonicalLedger.pricingVersion,
    workspaceId: canonicalLedger.workspaceId,
    planId: canonicalLedger.planId,
    enforcementEnabled: MOVE_LEDGER_ENFORCEMENT_DEFAULT,
    cycle: {
      startAt: canonicalLedger.cycle.startAt,
      endAt: canonicalLedger.cycle.endAt,
      active: balance.cycleActive,
      includedMoves: canonicalLedger.cycle.includedMoves,
      remainingIncludedMoves: balance.includedMoves
    },
    remainingPurchasedMoves: balance.purchasedMoves,
    expiredPurchasedMoves,
    inactivePurchasedMoves,
    remainingMoves: balance.totalMoves,
    fundedMovesRecorded: recorded.fundedMoves,
    unfundedMovesRecorded: recorded.unfundedMoves,
    recordedResults: canonicalLedger.entries.length
  });
}

export function evaluateMoveAllowance({ ledger, result, enforcementEnabled = MOVE_LEDGER_ENFORCEMENT_DEFAULT } = {}) {
  const canonicalLedger = ledgerValue(ledger);
  if (typeof enforcementEnabled !== "boolean") {
    fail("move_ledger_enforcement_invalid", "Move enforcement configuration is invalid.");
  }
  const request = requestValue(result, canonicalLedger);
  const balance = balanceValue(canonicalLedger, request.completedAt, request.subscriptionActive);
  const currentBalance = deepFreeze({
    includedMoves: balance.includedMoves,
    purchasedMoves: balance.purchasedMoves,
    totalMoves: balance.totalMoves
  });

  if (request.outcome !== "completed") {
    return decisionValue({ allowed: true, reason: "result_not_completed", request, enforcementEnabled, currentBalance });
  }

  const existing = canonicalLedger.entries.find(entry => entry.resultId === request.resultId);
  if (existing) {
    if (existing.activityId !== request.activityId
      || existing.units !== request.units
      || existing.completedAt !== request.completedAt) {
      fail("move_ledger_idempotency_conflict", "Move result identity conflicts with a recorded result.", 409);
    }
    return decisionValue({
      allowed: true,
      reason: "duplicate_result",
      request,
      enforcementEnabled,
      duplicate: true,
      moveCost: existing.moveCost,
      currentBalance
    });
  }

  if (ZERO_MOVE_IDS.has(request.activityId)) {
    return decisionValue({ allowed: true, reason: "zero_move_activity", request, enforcementEnabled, currentBalance });
  }

  const activity = WEIGHTS_BY_ID.get(request.activityId);
  if (!activity) {
    return decisionValue({ allowed: false, reason: "activity_unsupported", request, enforcementEnabled, currentBalance });
  }
  if (activity.availability !== "available") {
    return decisionValue({ allowed: false, reason: "activity_planned", request, enforcementEnabled, currentBalance });
  }
  if (!balance.cycleActive) {
    return decisionValue({ allowed: false, reason: "billing_cycle_out_of_scope", request, enforcementEnabled, currentBalance });
  }

  const moveCost = integerInRange(activity.moves * request.units, "Move result cost", 1);
  const plannedDebit = requestedDebits(balance, moveCost);
  const balanceSufficient = plannedDebit.unfundedMoves === 0;
  const wouldDenyIfEnforced = !balanceSufficient;
  if (enforcementEnabled && !balanceSufficient) {
    return decisionValue({
      allowed: false,
      reason: "insufficient_balance",
      request,
      enforcementEnabled,
      moveCost,
      balanceSufficient,
      wouldDenyIfEnforced,
      currentBalance
    });
  }

  const remainingBalance = deepFreeze({
    includedMoves: currentBalance.includedMoves - plannedDebit.includedMoves,
    purchasedMoves: currentBalance.purchasedMoves - plannedDebit.purchasedMoves,
    totalMoves: currentBalance.totalMoves - plannedDebit.includedMoves - plannedDebit.purchasedMoves
  });
  return decisionValue({
    allowed: true,
    reason: balanceSufficient ? "balance_available" : "enforcement_disabled",
    request,
    enforcementEnabled,
    moveCost,
    balanceSufficient,
    wouldDenyIfEnforced,
    currentBalance,
    remainingBalance,
    debit: deepFreeze(plannedDebit)
  });
}

export function recordMoveResult({ ledger, result, enforcementEnabled = MOVE_LEDGER_ENFORCEMENT_DEFAULT } = {}) {
  const canonicalLedger = ledgerValue(ledger);
  const request = requestValue(result, canonicalLedger);
  const decision = evaluateMoveAllowance({ ledger: canonicalLedger, result: request, enforcementEnabled });
  if (!decision.allowed || decision.duplicate || decision.moveCost === 0) {
    return deepFreeze({ ledger: canonicalLedger, decision: deepFreeze({ ...decision, recorded: false }) });
  }

  const debitsByLot = new Map(decision.debit.purchasedLots.map(debit => [debit.lotId, debit.moves]));
  const purchasedLots = canonicalLedger.purchasedLots.map(lot => ({
    ...lot,
    remainingMoves: lot.remainingMoves - (debitsByLot.get(lot.lotId) || 0)
  }));
  const entry = {
    resultId: request.resultId,
    workspaceId: request.workspaceId,
    planId: canonicalLedger.planId,
    activityId: request.activityId,
    units: request.units,
    completedAt: request.completedAt,
    cycleStartAt: canonicalLedger.cycle.startAt,
    cycleEndAt: canonicalLedger.cycle.endAt,
    cycleIncludedMoves: canonicalLedger.cycle.includedMoves,
    moveCost: decision.moveCost,
    includedMovesDebited: decision.debit.includedMoves,
    purchasedMovesDebited: decision.debit.purchasedMoves,
    purchasedLotDebits: decision.debit.purchasedLots,
    unfundedMoves: decision.debit.unfundedMoves,
    subscriptionActive: request.subscriptionActive,
    enforcementEnabled
  };
  const nextLedger = ledgerValue({
    ...canonicalLedger,
    cycle: {
      ...canonicalLedger.cycle,
      remainingMoves: canonicalLedger.cycle.remainingMoves - decision.debit.includedMoves
    },
    purchasedLots,
    entries: [...canonicalLedger.entries, entry]
  });
  return deepFreeze({ ledger: nextLedger, decision: deepFreeze({ ...decision, recorded: true }) });
}

export function rollMoveLedgerCycle({ ledger, planId, cycleStartAt, cycleEndAt } = {}) {
  const canonicalLedger = ledgerValue(ledger);
  const nextCycle = cycleValue(cycleStartAt, cycleEndAt);
  if (Date.parse(nextCycle.startAt) < Date.parse(canonicalLedger.cycle.endAt)) {
    fail("move_ledger_cycle_conflict", "The next billing cycle overlaps the current cycle.", 409);
  }
  const plan = planMoveAllowance(planId ?? canonicalLedger.planId);
  return ledgerValue({
    ...canonicalLedger,
    planId: plan.planId,
    cycle: {
      ...nextCycle,
      includedMoves: plan.includedMoves,
      remainingMoves: plan.includedMoves
    }
  });
}
