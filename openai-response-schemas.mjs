export function platformVariantOutputSchema() {
  return {
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
}

export function audienceBriefOutputSchema() {
  return {
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
}
