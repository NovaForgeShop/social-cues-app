import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const clientModule = await import(new URL("./vizard-api-client.mjs", import.meta.url));
assert.deepEqual(Object.keys(clientModule), ["createVizardClient"], "Vizard client exports changed");
const { createVizardClient } = clientModule;

const API_KEY = "fake-vizard-contract-key-primary-00000001";
const SECOND_API_KEY = "fake-vizard-contract-key-secondary-00000002";
const SOURCE_URL = "https://media.example.test/source/video.mp4?token=source-token&signature=source-signature";
const requests = [];
const createResponses = [];
const queryResponses = new Map();

// Phase 2 must implement, rather than weaken, this contract: one encrypted credential and immutable
// job owner per workspace; workspace-prefixed storage; workspace-attributed usage; and callbacks whose
// tenancy comes only from the stored provider-project mapping, never from an untrusted payload.
const FUTURE_TENANCY_CONTRACT = Object.freeze({
  credential: "exactly one workspace_id; encrypted server-side; provider vizard; inaccessible to other workspaces; resolved only after authenticated tenant authorization; absent from workspace_models.model, frontend code, and API responses; unusable after disconnect; no global fallback",
  job: "immutable Social Cues job id, workspace_id, credential record id, Vizard project id, source asset id, model, options, state, timestamp, usage, and approval; each provider project maps to exactly one workspace and internal job and is never the sole authorization key",
  storage: "workspaces/<workspace_id>/media/<asset_or_job_id>/...; short-lived signed sources; no permanent public sources, cross-workspace outputs, transcript/thumbnail/B-roll caches, or customer content reuse; deduplicate only cryptographically identical content while preserving access controls; copy temporary Vizard outputs into tenant storage and never persist their temporary URLs",
  usage: "workspace_id, Vizard project id, source duration, model and multiplier, consumed minutes, billing owner, credential record, and completion state; the customer Vizard workspace pays",
  callback: "payload is untrusted and never selects workspace_id; resolve only from the internal project mapping, reject unknown projects, and never move a project between workspaces; handle duplicates and replays without duplicate assets or usage; query with the mapped credential and reconcile before accepting URLs, assets, or usage; bounded polling remains fallback; absent cryptographic verification require a high-entropy path, request-size limits, rate limiting, schema validation, provider confirmation, and replay-safe idempotency"
});

const clientSource = await readFile(new URL("./vizard-api-client.mjs", import.meta.url), "utf8");
const canarySource = await readFile(new URL("./scripts/vizard-canary.mjs", import.meta.url), "utf8");
const envExample = await readFile(new URL("./.env.example", import.meta.url), "utf8");
const packageDefinition = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const productionTaskSource = `${clientSource}\n${canarySource}`;

assert.doesNotMatch(clientSource, /(?:from\s+["']node:process["']|\bprocess\.env\b)/u, "reusable client must not read the environment");
assert.doesNotMatch(clientSource, /^(?:const|let|var)\s+\w*(?:api_?key|credential)\w*\s*=/gimu, "module-level credential state is forbidden");
assert.doesNotMatch(clientSource, /^(?:const|let|var)\s+\w*client\w*\s*=\s*createVizardClient\b/gimu, "shared client instances are forbidden");
assert.equal((canarySource.match(/process\.env\.VIZARD_API_KEY/gu) || []).length, 1, "only one explicit canary environment read is allowed");
assert.match(canarySource, /createVizardClient\(\{\s*apiKey\b/u, "canary must inject its key explicitly");
assert.equal((canarySource.match(/\.createProject\(/gu) || []).length, 1, "canary must contain exactly one create call");
for (const safeguard of ["--submit", "--accept-minute-charge", "--model", "--video-url", "--video-type"]) {
  assert.ok(canarySource.includes(safeguard), `canary safeguard ${safeguard} is missing`);
}
assert.doesNotMatch(productionTaskSource, /(?:workspace|customer)[\s\S]{0,100}(?:\|\||\?\?)[\s\S]{0,100}VIZARD_API_KEY/iu, "customer/global credential fallback is forbidden");
assert.doesNotMatch(productionTaskSource, /\b(?:worker_jobs|worker_runs|media_assets|workspace_models)\b/iu, "Phase 1 must not implement production persistence");
assert.match(canarySource, /while\s*\([^)]*Date\.now\(\)\s*<\s*deadline/u, "canary polling must remain bounded");
assert.match(envExample, /local internal testing and the explicitly authorized manual canary only/iu);
assert.match(envExample, /workspace-owned encrypted credential/iu);
assert.match(envExample, /no global production fallback is permitted/iu);
assert.match(envExample, /^VIZARD_API_KEY=\s*$/mu);
assert.equal(packageDefinition.scripts["test:vizard"], "node vizard-api-client.contract.test.mjs");
assert.equal(packageDefinition.scripts["vizard:canary"], "node scripts/vizard-canary.mjs");
assert.match(FUTURE_TENANCY_CONTRACT.credential, /exactly one workspace_id.*encrypted.*authenticated tenant authorization.*no global fallback/iu);
assert.match(FUTURE_TENANCY_CONTRACT.job, /immutable.*workspace_id.*credential record id.*exactly one workspace.*never the sole authorization key/iu);
assert.match(FUTURE_TENANCY_CONTRACT.storage, /^workspaces\/<workspace_id>\/media\/<asset_or_job_id>\/\.\.\./u);
assert.match(FUTURE_TENANCY_CONTRACT.usage, /workspace_id.*billing owner.*customer Vizard workspace pays/iu);
assert.match(FUTURE_TENANCY_CONTRACT.callback, /untrusted.*never selects workspace_id.*internal project mapping.*mapped credential.*bounded polling.*high-entropy path.*replay-safe idempotency/iu);

function nextQueryResponse(projectId) {
  const configured = queryResponses.get(projectId);
  if (Array.isArray(configured)) return configured.shift();
  return configured;
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function sendMockResponse(response, specification = {}) {
  if (specification.delayMs) await sleep(specification.delayMs);
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = specification.status ?? 200;
  response.setHeader("Content-Type", specification.contentType ?? "application/json");
  const output = Object.hasOwn(specification, "raw")
    ? specification.raw
    : JSON.stringify(specification.body ?? { code: 2000, projectId: 100 });
  response.end(output);
}

const mockServer = createServer(async (request, response) => {
  try {
    const bodyText = await readRequestBody(request);
    let body = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = "[malformed request body]";
      }
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body,
      bodyText
    });

    if (request.url === "/v1/project/create") {
      await sendMockResponse(response, createResponses.shift());
      return;
    }
    const queryMatch = request.url?.match(/^\/v1\/project\/query\/([a-z0-9_-]+)$/iu);
    if (queryMatch) {
      await sendMockResponse(response, nextQueryResponse(queryMatch[1]));
      return;
    }
    await sendMockResponse(response, { status: 404, body: { error: "not found" } });
  } catch {
    if (!response.destroyed && !response.writableEnded) response.destroy();
  }
});

mockServer.listen(0, "127.0.0.1");
await once(mockServer, "listening");
const address = mockServer.address();
const mockOrigin = `http://127.0.0.1:${address.port}`;
const mockBaseUrl = `${mockOrigin}/v1`;
let guardedFetchCalls = 0;

async function guardedFetch(url, options) {
  guardedFetchCalls += 1;
  assert.ok(String(url).startsWith(`${mockBaseUrl}/`), "contract test attempted to contact a non-mock provider");
  return fetch(url, options);
}

function client(options = {}) {
  return createVizardClient({
    apiKey: API_KEY,
    fetch: guardedFetch,
    baseUrl: mockBaseUrl,
    timeoutMs: 1_000,
    ...options
  });
}

function clippingRequest(overrides = {}) {
  return {
    mode: "clipping",
    lang: "auto",
    preferLength: [1, 2],
    videoUrl: SOURCE_URL,
    videoType: 1,
    ext: "mp4",
    ...overrides
  };
}

function editingRequest(overrides = {}) {
  return {
    mode: "editing",
    lang: "auto",
    videoUrl: "https://www.youtube.com/watch?v=contract-test",
    videoType: 2,
    ...overrides
  };
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}

try {
  let rejectedConfigurationFetchCalls = 0;
  const rejectedConfigurationFetch = async () => {
    rejectedConfigurationFetchCalls += 1;
    throw new Error("fetch must not run for an invalid credential");
  };
  for (const apiKey of [undefined, "", " \t\r\n "]) {
    assert.throws(
      () => createVizardClient({ apiKey, fetch: rejectedConfigurationFetch, baseUrl: mockBaseUrl }),
      (error) => error?.code === "VIZARD_INVALID_CONFIGURATION"
    );
  }
  assert.equal(rejectedConfigurationFetchCalls, 0, "missing credentials must fail before fetch");

  queryResponses.set("tenant-primary", {
    delayMs: 50,
    body: {
      code: 4002,
      projectId: "tenant-primary",
      errMsg: `Provider echoed ${API_KEY} and ${SECOND_API_KEY}`
    }
  });
  queryResponses.set("tenant-secondary", {
    delayMs: 5,
    body: {
      code: 4002,
      projectId: "tenant-secondary",
      errMsg: `VIZARDAI_API_KEY=${SECOND_API_KEY}; credential=${API_KEY}`
    }
  });
  const primaryClient = client({ apiKey: API_KEY });
  const secondaryClient = client({ apiKey: SECOND_API_KEY });
  const isolationRequestOffset = requests.length;
  const [primaryResult, secondaryResult] = await Promise.all([
    primaryClient.queryProject("tenant-primary"),
    secondaryClient.queryProject("tenant-secondary")
  ]);
  const isolationRequests = requests.slice(isolationRequestOffset);
  assert.equal(isolationRequests.length, 2);
  const primaryRequest = isolationRequests.find((request) => request.url === "/v1/project/query/tenant-primary");
  const secondaryRequest = isolationRequests.find((request) => request.url === "/v1/project/query/tenant-secondary");
  assert.equal(primaryRequest?.headers.vizardai_api_key, API_KEY);
  assert.equal(secondaryRequest?.headers.vizardai_api_key, SECOND_API_KEY);
  assert.ok(!Object.entries(primaryRequest.headers).some(([name, value]) => name !== "vizardai_api_key" && String(value).includes(API_KEY)));
  assert.ok(!Object.entries(secondaryRequest.headers).some(([name, value]) => name !== "vizardai_api_key" && String(value).includes(SECOND_API_KEY)));
  for (const result of [primaryResult, secondaryResult]) {
    assert.ok(!result.providerMessage.includes(API_KEY));
    assert.ok(!result.providerMessage.includes(SECOND_API_KEY));
  }

  const vizard = client();

  const requestsBeforeCredentialLeakChecks = requests.length;
  for (const operation of [
    () => vizard.createProject(clippingRequest({
      videoUrl: `https://media.example.test/source/video.mp4?token=${API_KEY}`
    })),
    () => vizard.createProject(clippingRequest({ projectName: API_KEY })),
    () => vizard.queryProject(API_KEY)
  ]) {
    const error = await rejected(operation());
    assert.equal(error.code, "VIZARD_INVALID_REQUEST");
    assert.ok(!error.message.includes(API_KEY));
  }
  const keyInBaseUrlClient = client({ baseUrl: `${mockBaseUrl}/${API_KEY}` });
  const keyInBaseUrlError = await rejected(keyInBaseUrlClient.queryProject("safe-project"));
  assert.equal(keyInBaseUrlError.code, "VIZARD_INVALID_REQUEST");
  assert.equal(requests.length, requestsBeforeCredentialLeakChecks, "credential-bearing request data must fail before fetch");

  createResponses.push({ body: { code: 2000, projectId: 17861706, errMsg: "" } });
  const accepted = await vizard.createProject(clippingRequest({
    preferLength: [1, 2, 2],
    ext: ".MP4",
    ratioOfClip: 4,
    templateId: 52987165,
    removeSilenceSwitch: 0,
    maxClipNumber: 10,
    keywords: "Find the launch announcement",
    subtitleSwitch: 1,
    headlineSwitch: 1,
    emojiSwitch: 0,
    highlightSwitch: 1,
    autoBrollSwitch: 0,
    clipModel: "clip_v2",
    projectName: "  Contract clipping project  "
  }));
  assert.deepEqual(accepted, {
    state: "accepted",
    providerCode: 2000,
    providerMessage: "",
    httpStatus: 200,
    providerProjectId: "17861706"
  });
  assert.notEqual(accepted.state, "completed", "create code 2000 must not mean completed");

  const createRequest = requests.at(-1);
  assert.equal(createRequest.method, "POST");
  assert.equal(createRequest.url, "/v1/project/create");
  assert.equal(createRequest.headers.vizardai_api_key, API_KEY);
  assert.equal(createRequest.headers.authorization, undefined);
  assert.equal(createRequest.headers.cookie, undefined);
  assert.ok(!createRequest.url.includes(API_KEY));
  assert.ok(!createRequest.bodyText.includes(API_KEY));
  for (const [name, value] of Object.entries(createRequest.headers)) {
    if (name === "vizardai_api_key") continue;
    assert.ok(!String(value).includes(API_KEY), `API key leaked into ${name} header`);
  }
  assert.deepEqual(createRequest.body, {
    lang: "auto",
    videoUrl: SOURCE_URL,
    videoType: 1,
    ext: "mp4",
    ratioOfClip: 4,
    templateId: 52987165,
    removeSilenceSwitch: 0,
    subtitleSwitch: 1,
    headlineSwitch: 1,
    emojiSwitch: 0,
    highlightSwitch: 1,
    autoBrollSwitch: 0,
    projectName: "Contract clipping project",
    preferLength: [1, 2],
    maxClipNumber: 10,
    keywords: "Find the launch announcement",
    clipModel: "clip_v2"
  });
  assert.equal(createRequest.body.mode, undefined);
  assert.equal(createRequest.body.keyword, undefined, "documented plural keywords field must be used");

  createResponses.push({ body: { code: 2000, projectId: "edit-1", errMsg: "" } });
  const edited = await vizard.createProject(editingRequest({
    getClips: 0,
    ratioOfClip: 1,
    templateId: 52987165,
    removeSilenceSwitch: 1,
    subtitleSwitch: 1,
    headlineSwitch: 1,
    emojiSwitch: 0,
    highlightSwitch: 1,
    autoBrollSwitch: 1,
    projectName: "Short edit"
  }));
  assert.equal(edited.state, "accepted");
  assert.deepEqual(requests.at(-1).body, {
    lang: "auto",
    videoUrl: "https://www.youtube.com/watch?v=contract-test",
    videoType: 2,
    ratioOfClip: 1,
    templateId: 52987165,
    removeSilenceSwitch: 1,
    subtitleSwitch: 1,
    headlineSwitch: 1,
    emojiSwitch: 0,
    highlightSwitch: 1,
    autoBrollSwitch: 1,
    projectName: "Short edit",
    getClips: 0
  });

  const requestsBeforeValidation = requests.length;
  const invalidRequests = [
    clippingRequest({ preferLength: [0, 1] }),
    clippingRequest({ preferLength: [] }),
    clippingRequest({ preferLength: [5] }),
    clippingRequest({ ratioOfClip: 5 }),
    clippingRequest({ clipModel: "clip_v3" }),
    clippingRequest({ videoType: 8, ext: undefined }),
    clippingRequest({ videoType: "2", ext: undefined }),
    clippingRequest({ ext: "exe" }),
    clippingRequest({ ext: undefined }),
    clippingRequest({ videoType: 2, ext: "mp4" }),
    clippingRequest({ maxClipNumber: 0 }),
    clippingRequest({ maxClipNumber: 101 }),
    editingRequest({ getClips: 1 }),
    editingRequest({ preferLength: [1] })
  ];
  for (const invalid of invalidRequests) {
    const error = await rejected(vizard.createProject(invalid));
    assert.equal(error.code, "VIZARD_INVALID_REQUEST");
  }

  for (const videoUrl of [
    "not a URL",
    "ftp://media.example.test/video.mp4",
    "https://user:password@media.example.test/video.mp4",
    "https://localhost/video.mp4",
    "https://localhost.localdomain/video.mp4",
    "https://intranet/video.mp4",
    "https://127.0.0.1/video.mp4",
    "https://2130706433/video.mp4",
    "https://10.1.2.3/video.mp4",
    "https://169.254.169.254/latest/meta-data",
    "https://172.16.0.1/video.mp4",
    "https://192.168.1.2/video.mp4",
    "https://[::1]/video.mp4",
    "https://[fe80::1]/video.mp4",
    "https://[fd00::1]/video.mp4",
    "https://[fec0::1]/video.mp4",
    "https://metadata.google.internal/computeMetadata/v1/",
    "http://media.example.test/video.mp4"
  ]) {
    const error = await rejected(vizard.createProject(clippingRequest({ videoUrl })));
    assert.equal(error.code, "VIZARD_INVALID_REQUEST");
    assert.ok(!error.message.includes("password"));
    assert.ok(!error.message.includes("meta-data"));
  }
  assert.equal(requests.length, requestsBeforeValidation, "invalid requests must be rejected before network access");

  createResponses.push({ body: { code: 2000, projectId: "http-explicit", errMsg: "" } });
  const explicitHttpClient = client({ allowHttpSource: true });
  const explicitHttp = await explicitHttpClient.createProject(clippingRequest({
    videoUrl: "http://media.example.test/source/video.mp4"
  }));
  assert.equal(explicitHttp.state, "accepted");

  queryResponses.set("processing-1", { body: { code: 1000, projectId: "processing-1", errMsg: "Still working" } });
  const processing = await vizard.queryProject("processing-1");
  assert.deepEqual(processing, {
    state: "processing",
    providerCode: 1000,
    providerMessage: "Still working",
    httpStatus: 200,
    providerProjectId: "processing-1"
  });
  assert.equal(requests.at(-1).method, "GET");
  assert.equal(requests.at(-1).url, "/v1/project/query/processing-1");
  assert.equal(requests.at(-1).bodyText, "");

  queryResponses.set("completed-1", {
    body: {
      code: 2000,
      projectId: 9001,
      errMsg: "",
      videos: [
        {
          videoId: 42,
          videoUrl: "https://temporary.example.test/download.mp4?signature=temporary-secret",
          videoMsDuration: "32100",
          title: "A useful clip",
          transcript: "Full transcript remains internal.",
          viralScore: "8.5",
          viralReason: "Clear hook and focused payoff.",
          relatedTopic: "[\"AI\",\"launch\",3,null]",
          clipEditorUrl: "https://vizard.ai/editor/42?invite=temporary",
          starred: 1,
          disliked: "0"
        },
        {
          videoId: "43",
          relatedTopic: "not-json",
          videoMsDuration: "not-a-number",
          viralScore: null
        }
      ]
    }
  });
  const completed = await vizard.queryProject("completed-1");
  assert.equal(completed.state, "completed");
  assert.equal(completed.providerCode, 2000);
  assert.equal(completed.providerProjectId, "9001");
  assert.equal(completed.videos.length, 2);
  assert.deepEqual(completed.videos[0], {
    providerProjectId: "9001",
    providerVideoId: "42",
    temporaryVideoUrl: "https://temporary.example.test/download.mp4?signature=temporary-secret",
    durationMs: 32100,
    title: "A useful clip",
    transcript: "Full transcript remains internal.",
    viralScore: 8.5,
    viralReason: "Clear hook and focused payoff.",
    relatedTopics: ["AI", "launch"],
    editorUrl: "https://vizard.ai/editor/42?invite=temporary",
    starred: true,
    disliked: false
  });
  assert.deepEqual(completed.videos[1].relatedTopics, []);
  assert.equal(completed.videos[1].durationMs, null);
  assert.equal(completed.videos[1].viralScore, null);

  queryResponses.set("provider-echoed-key", {
    body: {
      code: 2000,
      projectId: `project-${API_KEY}`,
      videos: [{
        videoId: API_KEY,
        videoUrl: `https://temporary.example.test/${API_KEY}.mp4`,
        title: API_KEY,
        transcript: `Transcript ${API_KEY}`,
        relatedTopic: JSON.stringify([API_KEY]),
        clipEditorUrl: `https://vizard.ai/editor/${API_KEY}`
      }]
    }
  });
  const providerEchoedKey = await vizard.queryProject("provider-echoed-key");
  assert.ok(!JSON.stringify(providerEchoedKey).includes(API_KEY), "returned provider data exposed the API key");

  queryResponses.set("missing-videos", { body: { code: 2000, projectId: "missing-videos" } });
  queryResponses.set("malformed-videos", { body: { code: 2000, projectId: "malformed-videos", videos: { nope: true } } });
  assert.deepEqual((await vizard.queryProject("missing-videos")).videos, []);
  assert.deepEqual((await vizard.queryProject("malformed-videos")).videos, []);

  const expectedErrorStates = new Map([
    [4001, "authentication_failed"],
    [4002, "failed"],
    [4003, "rate_limited"],
    [4004, "invalid_request"],
    [4005, "source_unavailable"],
    [4006, "invalid_request"],
    [4007, "insufficient_minutes"],
    [4008, "source_unavailable"],
    [4009, "source_unavailable"],
    [4010, "invalid_request"]
  ]);
  for (const [code, state] of expectedErrorStates) {
    const projectId = `error-${code}`;
    queryResponses.set(projectId, { body: { code, projectId, errMsg: `Provider error ${code}` } });
    const result = await vizard.queryProject(projectId);
    assert.equal(result.state, state, `provider code ${code} mapped incorrectly`);
    assert.equal(result.providerCode, code);
    assert.equal(result.providerMessage, `Provider error ${code}`);
  }

  const sensitiveProviderUrl = "https://media.example.test/source.mp4?token=provider-message-secret";
  queryResponses.set("redacted-provider", {
    body: {
      code: 4009,
      projectId: "redacted-provider",
      errMsg: `Could not use ${sensitiveProviderUrl}; key=${API_KEY}; token=another-secret`
    }
  });
  const redactedProvider = await vizard.queryProject("redacted-provider");
  assert.ok(!redactedProvider.providerMessage.includes(API_KEY));
  assert.ok(!redactedProvider.providerMessage.includes("provider-message-secret"));
  assert.ok(!redactedProvider.providerMessage.includes("another-secret"));

  createResponses.push({ raw: `not-json ${API_KEY} ${SOURCE_URL}`, contentType: "text/plain" });
  const malformedError = await rejected(vizard.createProject(clippingRequest()));
  assert.equal(malformedError.code, "VIZARD_MALFORMED_RESPONSE");
  assert.ok(!malformedError.message.includes(API_KEY));
  assert.ok(!malformedError.message.includes("source-token"));

  createResponses.push({
    status: 500,
    raw: `provider body ${API_KEY} ${SOURCE_URL}`,
    contentType: "text/plain"
  });
  const httpBodyError = await rejected(vizard.createProject(clippingRequest()));
  assert.equal(httpBodyError.code, "VIZARD_MALFORMED_RESPONSE");
  assert.ok(!httpBodyError.message.includes(API_KEY));
  assert.ok(!httpBodyError.message.includes("source-token"));

  const networkErrorClient = createVizardClient({
    apiKey: API_KEY,
    fetch: async () => {
      throw new Error(`connection failed ${API_KEY} ${SOURCE_URL}`);
    },
    baseUrl: mockBaseUrl,
    timeoutMs: 100
  });
  const networkError = await rejected(networkErrorClient.createProject(clippingRequest()));
  assert.equal(networkError.code, "VIZARD_NETWORK_ERROR");
  assert.ok(!networkError.message.includes(API_KEY));
  assert.ok(!networkError.message.includes("source-token"));

  const timeoutClient = client({ timeoutMs: 30 });
  const createCountBeforeTimeout = requests.filter((request) => request.url === "/v1/project/create").length;
  createResponses.push({ delayMs: 120, body: { code: 2000, projectId: "too-late" } });
  const timeoutStarted = Date.now();
  const timeoutError = await rejected(timeoutClient.createProject(clippingRequest()));
  const timeoutElapsed = Date.now() - timeoutStarted;
  assert.equal(timeoutError.code, "VIZARD_TIMEOUT");
  assert.ok(timeoutElapsed < 500, `timeout took ${timeoutElapsed}ms`);
  await sleep(160);
  const createCountAfterTimeout = requests.filter((request) => request.url === "/v1/project/create").length;
  assert.equal(createCountAfterTimeout, createCountBeforeTimeout + 1, "create timeout was retried");

  const invalidProjectIdRequests = requests.length;
  const invalidProjectError = await rejected(vizard.queryProject("../secret?token=value"));
  assert.equal(invalidProjectError.code, "VIZARD_INVALID_REQUEST");
  assert.equal(requests.length, invalidProjectIdRequests);

  assert.equal(guardedFetchCalls, requests.length, "all provider requests must use the guarded mock fetch");
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.headers.host === `127.0.0.1:${address.port}`));

  console.log(JSON.stringify({
    ok: true,
    providerRequests: requests.length,
    requiredContracts: 16,
    realVizardRequests: 0,
    publicExports: Object.keys(clientModule)
  }));
} finally {
  mockServer.closeAllConnections();
  await new Promise((resolve) => mockServer.close(resolve));
}
