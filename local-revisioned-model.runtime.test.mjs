import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { createLocalPilot } from "./scripts/run-local-pilot.mjs";

const pilot = await createLocalPilot();
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
const call = async (route, token, body) => {
  const response = await fetch(pilot.url + route, { method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
const signup = async label => {
  const response = await call("/api/auth/signup", null, { name: "Synthetic " + label, email: "barton.cory.m+revisioned-" + label + "-" + randomUUID() + "@gmail.com",
    password: "Synthetic-only-" + randomUUID() + "!", device: { deviceId: "device-" + randomUUID() } });
  check(response.status === 200, "fresh signup status " + response.status + " code " + (response.body.code || "none"));
  return { ...response.body, token: response.body.session.token };
};
const envelope = (model, brief, kind = "model-save") => {
  const request = structuredClone(model);
  request.campaigns = [{ id: "campaign-" + model.workspace.id, title: "Synthetic local concurrency", brief,
    variants: [{ id: "variant-" + model.workspace.id, platform: "facebook", status: "draft", copy: "Synthetic draft", tags: [] }] }];
  request.proof = []; request.activeCampaignId = request.campaigns[0].id;
  return { operationId: randomUUID(), kind, expectedRevision: structuredClone(model.persistence.revision),
    request: kind === "content-recovery" ? { schemaVersion: "social-cues.campaign-content.v1", content: request } : request };
};
try {
  await pilot.start();
  const a = await signup("alpha");
  const token = a.token;
  check(typeof token === "string" && token.length > 0, "signup supplies session");
  const initial = await call("/api/model", token);
  check(initial.status === 200 && initial.body.persistence.conditionalSave, "authenticated revision capability");
  const beforeHealth = JSON.parse(await readFile(path.join(pilot.dataDir, "model.json"), "utf8"));
  await call("/api/meta/health", token, {});
  const afterHealth = JSON.parse(await readFile(path.join(pilot.dataDir, "model.json"), "utf8"));
  check(beforeHealth.workspaces[a.workspace.id].revision === afterHealth.workspaces[a.workspace.id].revision, "derived analytics refresh is a non-content transaction");
  check((await call("/api/model", null, {})).status === 401, "anonymous save denied");
  const noRevision = { kind: "model-save", operationId: randomUUID(), request: initial.body };
  check((await call("/api/model", token, noRevision)).status === 428, "missing revision denied");
  const first = envelope(initial.body, "first");
  const saved = await call("/api/model", token, first);
  check(saved.status === 200, "first save status " + saved.status + " code " + (saved.body.code || "none"));
  const competing = envelope(initial.body, "must not overwrite");
  check((await call("/api/model", token, competing)).status === 409, "stale normal edit conflicts");
  const replay = await call("/api/model", token, first);
  check(replay.status === 200 && replay.body.receipt.replayed, "lost-response identical retry receipt");
  check((await call("/api/model", token, { ...first, request: { ...first.request, activeCampaignId: "different" } })).body.code === "workspace_operation_id_reused", "ID misuse distinct");
  const diskBeforeGet = await readFile(path.join(pilot.dataDir, "model.json"));
  await call("/api/model", token); await call("/api/auth/session", token); await call("/api/devices", token);
  check(diskBeforeGet.equals(await readFile(path.join(pilot.dataDir, "model.json"))), "steady-state GET paths do not rewrite storage");
  const other = await signup("beta");
  const otherState = await call("/api/model", other.token);
  check(otherState.body.workspace.id !== saved.body.workspace.id, "second workspace isolated");
  check(otherState.body.campaigns.length === 0, "new workspace does not inherit first content");
  check((await call("/api/model", token)).body.campaigns[0].brief === "first", "second signup preserves first workspace");
  const preview = envelope(saved.body, "recovered", "content-recovery");
  const second = await call("/api/model", token, envelope(saved.body, "intervening"));
  check(second.status === 200, "intervening edit saved");
  check((await call("/api/model", token, preview)).status === 409, "recovery against reviewed stale revision conflicts");
  const historical = await call("/api/model", token, first);
  check(historical.body.receipt.superseded && !Object.hasOwn(historical.body, "campaigns"), "superseded receipt cannot represent current content");
  check((await call("/api/auth/device/heartbeat", token, { deviceName: "Synthetic heartbeat" })).status === 200, "non-content writer works");
  check((await call("/api/model", token)).body.campaigns[0].brief === "intervening", "heartbeat preserves newer content");
  await pilot.restart();
  const reopened = await call("/api/model", token);
  check(reopened.body.campaigns[0].brief === "intervening", "B edit survives process restart");
  check(JSON.stringify(reopened.body.persistence.revision) === JSON.stringify(second.body.persistence.revision), "revision survives non-content write and restart");
  const reviewed = await call("/api/model", token, envelope(reopened.body, "deliberately recovered", "content-recovery"));
  check(reviewed.status === 200, "fresh reviewed recovery saves status " + reviewed.status + " code " + (reviewed.body.code || "none"));
  check((await call("/api/model", other.token)).body.campaigns.length === 0, "unrelated workspace retained through recovery");
  const raceBase = (await call("/api/model", token)).body;
  const race = await Promise.all([call("/api/model", token, envelope(raceBase, "race A")), call("/api/model", token, envelope(raceBase, "race B"))]);
  check(race.filter(result => result.status === 200).length === 1 && race.filter(result => result.status === 409).length === 1, "same-base simultaneous normal saves exactly one winner");
} finally {
  await pilot.stop();
}
check(await access(path.join(pilot.dataDir, ".workspace-content.lock")).then(() => false, () => true), "normal shutdown releases authoritative lock");
const summary = await pilot.summary();
check(summary.externalProviderRequestsDispatched === 0, "zero external dispatches");
console.log(JSON.stringify({ checks, externalDispatches: summary.externalProviderRequestsDispatched, dataDir: pilot.dataDir, stopped: true }));
