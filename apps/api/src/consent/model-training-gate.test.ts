import { describe, expect, it, vi } from "vitest";
import type { WorkerConsent } from "@badabhai/db";
import {
  MODEL_TRAINING_PURPOSE,
  modelTrainingAllowed,
  type LatestConsentStatesReader,
} from "./model-training-gate";

/**
 * #2753 item 13 — the model-training gate's truth table. The gate is the latest-row rule, so the
 * reader here hands back "the latest row" directly; that the repository picks the latest row is
 * proved against Postgres in `model-training-gate.db.test.ts`.
 */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

type State = Pick<WorkerConsent, "purposes" | "revokedAt">;

function reader(rows: Record<string, unknown>): LatestConsentStatesReader & {
  findLatestStatesByWorkers: ReturnType<typeof vi.fn>;
} {
  return {
    findLatestStatesByWorkers: vi.fn(
      async (ids: readonly string[]) =>
        new Map(ids.filter((id) => id in rows).map((id) => [id, rows[id] as State])),
    ),
  };
}

const granted: State = { purposes: ["profiling", "model_training"], revokedAt: null };

describe("modelTrainingAllowed — one worker", () => {
  it("is the consent purpose ADR-0018 names", () => {
    expect(MODEL_TRAINING_PURPOSE).toBe("model_training");
  });

  it("yes: the latest row is not revoked and names model_training", async () => {
    await expect(modelTrainingAllowed(reader({ [A]: granted }), A)).resolves.toBe(true);
  });

  it.each<[string, unknown]>([
    ["the latest row is revoked", { ...granted, revokedAt: new Date() }],
    ["the latest row lacks model_training", { purposes: ["profiling"], revokedAt: null }],
    ["the latest row names no purpose", { purposes: [], revokedAt: null }],
    ["purposes is not a list (an unknown answer)", { purposes: "model_training", revokedAt: null }],
    ["revokedAt is missing (an unknown answer)", { purposes: ["model_training"] }],
  ])("no: %s", async (_case, row) => {
    await expect(modelTrainingAllowed(reader({ [A]: row }), A)).resolves.toBe(false);
  });

  it("no: the worker has no consent row at all", async () => {
    await expect(modelTrainingAllowed(reader({}), A)).resolves.toBe(false);
  });

  it("no: the read throws", async () => {
    const failing = reader({});
    failing.findLatestStatesByWorkers.mockRejectedValue(new Error("connection terminated"));
    await expect(modelTrainingAllowed(failing, A)).resolves.toBe(false);
  });

  it("no: there is no reader", async () => {
    await expect(modelTrainingAllowed(undefined, A)).resolves.toBe(false);
  });

  it("no: an id that is not a uuid, which never reaches the query", async () => {
    const r = reader({ "not-a-uuid": granted });
    await expect(modelTrainingAllowed(r, "not-a-uuid")).resolves.toBe(false);
    expect(r.findLatestStatesByWorkers).not.toHaveBeenCalled();
  });
});

describe("modelTrainingAllowed — a batch", () => {
  it("returns exactly the allowed ids, from ONE read of the distinct well-formed ids", async () => {
    const r = reader({
      [A]: granted,
      [B]: { purposes: ["profiling"], revokedAt: null },
    });

    const allowed = await modelTrainingAllowed(r, [A, B, C, A, "junk"]);

    expect([...allowed]).toEqual([A]);
    expect(r.findLatestStatesByWorkers).toHaveBeenCalledTimes(1);
    expect(r.findLatestStatesByWorkers).toHaveBeenCalledWith([A, B, C]);
  });

  it("a read that throws allows no one", async () => {
    const r = reader({ [A]: granted });
    r.findLatestStatesByWorkers.mockRejectedValue(new Error("timeout"));
    expect((await modelTrainingAllowed(r, [A, B])).size).toBe(0);
  });

  it("an empty batch reads nothing and allows no one", async () => {
    const r = reader({});
    expect((await modelTrainingAllowed(r, [])).size).toBe(0);
    expect(r.findLatestStatesByWorkers).not.toHaveBeenCalled();
  });
});
