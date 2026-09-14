import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  localContentCollections,
  projectSyntheticLegacyModel
} from "../local-workspace-persistence.mjs";
import { openWorkspaceContentStore } from "../workspace-content-persistence.mjs";

const FORMAT = "social-cues.local-workspace-content.v1";
const clone = value => JSON.parse(JSON.stringify(value));

function assertPartitionedDocument(document) {
  if (document?.format !== FORMAT
    || !document.shared
    || !document.workspaces
    || Array.isArray(document.workspaces)
    || Object.keys(document).sort().join(",") !== "format,shared,workspaces"
    || Object.keys(document.workspaces).length === 0) {
    throw new Error("partitioned_local_workspace_fixture_required");
  }
  for (const entry of Object.values(document.workspaces)) {
    if (!entry?.content
      || typeof entry.epoch !== "string"
      || typeof entry.revision !== "string"
      || !entry.receipts
      || Array.isArray(entry.receipts)
      || Object.keys(entry).sort().join(",") !== "content,epoch,receipts,revision") {
      throw new Error("partitioned_local_workspace_fixture_required");
    }
  }
  return document;
}

export async function writePartitionedLocalWorkspaceFixture({ dataDir, model }) {
  await mkdir(dataDir, { recursive: true });
  if (model?.format === FORMAT) {
    const document = assertPartitionedDocument(clone(model));
    await writeFile(path.join(dataDir, "model.json"), JSON.stringify(document, null, 2), "utf8");
    return document;
  }

  const projected = projectSyntheticLegacyModel(model);
  const store = await openWorkspaceContentStore({
    dataDir,
    authorize: ({ action, workspaceId }) => action === "initialize" && Object.hasOwn(projected.workspaces, workspaceId),
    validateContent: () => true,
    mutations: { "fixture-disabled": () => { throw new Error("fixture_mutation_disabled"); } }
  });
  try {
    await store.initialize({
      actorId: "synthetic-fixture-writer",
      shared: projected.shared,
      workspaces: projected.workspaces
    });
  } finally {
    await store.close();
  }
  return assertPartitionedDocument(JSON.parse(await readFile(path.join(dataDir, "model.json"), "utf8")));
}

export async function readPartitionedLocalWorkspaceFixture(modelPath, workspaceId) {
  const document = assertPartitionedDocument(JSON.parse(await readFile(modelPath, "utf8")));
  const model = clone(document.shared);
  for (const key of localContentCollections) {
    model[key] = Object.values(document.workspaces).flatMap(entry => clone(entry.content[key] || []));
  }
  if (document.workspaces[workspaceId]) Object.assign(model, clone(document.workspaces[workspaceId].content));
  for (const key of localContentCollections) {
    model[key] = Object.values(document.workspaces).flatMap(entry => clone(entry.content[key] || []));
  }
  model.workspaces = clone(document.shared.workspaces || []);
  model.currentUser = null;
  model.workspace = clone(model.workspaces.find(row => row.id === workspaceId) || model.workspace);
  return model;
}
