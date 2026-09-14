import assert from "node:assert/strict";
import test from "node:test";

import {
  createHeyGenMediaWorkflow,
  sanitizeHeyGenWorkflowError
} from "./heygen-media-workflow.mjs";

function account(actorId, workspaceId, credits = { available: true, remaining: 50 }) {
  return {
    id: `account-${actorId}`,
    platform: "heygen",
    oauthProvider: "heygen",
    providerAccountId: `provider-${actorId}`,
    status: "connected",
    ownerUserId: actorId,
    workspaceId,
    profile: { credits }
  };
}

function workflowFixture({ mutationEnabled = true, invokeImpl = null } = {}) {
  let id = 0;
  let saves = 0;
  let invokes = 0;
  const authorized = new Set(["user-a:workspace-a", "user-b:workspace-b"]);
  const model = {
    connectedAccounts: [account("user-a", "workspace-a"), account("user-b", "workspace-b")],
    mediaRenderJobs: [],
    mediaAssets: []
  };
  const invoke = async input => {
    invokes += 1;
    if (invokeImpl) return invokeImpl(input, invokes);
    return {
      capability: { id: input.action, toolName: `tool-${input.action}` },
      outcome: {
        status: "completed",
        providerJobId: `provider-job-${invokes}`,
        sessionId: `session-${invokes}`,
        resourceId: `resource-${invokes}`,
        previewUrl: `https://files.heygen.com/result-${invokes}.mp4`
      }
    };
  };
  const workflow = createHeyGenMediaWorkflow({
    mutationsEnabled: mutationEnabled,
    authorize: async ({ actorId, workspaceId }) => authorized.has(`${actorId}:${workspaceId}`),
    loadModel: async () => model,
    saveModel: async () => { saves += 1; },
    invoke,
    clock: () => new Date("2026-09-13T12:00:00.000Z"),
    createId: prefix => `${prefix}-${++id}`
  });
  return {
    model,
    workflow,
    contextA: { actorId: "user-a", workspaceId: "workspace-a" },
    contextB: { actorId: "user-b", workspaceId: "workspace-b" },
    counts: () => ({ saves, invokes })
  };
}

test("concurrent duplicate operations invoke HeyGen once and create one immutable version", async () => {
  let releaseInvocation;
  const invocationGate = new Promise(resolve => { releaseInvocation = resolve; });
  const fixture = workflowFixture({
    invokeImpl: async (input, count) => {
      await invocationGate;
      return {
        capability: { id: input.action, toolName: "video_agent" },
        outcome: { status: "completed", providerJobId: `provider-job-${count}`, sessionId: "session-a", resourceId: "resource-a" }
      };
    }
  });
  const input = { action: "prompt_to_video", args: { prompt: "Launch video", title: "Launch" }, operationId: "operation-a" };
  const first = fixture.workflow.createJob(fixture.contextA, input);
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = await fixture.workflow.createJob(fixture.contextA, input);
  assert.equal(duplicate.replayed, true);
  assert.equal(duplicate.job.operationId, "operation-a");
  releaseInvocation();
  const completed = await first;
  assert.equal(completed.replayed, false);
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.version.immutable, true);
  assert.equal(fixture.counts().invokes, 1);
  assert.equal(fixture.model.mediaRenderJobs.length, 1);
  assert.equal(fixture.model.mediaAssets.length, 1);
  assert.equal(fixture.model.mediaRenderJobs[0].outputAssetId, fixture.model.mediaAssets[0].id);

  await assert.rejects(
    fixture.workflow.createJob(fixture.contextA, { ...input, args: { prompt: "Different launch" } }),
    error => error.code === "heygen_operation_conflict"
  );
});

test("revisions preserve immutable lineage and workspace-local version numbers", async () => {
  const fixture = workflowFixture();
  const first = await fixture.workflow.createJob(fixture.contextA, {
    action: "prompt_to_video",
    args: { prompt: "First version", title: "Campaign video" },
    operationId: "operation-first"
  });
  const originalSnapshot = JSON.stringify(fixture.model.mediaAssets.find(item => item.id === first.version.id));
  const second = await fixture.workflow.createJob(fixture.contextA, {
    action: "revise_video",
    args: { prompt: "Tighten the opening", parentVersionId: first.version.id, sessionId: "session-1" },
    operationId: "operation-second"
  });
  assert.equal(second.version.parentVersionId, first.version.id);
  assert.equal(second.version.rootAssetId, first.version.rootAssetId);
  assert.equal(first.version.versionNumber, 1);
  assert.equal(second.version.versionNumber, 2);
  assert.equal(JSON.stringify(fixture.model.mediaAssets.find(item => item.id === first.version.id)), originalSnapshot);

  const visibleA = await fixture.workflow.listVersions(fixture.contextA);
  const visibleB = await fixture.workflow.listVersions(fixture.contextB);
  assert.equal(visibleA.length, 2);
  assert.equal(visibleB.length, 0);
  assert.equal(visibleA.every(item => item.ownerUserId === "user-a" && item.workspaceId === "workspace-a"), true);
});

test("polling uses the recorded provider identity and completes the original job", async () => {
  const fixture = workflowFixture({
    invokeImpl: async (input, count) => count === 1
      ? { capability: { id: input.action, toolName: "video_agent" }, outcome: { status: "processing", providerJobId: "provider-job-poll", sessionId: "session-poll" } }
      : { capability: { id: "job_status", toolName: "get_job_status" }, outcome: { status: "completed", providerJobId: "provider-job-poll", sessionId: "session-poll", resourceId: "resource-poll" } }
  });
  const pending = await fixture.workflow.createJob(fixture.contextA, {
    action: "prompt_to_video",
    args: { prompt: "Polling fixture" },
    operationId: "operation-poll"
  });
  assert.equal(pending.job.status, "processing");
  const done = await fixture.workflow.pollJob(fixture.contextA, pending.job.id);
  assert.equal(done.job.status, "completed");
  assert.equal(done.version.providerResourceId, "resource-poll");
  assert.equal(fixture.counts().invokes, 2);
});

test("authentication, entitlement authorization, ownership, lineage, and credits fail closed", async () => {
  const fixture = workflowFixture();
  const input = { action: "prompt_to_video", args: { prompt: "Denied fixture" }, operationId: "operation-denied" };
  await assert.rejects(fixture.workflow.createJob({}, input), error => error.code === "heygen_not_authenticated");
  await assert.rejects(fixture.workflow.createJob({ actorId: "user-a", workspaceId: "workspace-b" }, input), error => error.code === "heygen_not_authorized");
  await assert.rejects(fixture.workflow.createJob(fixture.contextA, { ...input, action: "arbitrary_tool" }), error => error.code === "heygen_action_unsupported");
  await assert.rejects(fixture.workflow.createJob(fixture.contextA, { ...input, args: { prompt: "x", url: "https://example.com" } }), error => error.code === "heygen_arguments_invalid");
  await assert.rejects(fixture.workflow.createJob(fixture.contextA, {
    action: "translate_video",
    args: { sourceAssetId: "workspace-b-asset", locale: "fr-FR" },
    operationId: "operation-cross-workspace"
  }), error => error.code === "heygen_source_not_found");

  fixture.model.connectedAccounts.find(item => item.ownerUserId === "user-a").profile.credits = { available: false, remaining: 0 };
  await assert.rejects(fixture.workflow.createJob(fixture.contextA, { ...input, operationId: "operation-no-credits" }), error => error.code === "heygen_credits_depleted");
  fixture.model.connectedAccounts.find(item => item.ownerUserId === "user-a").profile.credits = { available: null, remaining: null };
  await assert.rejects(fixture.workflow.createJob(fixture.contextA, { ...input, operationId: "operation-unverified-credits" }), error => error.code === "heygen_credits_unverified");
  assert.equal(fixture.counts().invokes, 0);
});

test("hosted writes remain held until a durable repository is enabled", async () => {
  const fixture = workflowFixture({ mutationEnabled: false });
  await assert.rejects(fixture.workflow.createJob(fixture.contextA, {
    action: "prompt_to_video",
    args: { prompt: "Hosted write" },
    operationId: "operation-hosted"
  }), error => error.code === "heygen_durable_repository_pending" && error.status === 503);
  assert.deepEqual(fixture.counts(), { saves: 0, invokes: 0 });
  assert.equal(fixture.model.mediaRenderJobs.length, 0);
});

test("durable repository reservations prevent duplicate provider calls and bind terminal evidence", async () => {
  const actorId = "11111111-1111-4111-8111-111111111111";
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const jobId = "33333333-3333-4333-8333-333333333333";
  const durableAccount = {
    id: "44444444-4444-4444-8444-444444444444",
    platform: "heygen",
    oauthProvider: "heygen",
    providerAccountId: "provider-durable",
    ownerUserId: actorId,
    workspaceId,
    status: "connected",
    profile: { credits: { available: true, remaining: 8 } }
  };
  let reserved = false;
  let invokes = 0;
  const transitions = [];
  const repository = {
    async reserveJob(input) {
      if (reserved) {
        return {
          replayed: true,
          job: { id: jobId, provider: "heygen", action: input.action, operationId: input.operationId, status: "completed", ownerUserId: actorId, workspaceId },
          requestArguments: input.requestArguments,
          account: null
        };
      }
      reserved = true;
      return {
        replayed: false,
        job: { id: jobId, provider: "heygen", action: input.action, operationId: input.operationId, status: "submitted", ownerUserId: actorId, workspaceId },
        requestArguments: input.requestArguments,
        account: durableAccount
      };
    },
    async listJobs() { return []; },
    async listVersions() { return []; }
  };
  repository.transitionJob = async input => {
    transitions.push(input);
    return {
      replayed: false,
      job: {
        id: jobId,
        provider: "heygen",
        action: "prompt_to_video",
        operationId: "durable-operation",
        status: input.state,
        outputAssetId: "55555555-5555-4555-8555-555555555555",
        ownerUserId: actorId,
        workspaceId
      },
      version: {
        id: "55555555-5555-4555-8555-555555555555",
        provider: "heygen",
        immutable: true,
        operationId: "durable-operation",
        ownerUserId: actorId,
        workspaceId
      }
    };
  };
  const workflow = createHeyGenMediaWorkflow({
    repository,
    mutationsEnabled: true,
    authorize: async input => input.actorId === actorId && input.workspaceId === workspaceId,
    invoke: async () => {
      invokes += 1;
      return {
        capability: { id: "prompt_to_video", toolName: "video_agent" },
        outcome: {
          status: "completed",
          providerJobId: "provider-job-durable",
          sessionId: "session-durable",
          resourceId: "resource-durable",
          previewUrl: "https://files.heygen.com/durable.mp4",
          title: "Durable result",
          message: "Completed"
        }
      };
    }
  });
  const context = { actorId, workspaceId };
  const input = { action: "prompt_to_video", args: { prompt: "Durable fixture" }, operationId: "durable-operation" };
  const completed = await workflow.createJob(context, input);
  const replay = await workflow.createJob(context, input);
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.version.immutable, true);
  assert.equal(replay.replayed, true);
  assert.equal(invokes, 1);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].resultFingerprint.length, 43);
  assert.equal(transitions[0].capabilityId, "prompt_to_video");
  assert.equal(transitions[0].title, "Durable result");
  assert.equal(Object.hasOwn(completed.job, "request"), false);
});

test("unexpected workflow failures are sanitized", () => {
  const secret = "workflow-secret-fixture";
  const failure = sanitizeHeyGenWorkflowError(new Error(secret));
  assert.equal(JSON.stringify(failure).includes(secret), false);
  assert.deepEqual(failure, { ok: false, code: "heygen_operation_failed", error: "HeyGen could not complete this operation.", status: 503 });
});
