import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const source = (await readFile(new URL("./server.mjs", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
function bounded(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source boundary: ${start}`);
  return source.slice(from, to);
}
const fn = name => {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const end = source.slice(start + 1).search(/\n(?:async )?function /);
  assert.ok(end >= 0);
  return source.slice(start, start + 1 + end);
};

test("only the reviewed legacy functions perform direct server model-file writes", () => {
  let scope = "module";
  const writes = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^(?:async )?function (\w+)\(/);
    if (match) scope = match[1];
    if (/await (?:writeFile|copyFile|rename)\(/.test(line)) writes.push(scope);
  }
  assert.deepEqual(writes, ["ensureModel", "localGetModel", "renameLocalModelWithRetry", "localSaveModel"]);
  assert.match(fn("localGetModel"), /if \(localWorkspacePersistence\) return localWorkspacePersistence\.load\(\);\s*await ensureModel\(\)/);
  assert.ok(fn("localSaveModel").indexOf("return localPersistenceWrite(") < fn("localSaveModel").indexOf("await writeFile("));
  assert.match(fn("saveModel"), /if \(localWorkspacePersistence\) return localSaveModel\(model\);\s*try/);
  assert.match(fn("loadModel"), /if \(localWorkspacePersistence\) throw error;/);
  assert.match(source, /if \(!supabaseEnabled && runtimeMode !== "vercel"\)/);
  assert.match(source, /\} else await ensureModel\(\);/);
});

test("steady-state local model, session and devices reads have no persistence write", () => {
  const model = bounded('if (url.pathname === "/api/model" && req.method === "GET")', 'if (url.pathname === "/api/model" && req.method === "POST")');
  assert.match(model, /if \(!localWorkspacePersistence\) await saveModelForUser/);
  const session = bounded('if (url.pathname === "/api/auth/session" && req.method === "GET")', 'if (url.pathname === "/api/auth/device/heartbeat"');
  assert.match(session, /if \(!localWorkspacePersistence\) \{\s*if \(hasActiveAppAccess/);
  const devices = bounded('if (url.pathname === "/api/devices" && req.method === "GET")', "const deviceRevokeMatch");
  assert.match(devices, /if \(!localWorkspacePersistence\) await saveModel\(model\)/);
  assert.match(fn("loadModel"), /if \(changed && !localWorkspacePersistence\) await saveModel/);
});

test("storage errors are not converted into success or retryable provider work", () => {
  const gate = fn("localPersistenceWrite");
  assert.match(gate, /if \(context\?\.persistenceError\) throw context\.persistenceError/);
  assert.match(gate, /error\.retryable = false/);
  assert.match(gate, /error\.blocked = true/);
  assert.match(gate, /context\.persistenceError = error/);
  const output = bounded("function json(", "function setCookie(");
  assert.match(output, /status = storageError\.status/);
  assert.match(output, /commitStatus: storageError\.commitStatus/);
});

test("all current save call sites have an explicit writer category and an inspectable inventory", async () => {
  let scope = "module", route = "";
  const inventory = [];
  const core = new Set(["localGetModel", "loadModel", "saveModel", "saveModelForUser"]);
  for (const [index, line] of source.split("\n").entries()) {
    const match = line.match(/^(?:async )?function (\w+)\(/);
    if (match) { scope = match[1]; route = ""; }
    if (scope === "route" && /^  if \(/.test(line)) route = line.trim();
    if (!/\b(?:localSaveModel|saveModel|saveModelForUser)\(/.test(line) || /^(?:async )?function /.test(line)) continue;
    let category;
    if (core.has(scope)) category = "guarded-local-core / unchanged-hosted-fallback";
    else if (/^process\w+WorkerJob$/.test(scope)) category = "worker-content: captured revision or reject";
    else if (/^apply\w+WebhookEvent$/.test(scope)) category = "webhook: tracked owner context or reject";
    else if (/^(refresh|verify|usable|repaired|markProvider|requireThreads|syncGoogleBusiness)/.test(scope)) category = "provider-state: guarded shared/content delta or reject";
    else if (scope === "route" && /\/api\/(auth|devices|workspace)|deviceRevokeMatch|\/app\"/.test(route)) category = "identity/registry: fresh shared delta; signup creates owned content";
    else if (scope === "route" && /\/api\/(oauth|meta|provider|discord|manychat|elevenlabs|tiktok|short-video|youtube|x\/|threads|accounts)/.test(route.replaceAll("\\/", "/"))) category = "provider-route: guarded shared/content delta or reject";
    else if (scope === "route" && /\/api\/(model|media|e2e|generate|intelligence|publish|proof|actions|automation|ads|campaigns|analyze)/.test(route)) category = "workspace-content: captured revision or client envelope";
    assert.ok(category, `Unclassified model writer at ${index + 1}: ${scope} ${route}`);
    inventory.push({ line: index + 1, caller: route || scope, statement: line.trim(), category });
  }
  assert.ok(inventory.length > 150);
  const directory = new URL("./.tmp/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("local-writer-inventory.json", directory), JSON.stringify({ source: "server.mjs", callSites: inventory.length, inventory }, null, 2));
});

test("deployment retains the root server and does not add a duplicate API entrypoint", async () => {
  const config = JSON.parse(await readFile(new URL("./vercel.json", import.meta.url), "utf8"));
  assert.ok(JSON.stringify(config).includes("server.mjs"));
  assert.ok(!JSON.stringify(config).includes("api/server.mjs"));
  await assert.rejects(readFile(new URL("./api/server.mjs", import.meta.url)), { code: "ENOENT" });
});
