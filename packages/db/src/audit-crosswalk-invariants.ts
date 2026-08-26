/**
 * D-7 — the crosswalk surface as a MATRIX, over every subject at once. READ-ONLY, ₹0.
 *
 * ===========================================================================
 * WHY A SECOND CROSSWALK AUDIT
 * ===========================================================================
 * `audit-crosswalk-chain.ts` narrates ONE subject in five hops, and it is the right instrument
 * for deciding a case: D-7A and D-7B were both settled by reading it. What it cannot do is
 * answer "is anything else like this", because it must be pointed at a skill by name — and
 * every crosswalk defect found so far was found by someone happening to look.
 *
 * This runs the same questions over **every** crosswalk that exists in either place the
 * programme keeps one:
 *
 *   LIVE     `skill.replaced_by IS NOT NULL` — what production holds, and what `db:retag:skills`
 *            would act on today.
 *   CORPUS   `SKILL_CORPUS[].replacedBy` — what a seed WOULD write, including rows production
 *            has not got yet.
 *
 * Neither set contains the other, and the difference is the whole D-7C question. Auditing only
 * the live set would have said the corpus deprecations are not a crosswalk problem, because
 * they are not a crosswalk yet.
 *
 * ===========================================================================
 * THE FOUR THINGS IT ASKS OF EACH ROW
 * ===========================================================================
 *   WIDENING          does the successor's bridge entry imply a match claim the subject's does
 *                     not? Re-tagging then INVENTS a claim. Semantic replacement is not
 *                     matching equivalence.
 *   RETAG-ELIGIBLE    would `db:retag:skills` move stored references today?
 *   HOP-0 REACHABLE   does the subject's own phrase ALREADY land on the successor, above the
 *                     floor, without any retag? Retrieval never reads `replaced_by`; it filters
 *                     `s.status = 'active'`. When this is true, forbidding the retag runner
 *                     contains nothing — the claim is already live.
 *   HOP-0 ELSEWHERE   does the phrase land on a skill that is NOT the successor, above the
 *                     floor? That is a misassignment the crosswalk does not describe, and it is
 *                     how D-7A was found.
 *
 * ===========================================================================
 * WHAT IT IS NOT
 * ===========================================================================
 * It rules on nothing. `skill_chassis_fitting` widens, is live, and is **owner-ratified**;
 * `skill_boring` is **owner-held**. Both appear in the matrix with the same flags they always
 * had, annotated with the decision that governs them — a ruled case must keep reading as ruled,
 * not disappear because someone decided it.
 *
 *   pnpm db:audit:crosswalk-invariants [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { ATTRIBUTE_TO_MATCH_SKILLS, SKILL_CORPUS } from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import { D7C_NEUTRAL_SUBJECTS, D7C_SEED_EXCLUSIONS } from "./deprecation-hop0";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:crosswalk-invariants";
const FLOOR = 0.75;

/**
 * Decisions already taken, so a ruled row keeps reading as ruled.
 *
 * Without this the matrix says `skill_chassis_fitting WIDENING=TRUE LIVE` forever, which is
 * true and reads as an open defect. A ruling is information; dropping it loses the fact that
 * somebody looked.
 */
const RULED: Readonly<Record<string, string>> = {
  skill_chassis_fitting:
    "D-7B, RATIFIED 2026-08-26: the existing behaviour is defensible and is accepted as-is.",
  skill_boring: `D-7A, HELD: ${D7C_SEED_EXCLUSIONS["skill_boring"] ?? ""}`,
};

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface LiveRow {
  skill_id: string;
  status: string;
  replaced_by: string | null;
}

interface Hop0Row {
  subject: string;
  phrase: string;
  job_domain_id: string;
  top_skill: string;
  score: string;
}

interface Verdict {
  readonly skill_id: string;
  readonly successor: string;
  readonly source: "LIVE" | "CORPUS-ONLY";
  readonly subject_status: string;
  readonly successor_status: string | null;
  readonly bridge_subject: readonly string[] | null;
  readonly bridge_successor: readonly string[] | null;
  readonly claims_gained: readonly string[];
  readonly widening: boolean;
  readonly retag_eligible: boolean;
  readonly hop0_lands_on_successor: number;
  readonly hop0_lands_elsewhere_above_floor: readonly { phrase: string; got: string; score: number }[];
  readonly ruling: string | null;
}

const bridgeOf = (id: string): readonly string[] | null =>
  Object.prototype.hasOwnProperty.call(ATTRIBUTE_TO_MATCH_SKILLS, id)
    ? (ATTRIBUTE_TO_MATCH_SKILLS[id] ?? [])
    : null;

/**
 * The claims a re-tag would invent.
 *
 * A subject with NO bridge entry is treated as claiming nothing, which is the conservative
 * reading and the one the runtime takes: an absent key reaches nothing at match time. The
 * difference between absent and `[]` matters at review time (Q1) and not here.
 */
export function claimsGained(
  subject: readonly string[] | null,
  successor: readonly string[] | null,
): string[] {
  const have = new Set(subject ?? []);
  return (successor ?? []).filter((m) => !have.has(m)).sort();
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [ro] = (await db.execute(
      dsql`SHOW default_transaction_read_only`,
    )) as unknown as { default_transaction_read_only: string }[];
    if (ro?.default_transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] session is not read-only; refusing to measure`);
    }
    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as { who: string; bypass_rls: boolean }[];

    const live = (await db.execute(dsql`
      SELECT skill_id, status, replaced_by FROM skill
    `)) as unknown as LiveRow[];
    const byId = new Map(live.map((r) => [r.skill_id, r]));

    // BOTH crosswalk sets. The live one is what retag acts on; the corpus one is what a seed
    // would create. A row present only in the corpus is not yet a crosswalk and is exactly the
    // population D-7C is about.
    const pairs = new Map<string, { successor: string; source: "LIVE" | "CORPUS-ONLY" }>();
    for (const r of live) {
      if (r.replaced_by !== null) pairs.set(r.skill_id, { successor: r.replaced_by, source: "LIVE" });
    }
    for (const s of SKILL_CORPUS) {
      if (s.replacedBy === undefined || pairs.has(s.skillId)) continue;
      pairs.set(s.skillId, { successor: s.replacedBy, source: "CORPUS-ONLY" });
    }

    // HOP 0 for every subject at once: where does each subject's own phrase land when the
    // subject itself is excluded, in every canonical domain that carries it?
    const subjects = [...pairs.keys()];
    const hop0 = (await db.execute(dsql`
      WITH subj AS (
        SELECT a.skill_id AS subject, a.text AS phrase, a.embedding
        FROM skill_alias a
        WHERE a.embedding IS NOT NULL AND a.skill_id IN (${dsql.join(
          subjects.map((s) => dsql`${s}`),
          dsql`, `,
        )})
      ), scoped AS (
        SELECT s.subject, s.phrase, jds.job_domain_id, s.embedding
        FROM subj s
        JOIN job_domain_skill jds ON jds.skill_id = s.subject AND jds.status = 'active'
      ), scored AS (
        SELECT sc.subject, sc.phrase, sc.job_domain_id,
               cand.skill_id AS top_skill,
               1 - (sa.embedding <=> sc.embedding) AS score,
               row_number() OVER (
                 PARTITION BY sc.subject, sc.phrase, sc.job_domain_id
                 ORDER BY sa.embedding <=> sc.embedding
               ) AS rn
        FROM scoped sc
        JOIN job_domain_skill cand
          ON cand.job_domain_id = sc.job_domain_id AND cand.status = 'active'
         AND cand.skill_id <> sc.subject
        JOIN skill cs ON cs.skill_id = cand.skill_id AND cs.status = 'active'
        JOIN skill_alias sa ON sa.skill_id = cand.skill_id AND sa.embedding IS NOT NULL
      )
      SELECT subject, phrase, job_domain_id, top_skill, score::text
      FROM scored WHERE rn = 1
    `)) as unknown as Hop0Row[];

    const verdicts: Verdict[] = [];
    for (const [skillId, { successor, source }] of pairs) {
      const bs = bridgeOf(skillId);
      const bsucc = bridgeOf(successor);
      const gained = claimsGained(bs, bsucc);
      const subjRow = byId.get(skillId);
      const mine = hop0.filter((h) => h.subject === skillId && Number(h.score) >= FLOOR);
      verdicts.push({
        skill_id: skillId,
        successor,
        source,
        subject_status: subjRow?.status ?? "(absent)",
        successor_status: byId.get(successor)?.status ?? null,
        bridge_subject: bs,
        bridge_successor: bsucc,
        claims_gained: gained,
        widening: gained.length > 0,
        // The retag runner acts on the LIVE crosswalk only; a corpus row is invisible to it
        // until a seed writes the pointer.
        retag_eligible: source === "LIVE",
        hop0_lands_on_successor: mine.filter((h) => h.top_skill === successor).length,
        hop0_lands_elsewhere_above_floor: mine
          .filter((h) => h.top_skill !== successor)
          .map((h) => ({ phrase: h.phrase, got: h.top_skill, score: Number(Number(h.score).toFixed(4)) }))
          .sort((a, b) => b.score - a.score),
        ruling: RULED[skillId] ?? null,
      });
    }
    verdicts.sort((a, b) => a.skill_id.localeCompare(b.skill_id));

    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}  bypassrls=${who?.bypass_rls}`);
    console.log(`  crosswalks: ${verdicts.length}  (live ${verdicts.filter((v) => v.source === "LIVE").length}, corpus-only ${verdicts.filter((v) => v.source === "CORPUS-ONLY").length})\n`);
    console.log(
      `  ${"subject".padEnd(32)} ${"successor".padEnd(28)} ${"src".padEnd(11)} ` +
        `${"status".padEnd(11)} wide retag hop0->succ  hop0-elsewhere`,
    );
    for (const v of verdicts) {
      console.log(
        `  ${v.skill_id.padEnd(32)} ${v.successor.padEnd(28)} ${v.source.padEnd(11)} ` +
          `${v.subject_status.padEnd(11)} ${(v.widening ? "YES" : "no ").padEnd(4)} ` +
          `${(v.retag_eligible ? "YES" : "no ").padEnd(5)} ${String(v.hop0_lands_on_successor).padStart(9)}  ` +
          `${String(v.hop0_lands_elsewhere_above_floor.length).padStart(14)}` +
          (v.ruling !== null ? "   [RULED]" : ""),
      );
    }

    const widening = verdicts.filter((v) => v.widening);
    const unruledWidening = widening.filter((v) => v.ruling === null);
    const misassigning = verdicts.filter((v) => v.hop0_lands_elsewhere_above_floor.length > 0);

    console.log(`\n  --- widening crosswalks: ${widening.length} (${unruledWidening.length} unruled) ---`);
    for (const v of widening) {
      console.log(
        `    ${v.skill_id.padEnd(32)} gains ${JSON.stringify(v.claims_gained)}` +
          (v.ruling !== null ? `\n      RULED: ${v.ruling}` : `\n      *** NO RULING ON RECORD ***`),
      );
    }

    console.log(`\n  --- HOP-0 landings that are NOT the successor, above ${FLOOR} ---`);
    if (misassigning.length === 0) console.log(`    none`);
    for (const v of misassigning) {
      for (const h of v.hop0_lands_elsewhere_above_floor) {
        console.log(
          `    ${v.skill_id.padEnd(32)} "${h.phrase}" -> ${h.got.padEnd(28)} ${h.score.toFixed(4)}` +
            (h.got === v.successor ? "" : "   <- not the successor"),
        );
      }
    }

    // CONTAINMENT. Stated as a positive assertion rather than an absence, because "boring did
    // not appear" is what a filter bug also looks like.
    const boring = verdicts.find((v) => v.skill_id === "skill_boring");
    console.log(`\n  --- containment ---`);
    console.log(
      `    skill_boring present in the matrix   = ${boring !== undefined}   ` +
        `(it must be VISIBLE and INERT, not absent)`,
    );
    console.log(`    skill_boring retag-eligible          = ${boring?.retag_eligible ?? "n/a"}`);
    console.log(`    skill_boring in the D-7C seed set    = ${D7C_NEUTRAL_SUBJECTS.includes("skill_boring")}`);
    console.log(`    D-7C subjects, all corpus-only       = ${D7C_NEUTRAL_SUBJECTS.every((s) => pairs.get(s)?.source === "CORPUS-ONLY")}`);

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "crosswalk-invariants",
            ...provenance({
              source: `pnpm db:audit:crosswalk-invariants`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `every crosswalk in either set: skill.replaced_by IS NOT NULL (live) union ` +
                `SKILL_CORPUS[].replacedBy (corpus). HOP-0 scores each subject's embedded ` +
                `aliases against the active job_domain_skill scope of every domain the subject ` +
                `has an active edge in, with the subject itself excluded.`,
            }),
            ai_spend_inr: 0,
            floor: FLOOR,
            crosswalk_count: verdicts.length,
            widening_count: widening.length,
            unruled_widening_count: unruledWidening.length,
            crosswalks: verdicts,
            production_mutation_performed: false,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`\n  written to ${out}`);
    }
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
