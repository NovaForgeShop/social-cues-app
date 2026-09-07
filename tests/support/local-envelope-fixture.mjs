import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { localContentCollections } from "../../local-workspace-persistence.mjs";

export function fixtureModel(document) {
  if (document.format !== "social-cues.local-workspace-content.v1") return document;
  const workspace = document.shared.workspace || document.shared.workspaces[0];
  const model = { ...document.shared, ...document.workspaces[workspace.id].content, workspace };
  for (const key of localContentCollections) model[key] = Object.values(document.workspaces).flatMap(entry => entry.content[key] || []);
  return model;
}

// Explicit test-only shared-registry fault injection. Never a server API or a
// content write: preserve epochs, content, receipts and revisions verbatim.
export async function injectSharedFixture(dataDir, changes) {
  if (!path.resolve(dataDir).split(path.sep).includes(".tmp")) throw new Error("disposable_fixture_required");
  const filename = path.join(dataDir, "model.json");
  const document = JSON.parse(await readFile(filename, "utf8"));
  if (document.format !== "social-cues.local-workspace-content.v1") throw new Error("versioned_fixture_required");
  for (const key of ["authUsers", "deviceSessions", "workspace", "workspaces"]) {
    if (Object.hasOwn(changes, key)) document.shared[key] = changes[key];
  }
  await writeFile(filename, JSON.stringify(document));
}

export async function revisionedFixtureOptions(baseUrl, options) {
  if (!options.body || !new Headers(options.headers).has("Authorization")) return options;
  const url = new URL(baseUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("loopback_fixture_required");
  const response = await fetch(baseUrl + "/api/model", { headers: options.headers });
  const model = await response.json();
  if (!model.persistence?.conditionalSave) return options;
  return { ...options, body: JSON.stringify({ kind: "model-save", operationId: randomUUID(),
    expectedRevision: model.persistence.revision, request: JSON.parse(options.body) }) };
}
