import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const serverUrl = new URL("./server.mjs", import.meta.url);
const moduleUrl = new URL("./openai-response-schemas.mjs", import.meta.url);
const serverSource = await readFile(serverUrl, "utf8");

function factoryFromServerSource(name) {
  const marker = `function ${name}() {`;
  const start = serverSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} is missing from server.mjs`);
  const bodyStart = serverSource.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < serverSource.length; index += 1) {
    if (serverSource[index] === "{") depth += 1;
    if (serverSource[index] === "}") depth -= 1;
    if (depth === 0) return runInNewContext(`(${serverSource.slice(start, index + 1)})`);
  }
  throw new Error(`${name} has an unterminated function body`);
}

let schemaFactories;
try {
  schemaFactories = await import(moduleUrl.href);
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  schemaFactories = {
    platformVariantOutputSchema: factoryFromServerSource("platformVariantOutputSchema"),
    audienceBriefOutputSchema: factoryFromServerSource("audienceBriefOutputSchema")
  };
}

assert.deepEqual(
  Object.keys(schemaFactories).sort(),
  ["audienceBriefOutputSchema", "platformVariantOutputSchema"],
  "schema module exports changed"
);

const expectedPlatformVariantSchema = {
  type: "object",
  additionalProperties: false,
  required: ["variants"],
  properties: {
    variants: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["platform", "copy", "tags", "rationale", "mediaDirection"],
        properties: {
          platform: { type: "string" },
          copy: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          mediaDirection: { type: "string" }
        }
      }
    }
  }
};

const expectedAudienceBriefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "audienceMood", "evidenceStatus", "confidence", "strongestSignals", "risks", "nextMoves"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    audienceMood: { type: "string" },
    evidenceStatus: { type: "string", enum: ["live", "mixed", "limited"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    strongestSignals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["signal", "evidence"],
        properties: { signal: { type: "string" }, evidence: { type: "string" } }
      }
    },
    risks: { type: "array", items: { type: "string" } },
    nextMoves: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "reason", "measure"],
        properties: { action: { type: "string" }, reason: { type: "string" }, measure: { type: "string" } }
      }
    }
  }
};

function objectReferences(value, path = "$", references = new Map()) {
  if (!value || typeof value !== "object") return references;
  references.set(path, value);
  for (const [key, child] of Object.entries(value)) objectReferences(child, `${path}.${key}`, references);
  return references;
}

function assertSchemaFactory(factory, expected, name) {
  assert.equal(typeof factory, "function", `${name} must export a function`);
  const first = factory();
  const second = factory();
  assert.deepEqual(JSON.parse(JSON.stringify(first)), expected, `${name} output changed`);
  assert.equal(JSON.stringify(first), JSON.stringify(expected), `${name} key ordering changed`);
  assert.equal(JSON.stringify(second), JSON.stringify(expected), `${name} is not deterministic`);

  const firstReferences = objectReferences(first);
  const secondReferences = objectReferences(second);
  assert.deepEqual([...firstReferences.keys()], [...secondReferences.keys()], `${name} object layout changed between calls`);
  for (const [path, reference] of firstReferences) {
    assert.notStrictEqual(reference, secondReferences.get(path), `${name} shares mutable state at ${path}`);
  }

  first.required.push("__contract_test_mutation__");
  first.properties.__contract_test_mutation__ = { type: "null" };
  assert.equal(JSON.stringify(factory()), JSON.stringify(expected), `${name} retained caller mutations`);
}

assert.match(
  serverSource,
  /type:\s*"json_schema",\s*name,\s*strict:\s*true,\s*schema/,
  "OpenAI structured responses must remain strict JSON-schema responses"
);
assert.match(
  serverSource,
  /name:\s*"social_cues_platform_variants",\s*schema:\s*platformVariantOutputSchema\(\)/,
  "platform variant schema name or call site changed"
);
assert.match(
  serverSource,
  /name:\s*"social_cues_audience_brief",\s*schema:\s*audienceBriefOutputSchema\(\)/,
  "audience brief schema name or call site changed"
);

assertSchemaFactory(
  schemaFactories.platformVariantOutputSchema,
  expectedPlatformVariantSchema,
  "platformVariantOutputSchema"
);
assertSchemaFactory(
  schemaFactories.audienceBriefOutputSchema,
  expectedAudienceBriefSchema,
  "audienceBriefOutputSchema"
);

console.log(JSON.stringify({ ok: true, schemas: 2, strictJsonSchema: true }));
