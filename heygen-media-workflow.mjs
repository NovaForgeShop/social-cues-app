import crypto from "node:crypto";
import {
  HEYGEN_CAPABILITY_DEFINITIONS,
  HEYGEN_MEDIA_ACTIONS
} from "./heygen-integration.mjs";

const versionCreatingActions = new Set([
  "prompt_to_video",
  "revise_video",
  "create_variant",
  "avatar_video",
  "template_video",
  "replace_audio",
  "translate_video",
  "remove_fillers"
]);
const lineageRequiredActions = new Set([
  "revise_video",
  "create_variant",
  "replace_audio",
  "translate_video",
  "remove_fillers"
]);

export class HeyGenWorkflowError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "HeyGenWorkflowError";
    this.code = code;
    this.status = status;
  }
}

function workflowError(code, message, status = 400) {
  return new HeyGenWorkflowError(code, message, status);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function clean(value = "", max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

function identifier(value = "", max = 500) {
  const candidate = clean(value, max);
  if (!candidate || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)) return "";
  return candidate;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function requestFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("base64url");
}

function owns(record, actorId, workspaceId) {
  return Boolean(record
    && String(record.ownerUserId || record.createdBy || "") === String(actorId)
    && String(record.workspaceId || "") === String(workspaceId));
}

function connectedAccount(model, actorId, workspaceId) {
  return (model.connectedAccounts || []).find(account => account.platform === "heygen"
    && account.oauthProvider === "heygen"
    && account.status === "connected"
    && owns(account, actorId, workspaceId)) || null;
}

function publicJob(job = {}) {
  return {
    id: job.id,
    provider: "heygen",
    action: job.action,
    operationId: job.operationId,
    status: job.status,
    sourceAssetId: job.sourceAssetId || null,
    parentVersionId: job.parentVersionId || null,
    outputAssetId: job.outputAssetId || null,
    providerJobId: job.providerJobId || null,
    sessionId: job.sessionId || null,
    capability: clone(job.capability || null),
    message: job.message || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || null,
    workspaceId: job.workspaceId,
    ownerUserId: job.ownerUserId
  };
}

function publicVersion(asset = {}) {
  return {
    id: asset.id,
    provider: "heygen",
    kind: asset.kind,
    title: asset.title,
    status: asset.status,
    contentType: asset.contentType,
    previewUrl: asset.previewUrl || null,
    providerResourceId: asset.providerResourceId || null,
    sourceAssetId: asset.sourceAssetId || null,
    parentVersionId: asset.parentVersionId || null,
    rootAssetId: asset.rootAssetId || null,
    versionNumber: asset.versionNumber,
    immutable: true,
    heygenSessionId: asset.heygenSessionId || null,
    heygenJobId: asset.heygenJobId || null,
    operationId: asset.operationId,
    createdAt: asset.createdAt,
    workspaceId: asset.workspaceId,
    ownerUserId: asset.ownerUserId
  };
}

function safePublicJob(job) {
  return publicJob(job);
}

function versionRoot(parent, sourceAssetId) {
  return parent?.rootAssetId || parent?.id || sourceAssetId || "";
}

function nextVersionNumber(model, rootAssetId, actorId, workspaceId) {
  const versions = (model.mediaAssets || []).filter(asset => asset.provider === "heygen"
    && owns(asset, actorId, workspaceId)
    && String(asset.rootAssetId || asset.id) === String(rootAssetId));
  return versions.reduce((max, asset) => Math.max(max, Number(asset.versionNumber || 0)), 0) + 1;
}

export function createHeyGenMediaWorkflow({
  loadModel,
  saveModel,
  authorize,
  invoke,
  repository = null,
  clock = () => new Date(),
  createId = prefix => `${prefix}-${crypto.randomBytes(12).toString("base64url")}`,
  mutationsEnabled = true,
  onCompletedResult = null
} = {}) {
  if ((!repository && (typeof loadModel !== "function" || typeof saveModel !== "function")) || typeof authorize !== "function" || typeof invoke !== "function") {
    throw new TypeError("HeyGen workflow dependencies are required");
  }
  const workspaceLocks = new Map();

  async function withWorkspaceLock(workspaceId, callback) {
    const previous = workspaceLocks.get(workspaceId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    workspaceLocks.set(workspaceId, queued);
    await previous;
    try { return await callback(); }
    finally {
      release();
      if (workspaceLocks.get(workspaceId) === queued) workspaceLocks.delete(workspaceId);
    }
  }

  async function requireContext(context, action) {
    const actorId = identifier(context?.actorId);
    const workspaceId = identifier(context?.workspaceId);
    if (!actorId || !workspaceId) throw workflowError("heygen_not_authenticated", "Sign in before using HeyGen.", 401);
    if (!(await authorize({ actorId, workspaceId, action }))) {
      throw workflowError("heygen_not_authorized", "This HeyGen record belongs to another workspace.", 403);
    }
    return { actorId, workspaceId };
  }

  function requireAccount(model, actorId, workspaceId) {
    const account = connectedAccount(model, actorId, workspaceId);
    if (!account) throw workflowError("heygen_account_required", "Connect this workspace's HeyGen account first.", 409);
    return account;
  }

  function validateLineage(model, action, args, actorId, workspaceId) {
    const sourceAssetId = identifier(args.sourceAssetId || "");
    const parentVersionId = identifier(args.parentVersionId || "");
    const parent = parentVersionId
      ? (model.mediaAssets || []).find(asset => asset.id === parentVersionId && asset.provider === "heygen" && owns(asset, actorId, workspaceId))
      : null;
    if (parentVersionId && !parent) throw workflowError("heygen_parent_not_found", "That HeyGen version is not available in this workspace.", 404);
    const source = sourceAssetId
      ? (model.mediaAssets || []).find(asset => asset.id === sourceAssetId && owns(asset, actorId, workspaceId))
      : null;
    if (sourceAssetId && !source) throw workflowError("heygen_source_not_found", "That source asset is not available in this workspace.", 404);
    if (lineageRequiredActions.has(action) && !parent && !source) {
      throw workflowError("heygen_lineage_required", "Choose a source asset or prior HeyGen version for this transformation.", 422);
    }
    return { sourceAssetId, parentVersionId, parent, source };
  }

  async function reserve(context, input) {
    const { actorId, workspaceId } = await requireContext(context, "create");
    const action = clean(input?.action, 80);
    const operationId = identifier(input?.operationId);
    if (!HEYGEN_MEDIA_ACTIONS.includes(action) || !HEYGEN_CAPABILITY_DEFINITIONS[action]) {
      throw workflowError("heygen_action_unsupported", "That HeyGen media action is not supported.", 400);
    }
    if (!operationId) throw workflowError("heygen_operation_id_invalid", "A stable operation id is required.", 400);
    if (!mutationsEnabled && HEYGEN_CAPABILITY_DEFINITIONS[action].mutates) {
      throw workflowError("heygen_durable_repository_pending", "HeyGen generation remains unavailable until durable hosted media persistence is approved.", 503);
    }
    const args = input?.args && typeof input.args === "object" && !Array.isArray(input.args) ? clone(input.args) : {};
    delete args.operationId;
    const allowedArguments = HEYGEN_CAPABILITY_DEFINITIONS[action].allowedArguments.filter(key => key !== "operationId");
    if (Object.keys(args).length > 11
      || Object.keys(args).some(key => !allowedArguments.includes(key))
      || Object.values(args).some(value => value !== null && !["string", "number", "boolean"].includes(typeof value))) {
      throw workflowError("heygen_arguments_invalid", "HeyGen media arguments include an unsupported value.", 400);
    }
    const fingerprint = requestFingerprint({ action, args });
    if (repository) {
      return repository.reserveJob({
        actorId,
        workspaceId,
        action,
        operationId,
        requestFingerprint: fingerprint,
        requestArguments: args,
        sourceAssetId: identifier(args.sourceAssetId || "") || null,
        parentVersionId: identifier(args.parentVersionId || "") || null
      });
    }
    return withWorkspaceLock(workspaceId, async () => {
      const model = await loadModel({ actorId, workspaceId });
      const account = requireAccount(model, actorId, workspaceId);
      const rawRemainingCredits = account.profile?.credits?.remaining;
      const hasRemainingCredits = rawRemainingCredits !== null
        && rawRemainingCredits !== undefined
        && rawRemainingCredits !== ""
        && Number.isFinite(Number(rawRemainingCredits));
      const remainingCredits = hasRemainingCredits ? Number(rawRemainingCredits) : null;
      if (account.profile?.credits?.available === false || (hasRemainingCredits && remainingCredits <= 0)) {
        throw workflowError("heygen_credits_depleted", "This HeyGen account has no available generation credits.", 409);
      }
      if (account.profile?.credits?.available !== true && !hasRemainingCredits) {
        throw workflowError("heygen_credits_unverified", "Refresh HeyGen account readiness before starting generation.", 409);
      }
      model.mediaRenderJobs = Array.isArray(model.mediaRenderJobs) ? model.mediaRenderJobs : [];
      const existing = model.mediaRenderJobs.find(job => job.provider === "heygen"
        && job.operationId === operationId
        && owns(job, actorId, workspaceId));
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw workflowError("heygen_operation_conflict", "That operation id was already used for different work.", 409);
        }
        return { replayed: true, job: safePublicJob(existing), requestArguments: clone(existing.request), account: clone(account) };
      }
      const lineage = validateLineage(model, action, args, actorId, workspaceId);
      const now = clock().toISOString();
      const job = {
        id: createId("heygen-job"),
        provider: "heygen",
        action,
        operationId,
        fingerprint,
        status: "submitted",
        request: args,
        sourceAssetId: lineage.sourceAssetId || null,
        parentVersionId: lineage.parentVersionId || null,
        createdAt: now,
        updatedAt: now,
        createdBy: actorId,
        ownerUserId: actorId,
        workspaceId
      };
      model.mediaRenderJobs.unshift(job);
      await saveModel(model, { actorId, workspaceId, reason: "heygen-job-reserved" });
      return { replayed: false, job: safePublicJob(job), requestArguments: clone(args), account: clone(account) };
    });
  }

  async function markFailure(context, jobId, error) {
    const { actorId, workspaceId } = await requireContext(context, "update");
    if (repository) {
      return repository.transitionJob({
        actorId,
        workspaceId,
        jobId,
        state: "failed",
        resultFingerprint: requestFingerprint({ state: "failed", failureCode: clean(error?.code || "heygen_provider_failed", 100) }),
        failureCode: clean(error?.code || "heygen_provider_failed", 100),
        publicMessage: "HeyGen could not complete this operation."
      });
    }
    return withWorkspaceLock(workspaceId, async () => {
      const model = await loadModel({ actorId, workspaceId });
      const job = (model.mediaRenderJobs || []).find(item => item.id === jobId && item.provider === "heygen" && owns(item, actorId, workspaceId));
      if (!job) throw workflowError("heygen_job_not_found", "That HeyGen job is not available in this workspace.", 404);
      job.status = "failed";
      job.message = "HeyGen could not complete this operation.";
      job.errorCode = clean(error?.code || "heygen_provider_failed", 100);
      job.updatedAt = clock().toISOString();
      await saveModel(model, { actorId, workspaceId, reason: "heygen-job-failed" });
      return safePublicJob(job);
    });
  }

  async function applyOutcome(context, jobId, invocation) {
    const { actorId, workspaceId } = await requireContext(context, "update");
    if (repository) {
      const outcome = invocation?.outcome || {};
      const state = outcome.status === "completed" ? "completed" : outcome.status === "failed" ? "failed" : "processing";
      const providerJobId = identifier(outcome.providerJobId || "") || null;
      const sessionId = identifier(outcome.sessionId || "") || null;
      const capabilityId = clean(invocation?.capability?.id || "", 120) || null;
      const capabilityToolName = clean(invocation?.capability?.toolName || "", 200) || null;
      const providerResourceId = identifier(outcome.resourceId || "") || null;
      const previewUrl = clean(outcome.previewUrl || "", 2000) || null;
      const title = clean(outcome.title || "", 200) || null;
      const failureCode = state === "failed" ? clean(outcome.failureCode || "heygen_provider_failed", 100) : null;
      const publicMessage = clean(outcome.message || "", 500) || (state === "failed" ? "HeyGen could not complete this operation." : null);
      const result = await repository.transitionJob({
        actorId,
        workspaceId,
        jobId,
        state,
        resultFingerprint: requestFingerprint({
          state,
          providerJobId,
          sessionId,
          capabilityId,
          capabilityToolName,
          providerResourceId,
          previewUrl,
          title,
          failureCode,
          publicMessage
        }),
        providerJobId,
        sessionId,
        capabilityId,
        capabilityToolName,
        providerResourceId,
        previewUrl,
        title,
        failureCode,
        publicMessage
      });
      if (result.job?.status === "completed" && typeof onCompletedResult === "function") {
        await onCompletedResult({ actorId, workspaceId, job: result.job, version: result.version });
      }
      return result;
    }
    return withWorkspaceLock(workspaceId, async () => {
      const model = await loadModel({ actorId, workspaceId });
      const job = (model.mediaRenderJobs || []).find(item => item.id === jobId && item.provider === "heygen" && owns(item, actorId, workspaceId));
      if (!job) throw workflowError("heygen_job_not_found", "That HeyGen job is not available in this workspace.", 404);
      if (["completed", "failed"].includes(job.status)) return { replayed: true, job: safePublicJob(job), version: job.outputAssetId ? publicVersion((model.mediaAssets || []).find(asset => asset.id === job.outputAssetId)) : null };
      const outcome = invocation?.outcome || {};
      const now = clock().toISOString();
      job.status = outcome.status === "completed" ? "completed" : outcome.status === "failed" ? "failed" : "processing";
      job.providerJobId = identifier(outcome.providerJobId || "") || job.providerJobId || null;
      job.sessionId = identifier(outcome.sessionId || "") || job.sessionId || null;
      job.capability = invocation?.capability ? { id: invocation.capability.id, toolName: invocation.capability.toolName } : job.capability || null;
      job.message = clean(outcome.message || "", 500);
      job.updatedAt = now;
      let version = null;
      if (job.status === "processing" && !job.providerJobId && !job.sessionId) {
        throw workflowError("heygen_result_invalid", "HeyGen returned no trackable generation identity.", 502);
      }
      if (job.status === "completed" && versionCreatingActions.has(job.action)) {
        const resourceId = identifier(outcome.resourceId || "");
        const previewUrl = clean(outcome.previewUrl || "", 2000);
        if (!resourceId && !previewUrl) throw workflowError("heygen_result_invalid", "HeyGen returned no generated video resource.", 502);
        model.mediaAssets = Array.isArray(model.mediaAssets) ? model.mediaAssets : [];
        const parent = job.parentVersionId
          ? model.mediaAssets.find(asset => asset.id === job.parentVersionId && asset.provider === "heygen" && owns(asset, actorId, workspaceId))
          : null;
        const rootAssetId = versionRoot(parent, job.sourceAssetId) || createId("heygen-lineage");
        version = {
          id: createId("heygen-version"),
          provider: "heygen",
          kind: "video",
          title: clean(job.request?.title || `${HEYGEN_CAPABILITY_DEFINITIONS[job.action].label} result`, 200),
          status: "generated",
          contentType: "video/mp4",
          previewUrl: previewUrl || null,
          providerResourceId: resourceId || null,
          sourceAssetId: job.sourceAssetId || parent?.sourceAssetId || null,
          parentVersionId: parent?.id || null,
          rootAssetId,
          versionNumber: nextVersionNumber(model, rootAssetId, actorId, workspaceId),
          immutable: true,
          heygenSessionId: job.sessionId || null,
          heygenJobId: job.providerJobId || null,
          operationId: job.operationId,
          createdAt: now,
          createdBy: actorId,
          ownerUserId: actorId,
          workspaceId
        };
        model.mediaAssets.unshift(version);
        job.outputAssetId = version.id;
        job.completedAt = now;
      }
      await saveModel(model, { actorId, workspaceId, reason: "heygen-job-updated" });
      if (job.status === "completed" && typeof onCompletedResult === "function") {
        await onCompletedResult({ actorId, workspaceId, job: safePublicJob(job), version: version ? publicVersion(version) : null });
      }
      return { replayed: false, job: safePublicJob(job), version: version ? publicVersion(version) : null };
    });
  }

  async function createJob(context, input) {
    const reservation = await reserve(context, input);
    if (reservation.replayed) return { ok: true, replayed: true, job: reservation.job, version: null };
    try {
      const invocation = await invoke({
        account: reservation.account,
        action: reservation.job.action,
        args: reservation.requestArguments,
        operationId: reservation.job.operationId,
        actorId: reservation.job.ownerUserId,
        workspaceId: reservation.job.workspaceId
      });
      return { ok: true, ...(await applyOutcome(context, reservation.job.id, invocation)) };
    } catch (error) {
      await markFailure(context, reservation.job.id, error).catch(() => null);
      throw error;
    }
  }

  async function pollJob(context, jobId) {
    const { actorId, workspaceId } = await requireContext(context, "read");
    if (repository) {
      const snapshot = await repository.getJobContext({ actorId, workspaceId, jobId });
      if (["completed", "failed"].includes(snapshot.job.status)) {
        return { ok: true, replayed: true, job: snapshot.job, version: null };
      }
      try {
        const invocation = await invoke({
          account: snapshot.account,
          action: "job_status",
          args: {
            providerJobId: snapshot.job.providerJobId || "",
            sessionId: snapshot.job.sessionId || "",
            operationId: snapshot.job.operationId
          },
          operationId: snapshot.job.operationId,
          actorId,
          workspaceId
        });
        return { ok: true, ...(await applyOutcome(context, snapshot.job.id, invocation)) };
      } catch (error) {
        if (error?.code !== "mcp_capability_unavailable") await markFailure(context, snapshot.job.id, error).catch(() => null);
        throw error;
      }
    }
    const snapshot = await withWorkspaceLock(workspaceId, async () => {
      const model = await loadModel({ actorId, workspaceId });
      const found = (model.mediaRenderJobs || []).find(item => item.id === jobId && item.provider === "heygen" && owns(item, actorId, workspaceId));
      if (!found) throw workflowError("heygen_job_not_found", "That HeyGen job is not available in this workspace.", 404);
      const account = requireAccount(model, actorId, workspaceId);
      return { job: clone(found), account: clone(account) };
    });
    const { job } = snapshot;
    if (["completed", "failed"].includes(job.status)) return { ok: true, replayed: true, job: safePublicJob(job), version: null };
    try {
      const invocation = await invoke({
        account: snapshot.account,
        action: "job_status",
        args: { providerJobId: job.providerJobId || "", sessionId: job.sessionId || "", operationId: job.operationId },
        operationId: job.operationId,
        actorId,
        workspaceId
      });
      return { ok: true, ...(await applyOutcome(context, job.id, invocation)) };
    } catch (error) {
      if (error?.code !== "mcp_capability_unavailable") await markFailure(context, job.id, error).catch(() => null);
      throw error;
    }
  }

  async function listJobs(context) {
    const { actorId, workspaceId } = await requireContext(context, "read");
    if (repository) return repository.listJobs({ actorId, workspaceId });
    const model = await loadModel({ actorId, workspaceId });
    return (model.mediaRenderJobs || []).filter(job => job.provider === "heygen" && owns(job, actorId, workspaceId)).map(safePublicJob);
  }

  async function listVersions(context) {
    const { actorId, workspaceId } = await requireContext(context, "read");
    if (repository) return repository.listVersions({ actorId, workspaceId });
    const model = await loadModel({ actorId, workspaceId });
    return (model.mediaAssets || []).filter(asset => asset.provider === "heygen" && owns(asset, actorId, workspaceId)).map(publicVersion);
  }

  return Object.freeze({ createJob, pollJob, listJobs, listVersions });
}

export function sanitizeHeyGenWorkflowError(error) {
  return Object.freeze({
    ok: false,
    code: error instanceof HeyGenWorkflowError ? error.code : clean(error?.code || "heygen_operation_failed", 100),
    error: error instanceof HeyGenWorkflowError ? error.message : "HeyGen could not complete this operation.",
    status: error instanceof HeyGenWorkflowError ? error.status : Number(error?.status || 503)
  });
}
