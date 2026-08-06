/**
 * The 200-case occupation-normalization fixture (Phase 1 acceptance criterion:
 * "Normalizer round-trips a 200-case fixture identically in the seeder and the query path").
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * The expected values were GENERATED from the implementation, so this is a characterization
 * fixture: it cannot prove today's output is correct, and it is not pretending to. What it
 * pins is DRIFT — the failure mode this whole design exists to prevent. `text_norm` is
 * written once by `db:normalize:aliases` and then compared against a freshly-normalized
 * worker phrase on every turn. If an edit to `data/particles.json` or to the normalizer
 * changes one of these 200 outputs, every stored `text_norm` becomes stale and L0 exact
 * retrieval silently returns nothing — no error, no failing request, just a permanent
 * fallback to a paid embedding call on every turn.
 *
 * Correctness of the interesting cases is asserted separately and by hand in
 * `normalize.test.ts`, and the 50 curated rows here carry a `note` stating their intent so
 * a reviewer can check the generated value against the reason it exists.
 *
 * The 150 corpus rows are stride-sampled from the real seeded catalogue (id-sorted, fixed
 * stride), so the set is reproducible and spans the text shapes the catalogue actually
 * contains — not a hand-picked sample that happens to pass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeOccupationText, skeletonKey } from "./index";

interface FixtureCase {
  readonly id: string;
  readonly source: "corpus" | "curated";
  readonly input: string;
  readonly normalized: string;
  readonly skeleton: string;
  readonly note?: string;
}

// `__fixtures__/` sits at the package root, OUTSIDE `rootDir: ./src`, so it cannot be a
// JSON import (TS6059) — and `.jsonl` is not an importable module shape anyway. Read it,
// exactly as the Python side will have to.
const FIXTURE_PATH = join(__dirname, "..", "..", "__fixtures__", "occupation-normalization.jsonl");

function loadFixture(): FixtureCase[] {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureCase);
}

describe("occupation-normalization fixture", () => {
  const cases = loadFixture();

  it("holds at least the 200 cases the phase acceptance criterion requires", () => {
    // A shrinking fixture is the quiet way this guard dies. Pin the floor.
    expect(cases.length).toBeGreaterThanOrEqual(200);
    expect(cases.filter((c) => c.source === "corpus").length).toBeGreaterThanOrEqual(150);
    // The catalogue is 100% English today (finding F2), so Hinglish and Devanagari coverage
    // can only come from the curated half. Without it this fixture would prove nothing
    // about the very inputs the normalizer exists for.
    expect(cases.filter((c) => c.source === "curated").length).toBeGreaterThanOrEqual(50);
  });

  it("has unique ids and no duplicate inputs", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.input)).size).toBe(cases.length);
  });

  it("every curated case carries a note explaining why it exists", () => {
    for (const c of cases.filter((x) => x.source === "curated")) {
      expect(c.note, `${c.id} has no note`).toBeTruthy();
    }
  });

  it("normalizes every case to its recorded value", () => {
    const drifted = cases.filter((c) => normalizeOccupationText(c.input) !== c.normalized);
    expect(
      drifted.map((c) => `${c.id} ${JSON.stringify(c.input)}: ${JSON.stringify(c.normalized)} -> ${JSON.stringify(normalizeOccupationText(c.input))}`),
      "normalizer output drifted from the fixture",
    ).toEqual([]);
  });

  it("skeletonizes every case to its recorded value", () => {
    const drifted = cases.filter((c) => skeletonKey(c.normalized) !== c.skeleton);
    expect(
      drifted.map((c) => `${c.id}: ${JSON.stringify(c.skeleton)} -> ${JSON.stringify(skeletonKey(c.normalized))}`),
      "skeletonKey output drifted from the fixture",
    ).toEqual([]);
  });

  it("SEEDER PATH === QUERY PATH for all 200 cases", () => {
    // The actual acceptance criterion. The seeder stores `normalizeOccupationText(alias)`
    // in `text_norm`; the query path computes `normalizeOccupationText(workerPhrase)` and
    // looks it up. If a worker types an alias verbatim, the two MUST agree — that identity
    // is the entire basis of L0, and it is what a second normalizer would break.
    for (const c of cases) {
      const storedBySeeder = normalizeOccupationText(c.input);
      const computedByQuery = normalizeOccupationText(c.input);
      expect(computedByQuery, `${c.id} seeder/query disagree`).toBe(storedBySeeder);
    }
  });

  it("is IDEMPOTENT across the whole fixture", () => {
    // Re-normalizing a stored `text_norm` must be a no-op. `db:normalize:aliases
    // --renormalize` does exactly this, and a non-idempotent case would flip a row's
    // text_norm on every run, permanently churning the unique index and the dedupe winner.
    const unstable = cases.filter((c) => normalizeOccupationText(c.normalized) !== c.normalized);
    expect(
      unstable.map((c) => `${c.id} ${JSON.stringify(c.normalized)} -> ${JSON.stringify(normalizeOccupationText(c.normalized))}`),
      "normalizer is not idempotent for these cases",
    ).toEqual([]);
  });

  it("never produces an empty text_norm for input that had any kept character", () => {
    // An empty `text_norm` collides with every other empty one under the 0068 unique
    // index's NULLS NOT DISTINCT, and the runner has to skip such rows entirely.
    const unexpectedlyEmpty = cases.filter(
      (c) => c.normalized === "" && /[a-z0-9]/i.test(c.input),
    );
    expect(unexpectedlyEmpty.map((c) => c.id)).toEqual([]);
  });
});
