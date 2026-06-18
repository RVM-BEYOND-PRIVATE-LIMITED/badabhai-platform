import { describe, it, expect } from "vitest";
import { assembleDataset } from "./dataset";
import { buildSyntheticData } from "./fixtures/synthetic";
import { stableStringify } from "./hash";
import { assertFeatureVectorClean } from "./features";

describe("dataset assembly — events-only, temporal, reproducible (ADR-0017 Decision 2)", () => {
  it("assembles labelled rows from feed.shown + application.* and splits temporally", () => {
    const { events, snapshot } = buildSyntheticData({ seed: 7 });
    const ds = assembleDataset(events, snapshot, { testFraction: 0.3 });
    expect(ds.train.length).toBeGreaterThan(0);
    expect(ds.test.length).toBeGreaterThan(0);
    expect(ds.manifest.rowCount).toBe(ds.train.length + ds.test.length);
    // temporal: every train row is strictly before every test row.
    const maxTrain = Math.max(...ds.train.map((r) => Date.parse(r.shownAt)));
    const minTest = Math.min(...ds.test.map((r) => Date.parse(r.shownAt)));
    expect(maxTrain).toBeLessThanOrEqual(minTest);
    // labels are binary; positives exist.
    expect(ds.train.every((r) => r.label === 0 || r.label === 1)).toBe(true);
    expect([...ds.train, ...ds.test].some((r) => r.label === 1)).toBe(true);
  });

  it("every row's feature vector is allowlist-clean (no ids/PII)", () => {
    const { events, snapshot } = buildSyntheticData({ seed: 7 });
    const ds = assembleDataset(events, snapshot);
    for (const r of [...ds.train, ...ds.test]) expect(() => assertFeatureVectorClean(r.features)).not.toThrow();
  });

  it("is deterministic — same events+snapshot+opts → byte-identical dataset", () => {
    const a = buildSyntheticData({ seed: 11 });
    const b = buildSyntheticData({ seed: 11 });
    const da = assembleDataset(a.events, a.snapshot, { testFraction: 0.25 });
    const db = assembleDataset(b.events, b.snapshot, { testFraction: 0.25 });
    expect(stableStringify(da)).toBe(stableStringify(db));
  });

  it("refuses to assemble if a PII-shaped field leaked into an event", () => {
    const { events, snapshot } = buildSyntheticData({ seed: 1 });
    const poisoned = [
      { event_name: "feed.shown", payload: { worker_id: "w", job_id: "j", rank: 1, phone: "+91 90000 00000" }, created_at: new Date().toISOString() },
      ...events,
    ];
    expect(() => assembleDataset(poisoned, snapshot)).toThrow(/PII-shaped/);
  });
});
