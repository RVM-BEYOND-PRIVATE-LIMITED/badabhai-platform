/**
 * Locates and parses the dual-language parity corpus.
 *
 * The Vitest suite in this package and the pytest suite in `apps/ai-service/tests/` read THE
 * SAME FILE. That is the whole mechanism: adding, renaming or changing a case turns the other
 * side red. Same reasoning as `packages/ai-contracts/src/__fixtures__/profiling.keys.json` +
 * `test_contract_parity.py`.
 *
 * Test-only. Never imported by `src/index.ts`, because the corpus is not shipped runtime data
 * and `node:fs` has no business in a package the NestJS orchestrator loads on every turn.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One line of `__fixtures__/utterances.jsonl`. */
export interface UtteranceFixture {
  /** Stable, referenced by failure output. */
  readonly id: string;
  /** The worker's line, verbatim. Pseudonymized before it lands here. */
  readonly text: string;
  /** Expected `classifyUtterance(text).cls`. */
  readonly cls: string;
  /** Expected value of every exported predicate, by its TypeScript name. */
  readonly predicates: Readonly<Record<string, boolean>>;
  /** Why this case exists. Required for regression cases. */
  readonly note?: string;
}

const RELATIVE_CANDIDATES = [
  join("__fixtures__", "utterances.jsonl"),
  join("packages", "profiling-lexicon", "__fixtures__", "utterances.jsonl"),
];

/**
 * Resolve the corpus by walking up from the working directory.
 *
 * Vitest's cwd is the package root under `pnpm --filter` and under turbo, but the repo root
 * when someone runs the suite from there; both are covered rather than assumed.
 *
 * THROWS when the file is absent. It must never degrade to "zero cases, suite green" — a
 * silently-skipped parity suite is strictly worse than no parity suite, because it reports
 * success. This is the same argument `test_contract_parity.py` makes for its `assert exists`.
 */
export function fixturePath(): string {
  let dir = process.cwd();
  for (let up = 0; up < 6; up += 1) {
    for (const candidate of RELATIVE_CANDIDATES) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `profiling-lexicon parity corpus not found from ${process.cwd()} — expected one of ` +
      `${RELATIVE_CANDIDATES.join(" | ")}. The pytest suite asserts against this same file, so ` +
      "losing it silently removes the only cross-language guard.",
  );
}

/** Parse every case. Blank lines are skipped so the file stays diff-friendly. */
export function loadUtteranceFixtures(): UtteranceFixture[] {
  return readFileSync(fixturePath(), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as UtteranceFixture;
      } catch (cause) {
        throw new Error(`utterances.jsonl line ${index + 1} is not valid JSON`, { cause });
      }
    });
}
