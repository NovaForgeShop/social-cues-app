import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openWorkspaceContentStore } from "../workspace-content-persistence.mjs";
import { projectSyntheticLegacyModel } from "../local-workspace-persistence.mjs";

export async function convertSyntheticLocalWorkspace({ source, target, syntheticCopy = false }) {
  source = path.resolve(source); target = path.resolve(target);
  if (!syntheticCopy || ![source, target].every(value => value.split(path.sep).includes(".tmp"))
    || path.dirname(source) === target) throw new Error("explicit_disposable_synthetic_copy_required");
  const exists = async name => lstat(name).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  if (await exists(target)) throw new Error("conversion_target_must_not_exist");
  if (!(await lstat(source)).isFile() || (await lstat(source)).isSymbolicLink()) throw new Error("regular_synthetic_source_required");
  if (!(await realpath(source)).split(path.sep).includes(".tmp") || !(await realpath(path.dirname(target))).split(path.sep).includes(".tmp")) throw new Error("resolved_disposable_paths_required");
  for (const name of [".workspace-content.lock", "pilot.lock"]) {
    if (await exists(path.join(path.dirname(source), name))) throw new Error("conversion_source_must_be_offline");
  }
  const bytes = await readFile(source);
  const legacy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (legacy.syntheticFixture !== "social-cues.p11-offline-copy.v1") throw new Error("marked_synthetic_fixture_required");
  const projected = projectSyntheticLegacyModel(legacy);
  const store = await openWorkspaceContentStore({ dataDir: target,
    authorize: ({ action, workspaceId }) => action === "initialize" && Object.hasOwn(projected.workspaces, workspaceId),
    validateContent: () => true, mutations: { disabled: () => { throw new Error("conversion_only"); } } });
  try { await store.initialize({ actorId: "synthetic-offline-converter", ...projected }); }
  finally { await store.close(); }
  const sourceAfter = await readFile(source);
  if (!sourceAfter.equals(bytes)) throw new Error("conversion_source_changed");
  return { sourceUnchanged: true, workspaceCount: Object.keys(projected.workspaces).length,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"), target };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, source, target, extra] = process.argv.slice(2);
  if (flag !== "--synthetic-copy" || !source || !target || extra) throw new Error("Use --synthetic-copy <legacy.json> <new-directory>; disposable .tmp paths only.");
  console.log(JSON.stringify(await convertSyntheticLocalWorkspace({ source, target, syntheticCopy: true })));
}
