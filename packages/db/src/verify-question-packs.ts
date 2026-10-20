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
  type PackRecord,
} from "./question-pack-corpus";
import { RFS_FIELD_IDS, RFS_FIELD_TYPES } from "./rfs-vocabulary";
import { planPackRows } from "./seed-question-packs";

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

/**
 * A `question_pack` row as the version gate compares it: the natural key, and the lifecycle
 * status the engine resolves on (`PackRepository.findActivePacks` reads `status = 'active'`).
 */
export interface PackVersionRow {
  packId: string;
  version: number;
  status: string;
}

/** A version both sides hold, whose live status is not the one the corpus says. */
export interface PackStatusDrift {
  packId: string;
  version: number;
  corpus: string;
  live: string;
}

/**
 * Every pack version the corpus holds, with the status the seeder would write for it.
 *
 * Derived through the SEEDER'S OWN `planPackRows`, deliberately — the same reason
 * `expectedCuratedAliases` reads the seed's loader. A second copy of the `status ?? "draft"`
 * default here would be free to disagree with the writer, and a verifier that disagrees with
 * the writer reports drift that is its own.
 */
export function expectedPackVersions(packs: readonly PackRecord[]): PackVersionRow[] {
  return planPackRows(packs, new Date(0)).map(({ packId, version, status }) => ({
    packId,
    version,
    status,
  }));
}

/**
 * The corpus pack versions the database does not have, and those whose status disagrees.
 *
 * ═══ THE HOLE THIS CLOSES, MEASURED ═══
 *
 * Every other live check counts rows that are WRONG; none can see a version that is ABSENT.
 * A pack release is a new version file plus the old one deprecated in place, and it reaches a
 * database only through runbook P3-0 (`db:seed:packs --apply`), which no deploy path runs. Skip
 * that step and the database keeps the previous version `active` — structurally perfect, so
 * this gate printed "all structural checks passed" while the engine served the old questions.
 *
 * Twice, not once. `qp_universal@3/@4` were absent from production on 2026-09-24, and on
 * 2026-10-20 `@7/@8` were (#2381): the owner saw the two questions those versions removed
 * still being asked on device, hours after both PRs merged, with the daily drift job green.
 *
 * STATUS IS COMPARED TOO, because half of every release is a status flip on a version the
 * database already holds. A seed that half-reached the database — or one run from a tree
 * that is not main — can leave the old version `active` with the new one present.
 */
export function packVersionDrift(
  expected: readonly PackVersionRow[],
  live: readonly PackVersionRow[],
): { missing: PackVersionRow[]; statusDrift: PackStatusDrift[] } {
  const key = (r: PackVersionRow): string => `${r.packId}@${r.version}`;
  const liveByKey = new Map(live.map((r) => [key(r), r]));
  const missing: PackVersionRow[] = [];
  const statusDrift: PackStatusDrift[] = [];
  for (const want of expected) {
    const have = liveByKey.get(key(want));
    if (!have) missing.push(want);
    else if (have.status !== want.status) {
      statusDrift.push({
        packId: want.packId,
        version: want.version,
        corpus: want.status,
        live: have.status,
      });
    }
  }
  return { missing, statusDrift };
}

const SEED_PACKS_FIX =
  "Run runbook P3-0 `pnpm db:seed:packs --apply` from a tree identical to origin/main, then re-run this gate.";

/**
 * NAMES ROWS, NOT JUST A COUNT — same rule as `curatedAliasFailureDetail`, same cap of three,
 * so a never-seeded corpus does not bury every other check in the report.
 */
function sampleOf(labels: readonly string[]): string {
  const more = labels.length > 3 ? `, +${labels.length - 3} more` : "";
  return labels.slice(0, 3).join(", ") + more;
}

/** What an operator is told when merged pack versions never reached the database. */
export function missingPackVersionDetail(missing: readonly PackVersionRow[]): string {
  return (
    "merged pack versions never reached this database, so the engine still serves the previous " +
    `active version of each. ${SEED_PACKS_FIX} ` +
    `Missing: ${sampleOf(missing.map((r) => `${r.packId}@${r.version} (${r.status})`))}`
  );
}

/** What an operator is told when a version's live status disagrees with the corpus. */
export function packStatusDriftDetail(drift: readonly PackStatusDrift[]): string {
  return (
    "the database's active/deprecated flags disagree with the corpus, so the engine resolves a " +
    `different version than main ships. ${SEED_PACKS_FIX} ` +
    `Drift: ${sampleOf(drift.map((d) => `${d.packId}@${d.version} corpus=${d.corpus} live=${d.live}`))}`
  );
}

async function main(): Promise<void> {
  const corpusOnly = process.argv.includes("--corpus");

  // ── Layer 1: the committed corpus ─────────────────────────────────────────
  const corpus = loadQuestionPackCorpus();
  const summary = summariseQuestionPackCorpus(corpus);
  console.log(`[${SCRIPT}] corpus:`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(26)} = ${v}`);

  // THE VOCABULARY IS PASSED, and that is the whole point of this line. `opts.fields` is what
  // arms the "target_field is in the Resume Field Set" rule; without it `opts.fields?.fieldIds.size`
  // is undefined and the rule silently does not run. It did not run for the entire life of this
  // gate, which is how the UNIVERSAL pack shipped with four invented field ids and no normalizer.
  //
  // `types` arms the second half of the same lesson: a chip whose value contradicts its field's
  // declared type is REFUSED at capture, so the worker taps it and nothing is recorded. Supplied
  // here for the same reason `fieldIds` is — a rule the gate does not pass a view to is a rule
  // that does not run.
  const problems = validateQuestionPackCorpus(corpus, {
    fields: { fieldIds: RFS_FIELD_IDS, types: RFS_FIELD_TYPES },
  });
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

    // COERCED, not cast: a driver handing `version` back as a string would make every version
    // "missing" and turn this gate permanently red over a type, not a seed.
    const livePacks: PackVersionRow[] = (
      (await db.execute(dsql`SELECT pack_id, version, status FROM question_pack`)) as unknown as {
        pack_id: string;
        version: number | string;
        status: string;
      }[]
    ).map((r) => ({ packId: r.pack_id, version: Number(r.version), status: r.status }));
    const versionDrift = packVersionDrift(expectedPackVersions(corpus.packs), livePacks);

    const checks: Check[] = [
      {
        name: "corpus pack versions missing from the database",
        level: "FAIL",
        detail: missingPackVersionDetail(versionDrift.missing),
        count: versionDrift.missing.length,
      },
      {
        name: "pack versions whose live status differs from the corpus",
        level: "FAIL",
        detail: packStatusDriftDetail(versionDrift.statusDrift),
        count: versionDrift.statusDrift.length,
      },
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
        detail:
          "Nothing sits below universal, so every unauthored trade would resolve and then have nothing to ask.",
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
          (await one(
            dsql`SELECT count(*)::int AS n FROM profiling_family_binding WHERE is_universal`,
          )) - 1,
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
        // COUNTS WHAT ACTUALLY HAPPENS, not what binds at one level. The first version of
        // this check asked "which unit groups have no UNIT-level binding" and so reported
        // 158 uncovered even after 59 minor-level families were added that cover every one
        // of them. A coverage number that ignores the fallback chain measures the author's
        // filing habits rather than the worker's experience.
        //
        // The real question is: does this occupation reach a pack that asks about its
        // TRADE, or does it fall all the way through to universal? So the predicate mirrors
        // RESOLVE_FAMILY_SQL and asks whether anything above specificity 0 matches.
        name: "blue-collar unit groups that fall through to the universal pack",
        level: "WARN",
        detail:
          "These get a working interview that asks nothing trade-specific. Every one is a " +
          "family worth authoring; none of them is broken.",
        count: await one(dsql`
          SELECT count(DISTINCT d.isco_unit_code)::int AS n FROM job_domain d
          WHERE d.selectable AND d.status = 'active'
            AND d.isco_major_code IN ('5','6','7','8','9')
            AND d.isco_unit_code IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM profiling_family_binding b
               WHERE (b.job_domain_id      = d.job_domain_id)
                  OR (b.isco_unit_code     = d.isco_unit_code)
                  OR (b.isco_minor_code    = left(d.isco_unit_code, 3))
                  OR (b.isco_submajor_code = left(d.isco_unit_code, 2))
                  OR (b.isco_major_code    = left(d.isco_unit_code, 1)))`),
      },
      {
        name: "families with no label_hi",
        level: "WARN",
        detail:
          "The worker-facing confirmation falls back to label_en, which is often unusable prose.",
        count: await one(
          dsql`SELECT count(*)::int AS n FROM profiling_family WHERE label_hi IS NULL`,
        ),
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
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${SCRIPT}] failed:`, err);
    process.exit(1);
  });
}
