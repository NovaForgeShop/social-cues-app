import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { openWorkspaceContentStore, WorkspaceContentPersistenceError } from "./workspace-content-persistence.mjs";
import { validateLocalOwnershipState } from "./local-workspace-ownership.mjs";

export const localContentCollections = ["campaigns", "quickPosts", "actions", "proof", "mediaAssets", "mediaRenderJobs", "publishQueue", "analyticsSnapshots", "providerStateSnapshots", "activity", "connectedAccounts"];
const fields = ["onboarding", "profile", "security", "settings", "baseline", "handoff", "brandKit", "functionChecks", "activeProviderAccounts", "workspaceModel", "activeCampaignId"];
const clone = value => JSON.parse(JSON.stringify(value));
const revision = entry => ({ epoch: entry.epoch, revision: entry.revision });
const fail = (code, status = 409) => { throw new WorkspaceContentPersistenceError(code, status); };
const owner = (doc, id) => doc?.shared.workspaces?.find(row => row.id === id)?.ownerUserId;

// Apply only actual changes, against fresh state. Conflicting fields never get rebased.
function mergeChanged(base, proposed, current) {
  if (equal(base, proposed)) return current;
  if (equal(base, current)) return proposed;
  const record = value => value && typeof value === "object" && !Array.isArray(value);
  if (record(base) && record(proposed) && record(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(proposed)])) {
      const value = mergeChanged(base[key], proposed[key], current[key]);
      if (value === undefined) delete result[key];
      else Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  if ([base, proposed, current].every(value => Array.isArray(value) && value.every(row => row?.id)
    && new Set(value.map(row => row.id)).size === value.length)) {
    const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));
    const result = mergeChanged(byId(base), byId(proposed), byId(current));
    return [...current.map(row => row.id), ...proposed.filter(row => !current.some(old => old.id === row.id)).map(row => row.id)]
      .filter(id => result[id]).map(id => result[id]);
  }
  fail("workspace_shared_state_conflict");
}

function sharedPart(model) {
  const result = clone(model);
  for (const key of [...localContentCollections, ...fields, "workspace", "currentUser", "persistence", "receipt", "updatedAt"]) delete result[key];
  return result;
}

function contentPart(model, workspace, previous = {}) {
  const result = clone(previous);
  for (const key of localContentCollections) {
    if (Array.isArray(model[key])) result[key] = model[key].filter(row => row.workspaceId === workspace.id && row.ownerUserId === workspace.ownerUserId);
    else if (!(key in result)) result[key] = [];
  }
  for (const key of fields) if (Object.hasOwn(model, key)) result[key] = clone(model[key]);
  return result;
}

export function projectSyntheticLegacyModel(model) {
  if (!Array.isArray(model?.workspaces) || !model.workspaces.length || !model.workspace?.id) fail("workspace_legacy_identity_required", 400);
  const shared = sharedPart(model), workspaces = {};
  for (const row of model.workspaces) {
    validateLocalOwnershipState({ model: { ...model, workspace: row }, activeWorkspaceId: row.id, authenticatedUserId: row.ownerUserId });
    const content = contentPart(model, row);
    if (row.id !== model.workspace.id) for (const key of fields) delete content[key];
    workspaces[row.id] = content;
  }
  for (const key of localContentCollections) {
    if ((model[key] || []).some(item => !model.workspaces.some(row => row.id === item.workspaceId && row.ownerUserId === item.ownerUserId))) fail("workspace_legacy_unowned_content", 400);
  }
  return { shared, workspaces };
}

export async function openLocalWorkspacePersistence({ dataDir, seed, mergeClient, recoverClient, fault }) {
  const baselines = new WeakMap();
  const render = (doc, workspaceId = "") => {
    const model = { ...clone(seed), ...(doc ? clone(doc.shared) : {}) };
    for (const key of localContentCollections) model[key] = doc ? Object.values(doc.workspaces).flatMap(entry => clone(entry.content[key] || [])) : [];
    if (doc?.workspaces[workspaceId]) Object.assign(model, clone(doc.workspaces[workspaceId].content));
    // Domain helpers operate on a full multi-workspace collection, publicModel scopes it.
    if (doc) for (const key of localContentCollections) model[key] = Object.values(doc.workspaces).flatMap(entry => clone(entry.content[key] || []));
    model.workspaces = clone(doc?.shared.workspaces || []);
    model.currentUser = null;
    if (workspaceId) model.workspace = clone(model.workspaces.find(row => row.id === workspaceId) || model.workspace);
    return model;
  };
  const track = (model, document, workspaceId = "") => {
    baselines.set(model, { document: clone(document), model: clone(model), workspaceId });
    return model;
  };
  const validate = ({ previous, next, input }) => {
    const rows = next.shared.workspaces;
    if (!Array.isArray(rows) || rows.length !== Object.keys(next.workspaces).length) return false;
    if (!next.shared.authUsers?.some(user => user.id === input.actorId)) return false;
    for (const row of rows) {
      if (!next.workspaces[row.id]) return false;
      const old = previous?.shared.workspaces.find(item => item.id === row.id);
      if (old && ["id", "ownerUserId", "createdAt"].some(key => old[key] !== row[key])) return false;
      if (!old && row.ownerUserId !== input.actorId) return false;
      if (old && !equal(previous.workspaces[row.id].content, next.workspaces[row.id]) && old.ownerUserId !== input.actorId) return false;
      const model = render({ shared: next.shared, workspaces: Object.fromEntries(Object.entries(next.workspaces).map(([id, content]) => [id, { content }])) }, row.id);
      validateLocalOwnershipState({ model, activeWorkspaceId: row.id, authenticatedUserId: row.ownerUserId });
      for (const key of localContentCollections) if (next.workspaces[row.id][key]?.some(item => item.workspaceId !== row.id || item.ownerUserId !== row.ownerUserId)) return false;
    }
    // Signup must not race duplicate account identities into the shared registry.
    const emails = next.shared.authUsers.map(user => String(user.email || "").trim().toLowerCase());
    return new Set(emails).size === emails.length;
  };
  function validateStored(document) {
    if (!document) return;
    try {
      if (!Array.isArray(document.shared.workspaces) || !document.shared.workspaces.length) throw new Error();
      const next = { shared: document.shared, workspaces: Object.fromEntries(Object.entries(document.workspaces).map(([id, entry]) => [id, entry.content])) };
      for (const row of document.shared.workspaces) if (!validate({ previous: document, next, input: { actorId: row.ownerUserId } })) throw new Error();
    } catch { fail("workspace_storage_unavailable", 503); }
  }
  const store = await openWorkspaceContentStore({ dataDir, fault,
    authorize: ({ workspaceId, actorId, shared }) => shared.workspaces?.some(row => row.id === workspaceId && row.ownerUserId === actorId) === true,
    validateContent: () => true, mutations: { unavailable: () => fail("workspace_writer_unclassified", 403) },
    application: {
      authorize({ action, document, input }) {
        validateStored(document);
        if (action === "snapshot") return true; // Server-held only; never a public raw-data route.
        if (input.kind === "signup") return !document?.shared.authUsers?.some(row => row.id === input.actorId);
        return ["server-write", "model-save", "content-recovery"].includes(input.kind)
          && owner(document, input.workspaceId) === input.actorId;
      },
      validate,
      mutate({ document, input }) {
        const next = { shared: clone(document?.shared || {}), workspaces: Object.fromEntries(Object.entries(document?.workspaces || {}).map(([id, entry]) => [id, clone(entry.content)])) };
        if (["model-save", "content-recovery"].includes(input.kind)) {
          const current = render(document, input.workspaceId);
          const user = document.shared.authUsers.find(row => row.id === input.actorId);
          const merged = input.kind === "content-recovery" ? recoverClient(input.request, current, user) : mergeClient(input.request, current, user);
          // Browser content snapshots are not the shared authentication/provider/
          // billing registry authority. Only the canonical workspace display row
          // produced by the existing ownership merge may change here.
          next.shared.workspaces = clone(merged.workspaces);
          next.workspaces[input.workspaceId] = contentPart(merged, current.workspaces.find(row => row.id === input.workspaceId), next.workspaces[input.workspaceId]);
          return next;
        }
        const { baseline, proposed, revisions } = input.request;
        const beforeShared = sharedPart(baseline), afterShared = sharedPart(proposed);
        // Cloned workspace views omit unrelated registry fields; omission is not deletion.
        for (const key of Object.keys(beforeShared)) if (!Object.hasOwn(afterShared, key)) afterShared[key] = beforeShared[key];
        next.shared = mergeChanged(beforeShared, afterShared, document?.shared || beforeShared);
        for (const workspace of next.shared.workspaces || []) {
          if (!document?.workspaces[workspace.id]) {
            if (input.kind !== "signup" || workspace.ownerUserId !== input.actorId) fail("workspace_writer_unclassified", 403);
            next.workspaces[workspace.id] = contentPart(proposed, workspace);
            continue;
          }
          if (input.kind === "signup") continue;
          const previous = contentPart(baseline, workspace, document.workspaces[workspace.id].content);
          const desired = contentPart(proposed, workspace, previous);
          // View-only scalars belong solely to the active workspace.
          if (workspace.id !== input.workspaceId) for (const key of fields) {
            if (Object.hasOwn(previous, key)) desired[key] = previous[key]; else delete desired[key];
          }
          if (equal(previous, desired)) continue;
          if (workspace.ownerUserId !== input.actorId) fail("workspace_authorization_failed", 403);
          if (!equal(revisions[workspace.id], revision(document.workspaces[workspace.id]))) fail("workspace_revision_conflict");
          next.workspaces[workspace.id] = desired;
        }
        return next;
      }
    }
  });
  try { await store.snapshot(); }
  catch (error) { await store.close(); throw error; }
  return {
    directory: store.directory,
    async load() { const document = await store.snapshot(); return track(render(document), document); },
    view(model, workspaceId) {
      const info = baselines.get(model);
      if (!info) fail("workspace_writer_unclassified", 403);
      const view = track(render(info.document, workspaceId), info.document, workspaceId);
      Object.assign(view, sharedPart(model));
      return view;
    },
    inherit(model, source) {
      const info = baselines.get(source);
      if (!info) fail("workspace_writer_unclassified", 403);
      baselines.set(model, info);
      return model;
    },
    baseline(model) { const info = baselines.get(model); if (info) info.model = clone(model); },
    capability(model, workspaceId) {
      const entry = baselines.get(model)?.document?.workspaces[workspaceId];
      return { conditionalSave: Boolean(entry), ...(entry ? { revision: revision(entry) } : {}) };
    },
    async save(model, user, kind = "server-write") {
      const info = baselines.get(model);
      if (!info || !user?.id || !user.workspaceId) fail("workspace_writer_unclassified", 403);
      const result = await store.transact({ actorId: user.id, workspaceId: user.workspaceId, kind, operationId: randomUUID(),
        request: { baseline: info.model, proposed: clone(model), revisions: Object.fromEntries(Object.entries(info.document?.workspaces || {}).map(([id, entry]) => [id, revision(entry)])) } });
      const saved = track(render(result.document, user.workspaceId), result.document, user.workspaceId);
      // Keep the caller's reference and its baseline aligned for subsequent writes.
      for (const key of Object.keys(model)) delete model[key];
      Object.assign(model, saved); baselines.set(model, baselines.get(saved));
      return model;
    },
    async clientSave(user, envelope) {
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) fail("workspace_input_invalid", 400);
      const { operationId, expectedRevision, kind, request } = envelope;
      if (expectedRevision == null) fail("workspace_revision_required", 428);
      if (Object.keys(envelope).sort().join(",") !== "expectedRevision,kind,operationId,request") fail("workspace_input_invalid", 400);
      if (!["model-save", "content-recovery"].includes(kind)) fail("workspace_input_invalid", 400);
      const result = await store.transact({ actorId: user.id, workspaceId: user.workspaceId, operationId, expectedRevision, kind, request });
      return { model: track(render(result.document, user.workspaceId), result.document, user.workspaceId), receipt: {
        operationId: result.operationId, committedRevision: result.committedRevision, currentRevision: result.currentRevision,
        replayed: result.replayed, superseded: result.superseded, durability: result.durability || null
      } };
    },
    close: () => store.close()
  };
}
