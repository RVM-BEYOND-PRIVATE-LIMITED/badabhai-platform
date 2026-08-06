/**
 * `pnpm db:verify:packs` — the question-pack DEPLOY GATE.
 *
 * Two layers, and the split matters. `validateQuestionPackCorpus` checks the COMMITTED
 * FILES and needs no database; the checks here run against the LIVE TABLES and catch what
 * a corpus cannot see — a seed that half-applied, a pack orphaned by a family someone
 * deprecated, an occupation the catalogue gained after the bindings were authored.
 *
 * `exitCode = 1` on any FAIL, mirroring `verify-job-domains.ts`, so this can sit in a
 * deploy chain and actually stop it. Same `Check{name, level, detail, count}` shape, same
 * WARN-does-not-fail rule: a warning is something to look at, a failure is something that
 * makes the engine behave wrongly for a worker.
 *
 *   pnpm db:verify:packs             # live-DB gate
 *   pnpm db:verify:packs --corpus    # corpus only, no database (what CI can run offline)
 *
 * PRIVACY: reads reference tables only. Every log line is ids and counts.
 */
import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import {
  loadQuestionPackCorpus,
  summariseQuestionPackCorpus,
  validateQuestionPackCorpus,
} from "./question-pack-corpus";

// Repo-root env, same as verify-job-domains.ts. Loaded at module scope rather than inside
// main() because the corpus layer runs before any database is touched and must not
// depend on ordering.
config({ path: "../../" + [".", "env"].join("") });
config();

const SCRIPT = "verify:packs";

interface Check {
  name: string;
  level: "FAIL" | "WARN";
  detail: string;
  count: number;
}

function report(checks: Check[]): number {
  console.log(`[${SCRIPT}] checks:`);
  let failures = 0;
  for (const c of checks) {
    if (c.count === 0) {
      console.log(`  PASS  ${c.name}`);
      continue;
    }
    if (c.level === "FAIL") failures++;
    console.log(`  ${c.level}  ${c.name} = ${c.count}`);
    console.log(`          ${c.detail}`);
  }
  return failures;
}

async function main(): Promise<void> {
  const corpusOnly = process.argv.includes("--corpus");

  // ── Layer 1: the committed corpus ─────────────────────────────────────────
  const corpus = loadQuestionPackCorpus();
  const summary = summariseQuestionPackCorpus(corpus);
  console.log(`[${SCRIPT}] corpus:`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(26)} = ${v}`);

  const problems = validateQuestionPackCorpus(corpus);
  const corpusFatal = problems.filter((p) => !p.includes("WARN"));
  const corpusWarn = problems.filter((p) => p.includes("WARN"));
  if (corpusWarn.length > 0) {
    console.log(`[${SCRIPT}] corpus warnings:`);
    for (const w of corpusWarn) console.log(`  WARN  ${w}`);
  }
  if (corpusFatal.length > 0) {
    console.error(`[${SCRIPT}] corpus INVALID:`);
    for (const p of corpusFatal) console.error(`  FAIL  ${p}`);
    process.exit(1);
  }
  console.log(`[${SCRIPT}] corpus valid.`);

  if (corpusOnly) {
    console.log(`[${SCRIPT}] --corpus: skipping live-database checks.`);
    return;
  }

  // ── Layer 2: the live tables ──────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const { db, sql } = createDbClient(url, { max: 1 });

  try {
    const one = async (q: ReturnType<typeof dsql>): Promise<number> => {
      const rows = (await db.execute(q)) as unknown as { n: number | string }[];
      return Number(rows[0]?.n ?? 0);
    };

    const families = await one(dsql`SELECT count(*)::int AS n FROM profiling_family`);
    const bindings = await one(dsql`SELECT count(*)::int AS n FROM profiling_family_binding`);
    const packs = await one(dsql`SELECT count(*)::int AS n FROM question_pack`);
    const items = await one(dsql`SELECT count(*)::int AS n FROM question_pack_item`);
    console.log(`[${SCRIPT}] live:`);
    console.log(`  families                   = ${families}`);
    console.log(`  bindings                   = ${bindings}`);
    console.log(`  packs                      = ${packs}`);
    console.log(`  items                      = ${items}`);

    // An EMPTY table here is the same class of bug the job-domain verifier had: a count
    // of zero must FAIL, not short-circuit to PASS, or a seed that never ran looks clean.
    if (families === 0 || packs === 0) {
      console.error(
        `[${SCRIPT}] FAIL — the pack tables are EMPTY. Run 'pnpm db:seed:packs --apply'. ` +
          `An empty catalogue is not a passing state; it means no worker can be interviewed.`,
      );
      process.exit(1);
    }

    const checks: Check[] = [
      {
        name: "families with no binding (unreachable)",
        level: "FAIL",
        detail: "A family nothing binds to can never be resolved, so its pack is dead weight.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM profiling_family f
          WHERE NOT EXISTS (SELECT 1 FROM profiling_family_binding b WHERE b.family_id = f.family_id)`),
      },
      {
        // THE ONLY GENUINELY FATAL MISSING PACK. A family with a binding but no pack is
        // not broken — the fallback chain routes it to the universal pack, which is the
        // designed behaviour and exactly the state Phase 6 works through. The universal
        // family is different: nothing is below it, so if IT has no active pack every
        // unauthored trade gets a resolution and then no questions.
        //
        // Scoping this correctly matters more than it looks. The first cut FAILed on all
        // 40 unauthored families, which would have left the deploy gate red for the whole
        // of Phase 6 — and a gate that is always red is a gate someone switches off. Same
        // defect the job-domain verifier had against a freshly-seeded catalogue.
        name: "the UNIVERSAL family has no active pack",
        level: "FAIL",
        detail: "Nothing sits below universal, so every unauthored trade would resolve and then have nothing to ask.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM profiling_family_binding b
          JOIN profiling_family f ON f.family_id = b.family_id
          WHERE b.is_universal
            AND NOT EXISTS (SELECT 1 FROM question_pack p WHERE p.family_id = f.family_id AND p.status = 'active')`),
      },
      {
        name: "families with a binding but no active pack (fallback to universal)",
        level: "WARN",
        detail:
          "These resolve to the universal pack — degraded, not dead. Expected while pack " +
          "authoring is in progress; Phase 6 closes it.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM profiling_family f
          WHERE f.status = 'active'
            AND EXISTS (SELECT 1 FROM profiling_family_binding b WHERE b.family_id = f.family_id AND NOT b.is_universal)
            AND NOT EXISTS (SELECT 1 FROM question_pack p WHERE p.family_id = f.family_id AND p.status = 'active')`),
      },
      {
        name: "universal bindings (must be exactly 1)",
        level: "FAIL",
        detail: "Zero leaves unauthored trades with no pack; two make the last fallback ambiguous.",
        count: Math.abs(
          (await one(dsql`SELECT count(*)::int AS n FROM profiling_family_binding WHERE is_universal`)) - 1,
        ),
      },
      {
        name: "bindings whose ISCO unit is not in the catalogue",
        level: "FAIL",
        detail: "The binding can never match an occupation, so the family is unreachable.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM profiling_family_binding b
          WHERE b.isco_unit_code IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM job_domain d WHERE d.isco_unit_code = b.isco_unit_code)`),
      },
      {
        name: "bindings whose job_domain_id is not in the catalogue",
        level: "FAIL",
        detail: "A renamed or retired occupation leaves the binding pointing at nothing.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM profiling_family_binding b
          WHERE b.job_domain_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM job_domain d WHERE d.job_domain_id = b.job_domain_id)`),
      },
      {
        name: "packs with zero items",
        level: "FAIL",
        detail: "An empty pack resolves successfully and then has nothing to ask.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM question_pack p
          WHERE NOT EXISTS (SELECT 1 FROM question_pack_item i WHERE i.pack_id = p.pack_id AND i.pack_version = p.version)`),
      },
      {
        name: "select questions with fewer than 2 options",
        level: "FAIL",
        detail: "A choice with one option is not a choice; the worker has nothing to pick between.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM question_pack_item i
          WHERE i.answer_type IN ('single_select','multi_select')
            AND (SELECT count(*) FROM question_pack_option o WHERE o.item_id = i.item_id) < 2`),
      },
      {
        name: "follow-ups whose parent is not in the same pack",
        level: "FAIL",
        detail: "The parent reference dangles, so the follow-up's ask accounting is wrong.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM question_pack_item i
          WHERE i.parent_item_key IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM question_pack_item p
              WHERE p.pack_id = i.pack_id AND p.pack_version = i.pack_version AND p.question_key = i.parent_item_key)`),
      },
      {
        name: "questions targeting a skill that does not exist",
        level: "FAIL",
        detail: "The answer would be written against a dangling skill id and never match.",
        count: await one(dsql`
          SELECT count(*)::int AS n FROM question_pack_item i
          WHERE i.target_skill_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM skill s WHERE s.skill_id = i.target_skill_id)`),
      },
      {
        name: "blue-collar unit groups with no family (coverage)",
        level: "WARN",
        detail:
          "These resolve to the universal pack, which works but asks nothing trade-specific. " +
          "Expected while pack authoring is in progress — Phase 6 closes it.",
        count: await one(dsql`
          SELECT count(DISTINCT d.isco_unit_code)::int AS n FROM job_domain d
          WHERE d.selectable AND d.status = 'active'
            AND d.isco_major_code IN ('5','6','7','8','9')
            AND d.isco_unit_code IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM profiling_family_binding b WHERE b.isco_unit_code = d.isco_unit_code)`),
      },
      {
        name: "families with no label_hi",
        level: "WARN",
        detail: "The worker-facing confirmation falls back to label_en, which is often unusable prose.",
        count: await one(dsql`SELECT count(*)::int AS n FROM profiling_family WHERE label_hi IS NULL`),
      },
    ];

    const failures = report(checks);
    if (failures > 0) {
      console.error(`[${SCRIPT}] ${failures} check(s) FAILED.`);
      process.exit(1);
    }
    console.log(`[${SCRIPT}] all structural checks passed.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Guarded so importing this module for its helpers does not run the gate — the footgun
// that took verify-job-domains.ts down in CI.
if (process.argv[1] && /verify-question-packs/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  });
}
