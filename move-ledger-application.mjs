import { createHash } from "node:crypto";
import {
  MOVE_LEDGER_ENFORCEMENT_DEFAULT,
  createMoveLedger,
  reconcilePurchasedMoveLots,
  recordMoveResult,
  rollMoveLedgerCycle,
  summarizeMoveLedger
} from "./move-ledger.mjs";
import { assertMoveLedgerRepository } from "./move-ledger-repository.mjs";

export const MOVE_LEDGER_APPLICATION_VERSION = "social-cues.move-ledger-application.v1";
export const MOVE_LEDGER_RELEASE_STAGE = "shadow-only";

const CANONICAL_PLAN_IDS = new Set(["business", "growth", "agency"]);
const RESULT_KEYS = new Set(["activityId", "completedAt", "outcome", "resultId", "units"]);

export class MoveLedgerApplicationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "MoveLedgerApplicationError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status = 400) {
  throw new MoveLedgerApplicationError(code, status);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requiredText(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) fail("move_ledger_application_input_invalid");
  return normalized;
}

function requestValue(value) {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "actorId,result,workspaceId"
    || !isRecord(value.result)
    || Object.keys(value.result).some(key => !RESULT_KEYS.has(key))
    || !["activityId", "completedAt", "outcome", "resultId"].every(key => Object.hasOwn(value.result, key))) {
    fail("move_ledger_application_input_invalid");
  }
  return {
    actorId: requiredText(value.actorId),
    workspaceId: requiredText(value.workspaceId),
    result: { ...value.result }
  };
}

function trustedFactsValue(value, workspaceId) {
  const factsWorkspaceId = typeof value?.workspaceId === "string" ? value.workspaceId.trim() : "";
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "cycleEndAt,cycleStartAt,planId,subscriptionActive,workspaceId"
    || value.subscriptionActive !== true && value.subscriptionActive !== false
    || factsWorkspaceId !== workspaceId
    || !CANONICAL_PLAN_IDS.has(value.planId)) {
    fail("move_ledger_trusted_facts_invalid", 503);
  }
  try {
    const canonical = createMoveLedger({
      workspaceId,
      planId: value.planId,
      cycleStartAt: value.cycleStartAt,
      cycleEndAt: value.cycleEndAt
    });
    return deepFreeze({
      workspaceId,
      planId: canonical.planId,
      cycleStartAt: canonical.cycle.startAt,
      cycleEndAt: canonical.cycle.endAt,
      subscriptionActive: value.subscriptionActive
    });
  } catch {
    fail("move_ledger_trusted_facts_invalid", 503);
  }
}

function alignedLedger(ledger, facts) {
  if (ledger.workspaceId !== facts.workspaceId) fail("move_ledger_trusted_facts_invalid", 503);
  if (ledger.cycle.startAt === facts.cycleStartAt) {
    if (ledger.cycle.endAt !== facts.cycleEndAt || ledger.planId !== facts.planId) {
      fail("move_ledger_trusted_cycle_conflict", 409);
    }
    return ledger;
  }
  try {
    return rollMoveLedgerCycle({
      ledger,
      planId: facts.planId,
      cycleStartAt: facts.cycleStartAt,
      cycleEndAt: facts.cycleEndAt
    });
  } catch {
    fail("move_ledger_trusted_cycle_conflict", 409);
  }
}

function sameLedger(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationIdFor(resultId, ledger) {
  const digest = createHash("sha256")
    .update(resultId)
    .update("\0")
    .update(JSON.stringify(ledger))
    .digest("hex");
  return `move-write-${digest.slice(0, 48)}`;
}

function safeResult(decision, ledger, revision, facts, at) {
  const summary = summarizeMoveLedger({
    ledger,
    at,
    subscriptionActive: facts.subscriptionActive
  });
  return deepFreeze({
    ok: true,
    releaseStage: MOVE_LEDGER_RELEASE_STAGE,
    shadowOnly: true,
    enforcementEnabled: false,
    allowed: decision.allowed,
    reason: decision.reason,
    recorded: decision.recorded === true,
    duplicate: decision.duplicate === true,
    moveCost: decision.moveCost,
    balanceSufficient: decision.balanceSufficient,
    wouldDenyIfEnforced: decision.wouldDenyIfEnforced,
    revision: { ...revision },
    balance: {
      workspaceId: summary.workspaceId,
      planId: summary.planId,
      cycle: { ...summary.cycle },
      remainingPurchasedMoves: summary.remainingPurchasedMoves,
      remainingMoves: summary.remainingMoves,
      fundedMovesRecorded: summary.fundedMovesRecorded,
      unfundedMovesRecorded: summary.unfundedMovesRecorded,
      recordedResults: summary.recordedResults
    }
  });
}

export function createMoveLedgerApplication({
  repository,
  resolveTrustedLedgerFacts,
  resolveTrustedPurchasedLots = async () => [],
  maxCasAttempts = 4
} = {}) {
  assertMoveLedgerRepository(repository);
  if (typeof resolveTrustedLedgerFacts !== "function"
    || typeof resolveTrustedPurchasedLots !== "function"
    || !Number.isSafeInteger(maxCasAttempts)
    || maxCasAttempts < 1
    || maxCasAttempts > 32
    || MOVE_LEDGER_ENFORCEMENT_DEFAULT !== false) {
    throw new TypeError("move_ledger_application_options_invalid");
  }

  async function recordResult(input = {}) {
    const request = requestValue(input);
    const trustedContext = deepFreeze({
      actorId: request.actorId,
      workspaceId: request.workspaceId,
      completedAt: request.result.completedAt
    });
    let facts;
    let purchasedLots;
    try {
      facts = trustedFactsValue(await resolveTrustedLedgerFacts(trustedContext), request.workspaceId);
      purchasedLots = await resolveTrustedPurchasedLots(trustedContext);
    } catch (error) {
      if (error instanceof MoveLedgerApplicationError) throw error;
      fail("move_ledger_trusted_boundary_unavailable", 503);
    }
    if (!Array.isArray(purchasedLots)) fail("move_ledger_trusted_lots_invalid", 503);

    const initialBase = createMoveLedger({
      workspaceId: request.workspaceId,
      planId: facts.planId,
      cycleStartAt: facts.cycleStartAt,
      cycleEndAt: facts.cycleEndAt
    });
    let initialLedger;
    try {
      initialLedger = reconcilePurchasedMoveLots({ ledger: initialBase, purchasedLots });
    } catch {
      fail("move_ledger_trusted_lots_invalid", 503);
    }

    for (let attempt = 1; attempt <= maxCasAttempts; attempt += 1) {
      let current;
      try {
        current = await repository.load({
          actorId: request.actorId,
          workspaceId: request.workspaceId
        });
      } catch (error) {
        if (error?.code !== "move_ledger_not_found") throw error;
        current = await repository.createIfAbsent({
          actorId: request.actorId,
          workspaceId: request.workspaceId,
          ledger: initialLedger
        });
      }

      let prepared = alignedLedger(current.ledger, facts);
      try {
        prepared = reconcilePurchasedMoveLots({ ledger: prepared, purchasedLots });
      } catch {
        fail("move_ledger_trusted_lots_invalid", 503);
      }
      const recorded = recordMoveResult({
        ledger: prepared,
        result: {
          workspaceId: request.workspaceId,
          ...request.result,
          subscriptionActive: facts.subscriptionActive
        },
        enforcementEnabled: false
      });

      if (sameLedger(current.ledger, recorded.ledger)) {
        return safeResult(recorded.decision, recorded.ledger, current.revision, facts, request.result.completedAt);
      }

      try {
        const saved = await repository.compareAndSet({
          actorId: request.actorId,
          workspaceId: request.workspaceId,
          operationId: operationIdFor(request.result.resultId, recorded.ledger),
          expectedRevision: current.revision,
          ledger: recorded.ledger
        });
        const acknowledged = saved.replayed === true
          ? { ...recorded.decision, reason: "duplicate_result", recorded: false, duplicate: true }
          : recorded.decision;
        return safeResult(acknowledged, saved.ledger, saved.revision, facts, request.result.completedAt);
      } catch (error) {
        if (error?.code !== "move_ledger_revision_conflict") throw error;
        if (attempt === maxCasAttempts) fail("move_ledger_revision_exhausted", 409);
      }
    }
    fail("move_ledger_revision_exhausted", 409);
  }

  return deepFreeze({
    version: MOVE_LEDGER_APPLICATION_VERSION,
    releaseStage: MOVE_LEDGER_RELEASE_STAGE,
    recordResult
  });
}
