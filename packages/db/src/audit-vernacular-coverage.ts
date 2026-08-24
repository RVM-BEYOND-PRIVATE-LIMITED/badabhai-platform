/**
 * D-6 — what the retrieval evaluation actually covers, by vernacular register. READ-ONLY.
 *
 * ===========================================================================
 * NO DATABASE, NO PROVIDER, NO SPEND
 * ===========================================================================
 * Everything it needs is committed: the fixture, the taxonomy corpus, the particle
 * vocabulary, and the recorded evaluation run. That is deliberate — a coverage question
 * should be answerable in CI, on a laptop, with no credentials and no rupees.
 *
 * ===========================================================================
 * WHAT IT MEASURES, AND THE ONE THING IT REFUSES TO
 * ===========================================================================
 * It reports coverage by REGISTER (see `vernacular-coverage.ts`) and, where a recorded run is
 * supplied, joins each case to its measured score so the per-register floor behaviour is read
 * from evidence rather than assumed.
 *
 * It does NOT recommend a floor. `paraphrase_latin` and `devanagari_paraphrase` sit at almost
 * the same distance from 0.75, which is an argument about PARAPHRASE, not about language, and
 * the threshold is an owner decision recorded elsewhere.
 *
 *   pnpm db:audit:vernacular [--eval=<recorded run.json>] [--json=<out>]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { occupationParticles } from "@badabhai/profiling-lexicon";

import { provenance, REPOSITORY_ONLY } from "./evidence-provenance";
import { loadEvalFixture } from "./taxonomy-eval-fixture";
import {
  classifyRegister,
  HYGIENE_RULE,
  summarizeRegisters,
  type Register,
} from "./vernacular-coverage";

const SCRIPT = "audit:vernacular";
const FIXTURE = "data/taxonomy/eval/retrieval-v3.jsonl";
const DEFAULT_EVAL =
  "data/taxonomy/eval/experiments/EXP-P9-TRAINER-V3/" +
  "eval-taxonomy-retrieval-v1-v3-e2-2026-08-21T08_39_29.783Z.json";
const DEFAULT_SWEEP =
  "data/taxonomy/eval/experiments/EXP-P9-TRAINER-V3/floor-sweep-2026-08-21T08_24_53.784Z.json";

/** The floor in force. Read for reporting only — this audit never proposes changing it. */
const FLOOR = 0.75;

const DEVANAGARI_RE = /[ऀ-ॿ]/u;

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface SweepCase {
  case_id: string;
  category: string;
  score: number;
  correct: boolean;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

function main(): void {
  const particles = occupationParticles();
  const latinParticles = new Set(
    [...particles.tokens, ...particles.suffixes].filter((t) => !DEVANAGARI_RE.test(t)),
  );

  const fixture = loadEvalFixture(FIXTURE);
  const coverage = summarizeRegisters(
    fixture.cases.map((c) => c.query),
    latinParticles,
  );

  console.log(`[${SCRIPT}] READ-ONLY. No database, no provider, no spend.`);
  console.log(`  fixture                    = ${FIXTURE}`);
  console.log(`  cases                      = ${coverage.total}`);
  console.log(`  particle vocabulary        = ${particles.tokens.length} tokens, ` +
    `${particles.suffixes.length} suffixes, ${particles.phrases.length} phrases ` +
    `(${latinParticles.size} Latin-script)`);

  console.log(`\n  === coverage by register ===`);
  for (const r of ["english_latin", "devanagari", "hinglish_latin"] as Register[]) {
    const n = coverage.byRegister[r];
    const flag = n === 0 ? "   <- NO COVERAGE" : "";
    console.log(`  ${r.padEnd(18)} ${String(n).padStart(5)}${flag}`);
  }
  if (coverage.absent.includes("hinglish_latin")) {
    console.log(
      `\n  The particle corpus exists to strip "ka kaam karta hun" from romanized Hindi.\n` +
        `  Not one evaluation case contains any of its ${latinParticles.size} Latin tokens, so the\n` +
        `  register it was built for has never been measured.`,
    );
  }

  // ---- per-register score behaviour, from a RECORDED run ----
  const sweepPath = arg("sweep") ?? DEFAULT_SWEEP;
  let byRegister: Record<string, unknown> = {};
  try {
    const sweep = JSON.parse(readFileSync(sweepPath, "utf8")) as {
      detail?: { per_case?: SweepCase[] };
    };
    const perCase = sweep.detail?.per_case ?? [];
    const byId = new Map(fixture.cases.map((c) => [c.case_id, c]));

    const groups = new Map<string, SweepCase[]>();
    for (const pc of perCase) {
      const c = byId.get(pc.case_id);
      if (c === undefined) continue;
      const key = `${classifyRegister(c.query, latinParticles)}/${pc.category}`;
      groups.set(key, [...(groups.get(key) ?? []), pc]);
    }

    console.log(`\n  === measured score behaviour, per register x category ===`);
    console.log(`  (from ${sweepPath.split("/").pop() ?? sweepPath})`);
    console.log(
      `  ${"register / category".padEnd(44)}${"n".padStart(4)}${"mean".padStart(9)}` +
        `${"median".padStart(9)}${"<floor".padStart(8)}${"correct".padStart(9)}`,
    );
    const out: Record<string, unknown> = {};
    for (const [key, rows] of [...groups.entries()].sort()) {
      const scores = rows.map((r) => r.score);
      const below = scores.filter((s) => s < FLOOR).length;
      const correct = rows.filter((r) => r.correct).length;
      console.log(
        `  ${key.padEnd(44)}${String(rows.length).padStart(4)}${mean(scores).toFixed(4).padStart(9)}` +
          `${median(scores).toFixed(4).padStart(9)}${String(below).padStart(8)}` +
          `${`${correct}/${rows.length}`.padStart(9)}`,
      );
      out[key] = {
        n: rows.length,
        mean: Number(mean(scores).toFixed(4)),
        median: Number(median(scores).toFixed(4)),
        below_floor: below,
        correct,
      };
    }
    byRegister = out;

    console.log(
      `\n  READ THIS BEFORE QUOTING IT: the two PARAPHRASE rows sit at nearly the same\n` +
        `  distance from the ${FLOOR} floor. The floor pressure is a paraphrase property, not a\n` +
        `  language property — exact aliases score 1.000 in BOTH scripts. Nothing here is an\n` +
        `  argument for moving the floor, which is an owner decision recorded separately.`,
    );
  } catch (e) {
    console.log(`\n  !! no recorded sweep read (${(e as Error).message.split("\n")[0]})`);
    console.log(`     Per-register score behaviour: NOT MEASURED.`);
  }

  console.log(`\n  ${HYGIENE_RULE}`);

  const out = arg("json");
  if (out !== undefined) {
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          kind: "vernacular-coverage",
          ...provenance({
            source: "pnpm db:audit:vernacular",
            target: REPOSITORY_ONLY,
            readOnly: true,
            role: null,
            populationPredicate: `every case in ${FIXTURE}`,
          }),
          fixture: FIXTURE,
          floor_in_force: FLOOR,
          particle_vocabulary: {
            tokens: particles.tokens.length,
            suffixes: particles.suffixes.length,
            phrases: particles.phrases.length,
            latin_script: latinParticles.size,
          },
          coverage,
          by_register_category: byRegister,
          hygiene_rule: HYGIENE_RULE,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\n  written to ${out}`);
  }

  void DEFAULT_EVAL;
}

if (require.main === module) {
  try {
    main();
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
