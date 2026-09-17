import { describe, expect, it } from "vitest";

import { CHAT_FILL_FIELDS, FACT_FILL_FIELDS, LAYER_A_FILL_FIELDS } from "@badabhai/db";

import { WORKER_FACT_IDS } from "./worker-fact.registry";

/**
 * THE NAMED MIRROR, HELD TO ITS SOURCE. `packages/db/src/chat-fill-coverage.ts` cannot import
 * this registry (the dependency points the other way), so its 19-field fact half is a mirror.
 * This test is the drift guard: add a fact to `WORKER_FACT_IDS` without adding it to the ruler's
 * field list and CI goes red, rather than the new fact silently escaping measurement.
 *
 * The order is asserted too, deliberately: both lists are declared in the registry's own order,
 * and that parity is what makes a diff of the two legible.
 */
describe("chat-fill field universe mirrors the fact registry", () => {
  it("the fact half IS `WORKER_FACT_IDS`, in order — no more, no fewer", () => {
    expect(FACT_FILL_FIELDS).toEqual(WORKER_FACT_IDS);
  });

  it("carries the six Layer A storages that are not facts", () => {
    for (const field of [
      "whatsapp",
      "training",
      "licence",
      "portfolio",
      "secondary_occupations",
      "verification",
    ]) {
      expect(LAYER_A_FILL_FIELDS as readonly string[]).toContain(field);
      expect(CHAT_FILL_FIELDS as readonly string[]).toContain(field);
    }
  });

  it("is a closed, duplicate-free list", () => {
    expect(new Set(CHAT_FILL_FIELDS).size).toBe(CHAT_FILL_FIELDS.length);
    expect(CHAT_FILL_FIELDS.length).toBe(WORKER_FACT_IDS.length + LAYER_A_FILL_FIELDS.length);
  });
});
