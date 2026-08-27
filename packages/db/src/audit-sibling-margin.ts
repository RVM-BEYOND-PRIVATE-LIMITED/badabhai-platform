/**
 * §5a-2 — measure the sibling margin. READ-ONLY, **zero AI spend**. Chooses nothing.
 *
 * ===========================================================================
 * WHY LEAVE-ONE-OUT
 * ===========================================================================
 * §5a scored each alias against a pool that still contained the alias itself, so the top-1 was
 * always the probe at 1.0000 and the "sibling" figure was a runner-up. That is the right way to
 * measure a CEILING and the wrong way to measure a DECISION: no resolution ever happens with the
 * query already in the index.
 *
 * Here each probe's own row is removed from the candidate pool and everything else stays,
 * including the probe's OTHER aliases. That is a real retrieval: "a worker said a phrase we
 * happen to know; can the rest of the corpus still find the right skill, and by how much?"
 *
 * **What it still is not.** These are corpus phrases, not worker paraphrases. The honest claim
 * is that this is the best available proxy, and it is a favourable one — a real paraphrase is
 * further from every alias than a held-out alias is.
 *
 * ===========================================================================
 * WHAT IT PRODUCES
 * ===========================================================================
 *   1. The margin distribution, split by whether the top-1 was RIGHT or WRONG. If those two
 *      distributions overlap, no separation threshold can order them apart, and option B is
 *      answered by arithmetic rather than by preference.
 *   2. A sweep of the separation parameter, always showing the TRADE: right answers lost
 *      against wrong answers rejected.
 *   3. Whether a lexical rule (option C) would even catch the pairs that motivated it.
 *
 * It changes no threshold and implements no policy. `separation` exists only inside this
 * process; nothing reads it, and `config.py` is not touched.
 *
 *   pnpm db:audit:sibling-margin [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";
import {
  classifyMargin,
  lexicalCoverage,
  separatingSeparation,
  sweepSeparation,
  type MarginObservation,
} from "./sibling-margin";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:sibling-margin";
const FLOOR = 0.75;

/** Sweep points. Fine near zero, because that is where a usable rule would have to live. */
const SEPARATIONS = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2] as const;

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface Raw {
  phrase: string;
  domain: string;
  own_skill: string;
  own_score: string | null;
  other_skill: string | null;
  other_score: string | null;
  other_via: string | null;
}

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

function quantiles(xs: readonly number[]): Record<string, number> | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return {
    n: s.length,
    min: Number(s[0]!.toFixed(4)),
    p05: Number(at(0.05).toFixed(4)),
    p50: Number(at(0.5).toFixed(4)),
    p95: Number(at(0.95).toFixed(4)),
    max: Number(s[s.length - 1]!.toFixed(4)),
  };
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
    const models = (await db.execute(dsql`
      SELECT DISTINCT embedding_model FROM skill_alias WHERE embedding IS NOT NULL
    `)) as unknown as { embedding_model: string }[];
    if (models.length !== 1) {
      throw new Error(`[${SCRIPT}] ${models.length} embedding models; cosine is not comparable`);
    }

    // LEAVE-ONE-OUT. `c.id <> p.id` removes only the probe row; the probe's other aliases stay,
    // which is what makes the own-side score a real retrieval rather than a self-match.
    const raw = (await db.execute(dsql`
      WITH probe AS (
        SELECT sa.id, sa.text, sa.skill_id, sa.domain_id, sa.embedding
        FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
        WHERE s.status = 'active' AND sa.embedding IS NOT NULL AND sa.domain_id IS NOT NULL
      ), pool AS (
        SELECT p.id AS pid, p.text AS phrase, p.skill_id AS own_skill, p.domain_id AS domain,
               c.skill_id AS cand_skill, c.text AS cand_text,
               1 - (c.embedding <=> p.embedding) AS score
        FROM probe p
        JOIN skill_alias c ON c.domain_id = p.domain_id AND c.embedding IS NOT NULL AND c.id <> p.id
        JOIN skill cs ON cs.skill_id = c.skill_id AND cs.status = 'active'
      ), own AS (
        SELECT pid, max(score) AS own_score FROM pool WHERE cand_skill = own_skill GROUP BY pid
      ), other AS (
        SELECT DISTINCT ON (pid) pid, cand_skill, cand_text, score
        FROM pool WHERE cand_skill <> own_skill ORDER BY pid, score DESC
      )
      SELECT DISTINCT ON (p.pid)
             p.phrase, p.domain, p.own_skill,
             own.own_score::text AS own_score,
             other.cand_skill AS other_skill,
             other.score::text AS other_score,
             other.cand_text AS other_via
      FROM pool p
      LEFT JOIN own ON own.pid = p.pid
      LEFT JOIN other ON other.pid = p.pid
      ORDER BY p.pid
    `)) as unknown as Raw[];

    const obs: MarginObservation[] = raw.map((r) => ({
      phrase: r.phrase,
      domain: r.domain,
      ownSkill: r.own_skill,
      ownScore: r.own_score === null ? null : Number(r.own_score),
      otherSkill: r.other_skill,
      otherScore: r.other_score === null ? null : Number(r.other_score),
      otherVia: r.other_via,
    }));

    const measurable = obs.filter((o) => o.ownScore !== null);
    const unmeasurable = obs.length - measurable.length;

    // DUPLICATE-TEXT PAIRS ARE NOT A MARGIN PROBLEM. Where the runner-up carries the SAME text
    // as the probe, the two rows hold identical vectors and score exactly 1.0000; no floor and
    // no separation can arbitrate that. They belong to the D-7C-1 cleanup, which drives them to
    // zero. Leaving them in would let the cleanup's removals read as a margin policy working.
    const isDuplicate = (o: MarginObservation): boolean =>
      o.otherVia !== null && o.otherVia.trim().toLowerCase() === o.phrase.trim().toLowerCase();
    const genuine = measurable.filter((o) => !isDuplicate(o));
    const duplicates = measurable.filter(isDuplicate);
    const base = measurable.map((o) => ({ o, v: classifyMargin(o, FLOOR, 0) }));
    const correct = base.filter((x) => x.v === "CORRECT").map((x) => x.o);
    const wrong = base.filter((x) => x.v === "WRONG").map((x) => x.o);
    const unresolved = base.filter((x) => x.v === "UNRESOLVED").map((x) => x.o);

    const marginOf = (o: MarginObservation): number =>
      Math.abs((o.ownScore ?? 0) - (o.otherScore ?? -1));
    const correctMargins = correct.map(marginOf);
    const wrongMargins = wrong.map(marginOf);

    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND. Leave-one-out over the labeled-domain scope.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}  floor = ${FLOOR}`);
    console.log(`  probes                 = ${obs.length}`);
    console.log(
      `  UNMEASURABLE           = ${unmeasurable}  (${pct(unmeasurable, obs.length)}) ` +
        `<- the skill's ONLY alias; leave-one-out leaves it unrepresented`,
    );
    console.log(`  measurable             = ${measurable.length}`);
    console.log(`    correct at floor     = ${correct.length}  (${pct(correct.length, measurable.length)})`);
    console.log(`    WRONG at floor       = ${wrong.length}  (${pct(wrong.length, measurable.length)})`);
    console.log(`    below floor          = ${unresolved.length}`);

    console.log(`\n  --- margin |own - other|, split by outcome ---`);
    console.log(`    correct  ${JSON.stringify(quantiles(correctMargins))}`);
    console.log(`    wrong    ${JSON.stringify(quantiles(wrongMargins))}`);
    const cq = quantiles(correctMargins);
    const wq = quantiles(wrongMargins);
    const overlap = cq !== null && wq !== null && cq["min"]! < wq["max"]!;
    console.log(
      `    DISTRIBUTIONS OVERLAP  = ${overlap}` +
        (overlap
          ? `   <- some RIGHT answers are closer to their runner-up (${cq?.["min"]}) than some\n` +
            `       WRONG ones are (${wq?.["max"]}), so no single separation orders them apart.`
          : `   <- a separating value exists`),
    );

    const sweep = sweepSeparation(measurable, FLOOR, [...SEPARATIONS]);
    const sweepGenuine = sweepSeparation(genuine, FLOOR, [...SEPARATIONS]);
    console.log(`\n  --- separation sweep (separation 0 IS today's policy) ---`);
    console.log(
      `    ${"δ".padStart(6)} ${"correct".padStart(8)} ${"wrong".padStart(6)} ` +
        `${"unresolved".padStart(11)} ${"right LOST".padStart(11)} ${"wrong REJECTED".padStart(15)}`,
    );
    for (const p of sweep) {
      console.log(
        `    ${p.separation.toFixed(3).padStart(6)} ${String(p.correct).padStart(8)} ` +
          `${String(p.wrong).padStart(6)} ${String(p.unresolved).padStart(11)} ` +
          `${String(p.lostCorrect).padStart(11)} ${String(p.rejectedWrong).padStart(15)}`,
      );
    }
    console.log(
      `\n  --- the same sweep with duplicate-text pairs removed (the POST-CLEANUP world) ---`,
    );
    console.log(
      `    ${"delta".padStart(6)} ${"correct".padStart(8)} ${"wrong".padStart(6)} ` +
        `${"unresolved".padStart(11)} ${"right LOST".padStart(11)} ${"wrong REJECTED".padStart(15)}`,
    );
    for (const p of sweepGenuine) {
      console.log(
        `    ${p.separation.toFixed(3).padStart(6)} ${String(p.correct).padStart(8)} ` +
          `${String(p.wrong).padStart(6)} ${String(p.unresolved).padStart(11)} ` +
          `${String(p.lostCorrect).padStart(11)} ${String(p.rejectedWrong).padStart(15)}`,
      );
    }
    const sepGenuine = separatingSeparation(genuine, FLOOR, [...SEPARATIONS]);
    console.log(`    smallest separating delta, duplicates removed = ${sepGenuine ?? "NONE in range"}`);

    const sep = separatingSeparation(measurable, FLOOR, [...SEPARATIONS]);
    console.log(
      `\n    smallest δ that leaves ZERO wrong answers = ${sep ?? "NONE in the swept range"}` +
        (sep === null
          ? `\n    A separation rule cannot eliminate the wrong answers at any swept value.`
          : `\n    …at a cost of ${sweep.find((p) => p.separation === sep)?.lostCorrect} right answers.`),
    );

    // OPTION C — would a shared-token rule find the pairs that motivated it?
    // Genuine pairs only. A duplicate-text pair trivially "shares a token" — it IS the same
    // text — so including them would report a lexical rule catching cases it never has to.
    const abovePairs = genuine
      .filter((o) => (o.otherScore ?? 0) >= FLOOR && o.otherVia !== null)
      .map((o) => ({ phrase: o.phrase, via: o.otherVia!, score: o.otherScore ?? 0 }));
    const lex = lexicalCoverage(abovePairs);
    console.log(`\n  --- option C: a shared-token rule over the ${abovePairs.length} above-floor sibling pairs ---`);
    console.log(`    caught  ${lex.caught.length}`);
    console.log(`    MISSED  ${lex.missed.length}`);
    for (const m of lex.missed.slice(0, 12)) console.log(`      ${m}`);
    console.log(
      `    the WORST pair is missed = ${lex.worstIsMissed}` +
        (lex.worstIsMissed
          ? `   <- the rule does not address the case it was proposed for`
          : ""),
    );

    const wrongGenuine = wrong.filter((o) => !isDuplicate(o));
    if (wrong.length > 0) {
      console.log(`\n  --- every leave-one-out MISASSIGNMENT above the floor ---`);
      for (const o of [...wrong].sort((a, b) => (b.otherScore ?? 0) - (a.otherScore ?? 0))) {
        console.log(
          `    ${o.phrase.padEnd(30)} [${o.domain.padEnd(18)}] want ${o.ownSkill.padEnd(28)} ` +
            `got ${(o.otherSkill ?? "").padEnd(28)} ${(o.otherScore ?? 0).toFixed(4)} ` +
            `(own ${(o.ownScore ?? 0).toFixed(4)}, margin ${marginOf(o).toFixed(4)}) via "${o.otherVia}"`,
        );
      }
    }

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "sibling-margin",
            decision: "§5a-2",
            owner_decision: "PENDING",
            ...provenance({
              source: `pnpm db:audit:sibling-margin`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `every embedded skill_alias row on an active skill with a non-null domain_id ` +
                `(${obs.length} probes), scored LEAVE-ONE-OUT against its own domain_id scope: ` +
                `the probe row is removed from the candidate pool and every other row, ` +
                `including the probe's other aliases, remains`,
            }),
            embedding_model: models[0]?.embedding_model ?? null,
            ai_spend_inr: 0,
            floor: FLOOR,
            policy_implemented: null,
            policy_note:
              "No separation rule is implemented anywhere. `separation` exists only inside this " +
              "process; no runner, service or config reads it, and config.py is untouched.",
            measurement_caveat:
              "Leave-one-out over CORPUS phrases, not worker paraphrases. A held-out alias is " +
              "closer to its own skill's remaining aliases than a real paraphrase would be, so " +
              "these margins are optimistic and the wrong-answer count is a LOWER bound.",
            probes: obs.length,
            unmeasurable_single_alias_skills: unmeasurable,
            at_floor: {
              correct: correct.length,
              wrong: wrong.length,
              unresolved: unresolved.length,
            },
            margin_distribution: { correct: quantiles(correctMargins), wrong: quantiles(wrongMargins) },
            distributions_overlap: overlap,
            duplicate_text_pairs: duplicates.length,
            duplicate_text_note:
              "Where the runner-up carries the same text as the probe, the vectors are identical " +
              "and the score is exactly 1.0000. No floor and no separation can arbitrate that; " +
              "the D-7C-1 alias cleanup drives these to zero. Swept separately so the cleanup's " +
              "removals cannot read as a margin policy working.",
            separation_sweep: sweep,
            separation_sweep_duplicates_removed: sweepGenuine,
            smallest_separating_delta: sep,
            smallest_separating_delta_duplicates_removed: sepGenuine,
            option_c_shared_token_rule: {
              pairs_considered: abovePairs.length,
              caught: lex.caught,
              missed: lex.missed,
              worst_pair_is_missed: lex.worstIsMissed,
            },
            misassignments_above_floor_count: wrong.length,
            misassignments_genuine_count: wrongGenuine.length,
            misassignments_above_floor: [...wrong]
              .sort((a, b) => (b.otherScore ?? 0) - (a.otherScore ?? 0))
              .map((o) => ({
                phrase: o.phrase,
                domain: o.domain,
                want: o.ownSkill,
                got: o.otherSkill,
                via: o.otherVia,
                own_score: Number((o.ownScore ?? 0).toFixed(4)),
                other_score: Number((o.otherScore ?? 0).toFixed(4)),
                margin: Number(marginOf(o).toFixed(4)),
                duplicate_text: isDuplicate(o),
              })),
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
