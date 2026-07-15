/**
 * Shared ai-service embed-response validation for the fork-B runners
 * (embed-skill-aliases.ts + growth-cluster.ts). Extracted, not new behavior.
 */

export interface EmbedItemResult {
  alias_id: string;
  vector: number[] | null;
  blocked: boolean;
}

export interface EmbedResponse {
  results: EmbedItemResult[];
  is_mock: boolean;
  model: string;
  budget_stopped: boolean;
  errors: number;
  estimated_cost_inr: number;
}

/** Validate the response SHAPE at runtime (no blind cast — the runners write vectors into
 * the DB, so a malformed/foreign response must abort, not corrupt). Every returned
 * alias_id must be one we actually sent; vectors must be exactly 768-dim. */
export function parseEmbedResponse(raw: unknown, sentIds: Set<string>): EmbedResponse {
  const bad = (why: string): never => {
    throw new Error(`[embed] malformed ai-service response — ${why}`);
  };
  if (typeof raw !== "object" || raw === null) bad("not an object");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.results)) bad("results is not an array");
  const results: EmbedItemResult[] = [];
  for (const r of o.results as unknown[]) {
    if (typeof r !== "object" || r === null) bad("result item is not an object");
    const it = r as Record<string, unknown>;
    if (typeof it.alias_id !== "string" || !sentIds.has(it.alias_id)) {
      bad(`result alias_id ${String(it.alias_id)} was not in the request`);
    }
    const vector = it.vector ?? null;
    if (vector !== null) {
      if (!Array.isArray(vector) || vector.length !== 768 || !vector.every((v) => typeof v === "number")) {
        bad(`vector for ${String(it.alias_id)} is not a 768-dim number array`);
      }
    }
    results.push({
      alias_id: it.alias_id as string,
      vector: vector as number[] | null,
      blocked: it.blocked === true,
    });
  }
  return {
    results,
    is_mock: o.is_mock !== false,
    model: typeof o.model === "string" ? o.model : "",
    budget_stopped: o.budget_stopped === true,
    errors: typeof o.errors === "number" ? o.errors : 0,
    estimated_cost_inr: typeof o.estimated_cost_inr === "number" ? o.estimated_cost_inr : 0,
  };
}
