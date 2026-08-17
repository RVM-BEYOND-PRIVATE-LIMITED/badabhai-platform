/**
 * The experiment registry. Its whole job is that a preserved measurement stays preserved and
 * stays interpretable, so the tests are about REFUSING things: overwriting a record, and
 * comparing two numbers that were produced by different instruments.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compareExperiments,
  EXPERIMENTS,
  isExperimentId,
  pushExperimentToLangfuse,
  readExperiment,
  runFileName,
  UNKNOWN_ANN,
  writeExperimentRecord,
  type ExperimentRecord,
} from "./taxonomy-experiments";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tax-exp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (o: Partial<ExperimentRecord> = {}): ExperimentRecord => ({
  experiment: "EXP-BASELINE",
  run_id: "run-1",
  recorded_at: "2026-08-17T00:00:00.000Z",
  purpose: "test",
  evaluator_version: 1,
  fixture_id: "taxonomy-retrieval-v1",
  fixture_version: 1,
  corpus_batch: "batch_x",
  model: "gemini-embedding-001",
  embedding_model: "gemini-embedding-001",
  query_count: 123,
  failure_count: 0,
  latency_ms: 1000,
  recall_at_1: 0.991,
  recall_at_3: 1,
  recall_at_5: 1,
  mrr: 0.996,
  input_tokens: 598,
  cost_inr_metered: null,
  cost_inr_estimated: 0.0075,
  ann: { ...UNKNOWN_ANN, corpus_rows: 197, k: 5 },
  notes: [],
  ...o,
});

describe("experiment ids", () => {
  it("is a CLOSED set", () => {
    // An ad-hoc id typed at a prompt produces a directory nobody looks in again, and the
    // value of a registry is that the set of comparable things is itself reviewable.
    expect(isExperimentId("EXP-BASELINE")).toBe(true);
    expect(isExperimentId("EXP-WHATEVER")).toBe(false);
    expect(Object.keys(EXPERIMENTS)).toContain("EXP-EVAL-CORRECTION");
  });

  it("refuses to write an unknown experiment", () => {
    expect(() => writeExperimentRecord(rec({ experiment: "NOPE" as never }), dir)).toThrow(/unknown experiment/);
  });
});

describe("runFileName", () => {
  it("makes an ISO run id filesystem-safe without collapsing distinct ids", () => {
    // `:` is illegal in a Windows filename, and every run id carries an ISO timestamp.
    expect(runFileName("eval-x-v1-2026-08-17T05:41:39.559Z")).toBe("eval-x-v1-2026-08-17T05_41_39.559Z.json");
    expect(runFileName("a/b")).not.toBe(runFileName("a-b"));
  });

  it("rejects a run id that sanitizes to nothing", () => {
    expect(() => runFileName("///")).not.toThrow(); // becomes ___
    expect(() => runFileName("")).toThrow(/empty file name/);
  });
});

describe("writeExperimentRecord — immutability", () => {
  it("writes a readable record", () => {
    const path = writeExperimentRecord(rec(), dir);
    const back = JSON.parse(readFileSync(path, "utf8")) as ExperimentRecord;
    expect(back.recall_at_1).toBe(0.991);
    expect(back.ann.corpus_rows).toBe(197);
  });

  it("REFUSES to overwrite an existing run", () => {
    // The realistic way to lose a baseline is not malice: it is re-running with the same id
    // after an edit, which replaces the thing being compared against with the thing doing
    // the comparing. There is deliberately no --force.
    writeExperimentRecord(rec(), dir);
    expect(() => writeExperimentRecord(rec({ recall_at_1: 0.5 }), dir)).toThrow(/immutable/);
    const back = JSON.parse(readFileSync(join(dir, "EXP-BASELINE", "run-1.json"), "utf8")) as ExperimentRecord;
    expect(back.recall_at_1).toBe(0.991); // unchanged
  });

  it("keeps runs of the same experiment side by side", () => {
    writeExperimentRecord(rec({ run_id: "run-1", recorded_at: "2026-08-17T00:00:00.000Z" }), dir);
    writeExperimentRecord(rec({ run_id: "run-2", recorded_at: "2026-08-18T00:00:00.000Z" }), dir);
    expect(readExperiment("EXP-BASELINE", dir).map((r) => r.run_id)).toEqual(["run-1", "run-2"]);
  });

  it("reads an absent experiment as empty rather than throwing", () => {
    expect(readExperiment("EXP-ANN-DEFAULT", dir)).toEqual([]);
  });

  it("orders by recorded_at, not by filesystem order", () => {
    writeExperimentRecord(rec({ run_id: "zzz", recorded_at: "2026-01-01T00:00:00.000Z" }), dir);
    writeExperimentRecord(rec({ run_id: "aaa", recorded_at: "2026-12-01T00:00:00.000Z" }), dir);
    expect(readExperiment("EXP-BASELINE", dir).map((r) => r.run_id)).toEqual(["zzz", "aaa"]);
  });
});

describe("compareExperiments — an instrument change is not a result change", () => {
  it("flags an evaluator change as NOT comparable", () => {
    // This is the Phase 6 headline. R@1 moved and the model did not, so a bare delta is a
    // false claim; the comparison has to carry why.
    const c = compareExperiments(rec({ evaluator_version: 1 }), rec({ evaluator_version: 2, recall_at_1: 1 }));
    expect(c.comparable).toBe(false);
    expect(c.instrument_changes.join(" ")).toMatch(/evaluator_version 1 -> 2/);
    expect(c.delta_recall_at_1).toBeCloseTo(0.009, 6);
  });

  it("flags a fixture version change", () => {
    const c = compareExperiments(rec(), rec({ fixture_version: 2 }));
    expect(c.comparable).toBe(false);
    expect(c.instrument_changes.join(" ")).toMatch(/fixture .*v1 -> .*v2/);
  });

  it("flags a corpus-size change — the same recall means something else at another scale", () => {
    const c = compareExperiments(rec(), rec({ ann: { ...UNKNOWN_ANN, corpus_rows: 9121 } }));
    expect(c.comparable).toBe(false);
    expect(c.instrument_changes.join(" ")).toMatch(/corpus_rows 197 -> 9121/);
  });

  it("flags ANN knobs that change what a recall number means", () => {
    const a = rec({ ann: { ...UNKNOWN_ANN, hnsw_used: false, ef_search: 40, iterative_scan: "off" } });
    const b = rec({ ann: { ...UNKNOWN_ANN, hnsw_used: true, ef_search: 100, iterative_scan: "relaxed_order" } });
    const c = compareExperiments(a, b);
    expect(c.instrument_changes.join(" ")).toMatch(/hnsw_used false -> true/);
    expect(c.instrument_changes.join(" ")).toMatch(/ef_search 40 -> 100/);
    expect(c.instrument_changes.join(" ")).toMatch(/iterative_scan off -> relaxed_order/);
  });

  it("calls two runs on the SAME instrument comparable", () => {
    const c = compareExperiments(rec({ run_id: "a" }), rec({ run_id: "b", recall_at_1: 0.95 }));
    expect(c.comparable).toBe(true);
    expect(c.instrument_changes).toEqual([]);
    expect(c.delta_recall_at_1).toBeCloseTo(-0.041, 6);
  });

  it("reports a null delta rather than inventing one when a side was not measured", () => {
    const c = compareExperiments(rec({ recall_at_1: null }), rec());
    expect(c.delta_recall_at_1).toBeNull();
  });
});

describe("pushExperimentToLangfuse — credential-safe", () => {
  it("reports NOT_CONFIGURED instead of throwing when keys are absent", async () => {
    // A missing observability backend must never decide whether a measurement happened; the
    // disk record is already written by the time this runs.
    const r = await pushExperimentToLangfuse(rec(), {} as NodeJS.ProcessEnv);
    expect(r).toEqual({ status: "LANGFUSE_NOT_CONFIGURED" });
  });

  it("does not call the network when unconfigured", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    await pushExperimentToLangfuse(rec(), { LANGFUSE_PUBLIC_KEY: "pk" } as NodeJS.ProcessEnv, spy);
    expect(called).toBe(false);
  });

  it("posts the whole record so a score can never be shown without its instrument", async () => {
    let body: any = null;
    let auth = "";
    const spy = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      auth = (init.headers as Record<string, string>).authorization ?? "";
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await pushExperimentToLangfuse(
      rec(),
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" } as NodeJS.ProcessEnv,
      spy,
    );
    expect(r.status).toBe("PUSHED");
    expect(auth.startsWith("Basic ")).toBe(true);
    const meta = body.batch[0].body.metadata;
    expect(meta.evaluator_version).toBe(1);
    expect(meta.ann.corpus_rows).toBe(197);
    expect(body.batch[0].body.tags).toContain("EXP-BASELINE");
  });

  it("reports a push FAILURE instead of throwing", async () => {
    const spy = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = await pushExperimentToLangfuse(
      rec(),
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" } as NodeJS.ProcessEnv,
      spy,
    );
    expect(r).toEqual({ status: "FAILED", reason: "HTTP 500" });
  });

  it("survives a transport error", async () => {
    const spy = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r = await pushExperimentToLangfuse(
      rec(),
      { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" } as NodeJS.ProcessEnv,
      spy,
    );
    expect(r).toEqual({ status: "FAILED", reason: "TypeError" });
  });
});

describe("the committed EXP-BASELINE record", () => {
  it("preserves the Phase 5 numbers under evaluator_version 1", () => {
    // The baseline is a v1 measurement and must stay labelled as one: every Phase 6 number
    // is compared against it, and the comparison is only honest if the instrument is stated.
    const runs = readExperiment("EXP-BASELINE");
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const first = runs[0] as ExperimentRecord;
    expect(first.evaluator_version).toBe(1);
    expect(first.fixture_version).toBe(1);
    expect(first.embedding_model).toBe("gemini-embedding-001");
    expect(first.recall_at_1).toBe(0.9912);
    expect(first.mrr).toBe(0.9956);
    expect(first.ann.corpus_rows).toBe(197);
    expect(first.ann.hnsw_used).toBe(false);
  });
});
