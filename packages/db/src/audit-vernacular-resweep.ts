/**
 * §5a — the full vernacular collision re-sweep. READ-ONLY, **zero AI spend**.
 *
 * ===========================================================================
 * WHAT WENT STALE
 * ===========================================================================
 * `config.py` pins the floor at 0.75 on a three-part calibration:
 *
 *     labeled-domain negative ceiling   0.598
 *     sibling-confusion ceiling         0.722
 *     ANCHOR-path negative ceiling      0.7263
 *     -> "0.75 clears all three"
 *
 * All three were measured on **2026-07-14**. The 22 ratified vernacular aliases shipped on
 * **2026-07-16**, adding rows to the very pools those ceilings summarise. The same comment
 * instructs a re-sweep "on any corpus/model change"; the corpus changed two days later and the
 * sweep was never re-run. So the floor's safety argument has been resting on a measurement
 * taken before the thing it is supposed to account for existed.
 *
 * `audit-anchor-path-retrieval.ts` re-measured ONE of the three, over ONE probe set — the 22
 * wedge aliases. This measures all three, over EVERY embedded alias in the corpus.
 *
 * ===========================================================================
 * WHY THIS COSTS NOTHING
 * ===========================================================================
 * Every probe and every candidate is an alias row that ALREADY has a stored vector, and they
 * are all from one model (asserted below — a mixed space would make cosine meaningless). No
 * text needs embedding, so there is nothing to pay for.
 *
 * **THE HONEST LIMIT OF THAT.** Using an alias's own vector as the query is the most
 * favourable possible input for retrieving its own skill, so a MISS is definitive. But it also
 * means the negative ceilings measured here are ceilings **over the phrases the corpus
 * happens to contain**. A real worker's paraphrase is not in this set and could score higher
 * against a wrong skill. So each ceiling below is a LOWER BOUND on the true ceiling: the risk
 * is at least this large, never smaller. That asymmetry is why a clear result here is
 * reassuring and a bad one is damning.
 *
 * ===========================================================================
 * THE THREE SURFACES
 * ===========================================================================
 *   ANCHOR PATH      every alias queried against the `cnc-machining` pool — the scope both
 *                    live call sites actually use. A wrong top-1 here is a real misassignment.
 *   LABELED DOMAIN   every alias queried against its OWN slug — what per-label resolution
 *                    (TAX-6) would give us. The counterfactual.
 *   SIBLING          within the correct scope, how close the nearest WRONG skill gets. This is
 *                    the one that survives fixing the scoping, so it bounds what a domain fix
 *                    can achieve.
 *
 * This instrument measures. It proposes no remediation and changes nothing.
 *
 *   pnpm db:audit:vernacular-resweep [--anchor=<slug>] [--json=<out>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:vernacular-resweep";

/** The slug both live call sites default to (`job-postings.service.ts`, `config.py`). */
const ANCHOR = "cnc-machining";

/** `skill_canonicalize_floor`. Read for reporting; this audit never proposes changing it. */
const FLOOR = 0.75;

/** The 2026-07-14 calibration recorded in `config.py`, for comparison only. */
const RECORDED_2026_07_14 = {
  labeled_domain_negative_ceiling: 0.598,
  sibling_confusion_ceiling: 0.722,
  anchor_path_negative_ceiling: 0.7263,
} as const;

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

interface Row {
  text: string;
  want: string;
  home: string;
  got: string;
  via: string;
  score: string;
}

const num = (r: Row): number => Number(r.score);
const ceilingOf = (rows: readonly Row[]): number =>
  rows.length === 0 ? 0 : Math.max(...rows.map(num));

/**
 * Is this "collision" just the SAME PHRASE stored twice on two skills?
 *
 * TD-01 merged `skill_gdt_reading` + `skill_cad_interpretation` into `skill_drawing_reading`
 * by COPYING their alias texts onto the successor without removing the originals, so the
 * corpus now holds `"GD&T"`, `"blueprint reading"`, `"CAD"` and others on two skills each,
 * with byte-identical vectors. Every such pair scores exactly 1.0000 against itself and the
 * winner is decided by whatever order the index returns.
 *
 * Folding those into the negative ceiling would report **1.0000** and drown the finding this
 * sweep exists for. They are a real defect — a nondeterministic assignment between a live
 * skill and a corpus-deprecated one — but they are MERGE RESIDUE, not semantic confusion
 * between different phrases, and the two need different remedies. So they are counted and
 * reported separately, and the headline ceilings are the semantic ones.
 */
const isDuplicateText = (r: Row): boolean =>
  r.text.trim().toLowerCase() === r.via.trim().toLowerCase();

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const anchor = arg("anchor") ?? ANCHOR;

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

    // FAIL CLOSED on a mixed embedding space. Cosine distances across two models are not
    // comparable, and every number below would be quietly meaningless.
    const models = (await db.execute(dsql`
      SELECT DISTINCT embedding_model FROM skill_alias WHERE embedding IS NOT NULL
    `)) as unknown as { embedding_model: string }[];
    if (models.length !== 1) {
      throw new Error(
        `[${SCRIPT}] ${models.length} embedding models present (${models
          .map((m) => m.embedding_model)
          .join(", ")}). Cosine across models is not comparable; refusing to report ceilings.`,
      );
    }
    const model = models[0]?.embedding_model ?? "(unknown)";

    // ── Surface 1: the ANCHOR path — the scope production actually queries ──
    const anchorTop = (await db.execute(dsql`
      WITH probe AS (
        SELECT sa.id, sa.text, sa.skill_id, sa.domain_id, sa.embedding
        FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
        WHERE s.status = 'active' AND sa.embedding IS NOT NULL
      ), scored AS (
        SELECT p.text, p.skill_id AS want, p.domain_id AS home,
               c.skill_id AS got, c.text AS via,
               1 - (c.embedding <=> p.embedding) AS score,
               row_number() OVER (PARTITION BY p.id ORDER BY c.embedding <=> p.embedding) AS rn
        FROM probe p
        JOIN skill_alias c ON c.domain_id = ${anchor} AND c.embedding IS NOT NULL
        JOIN skill cs ON cs.skill_id = c.skill_id AND cs.status = 'active'
      )
      SELECT text, want, home, got, via, score::text FROM scored WHERE rn = 1
    `)) as unknown as Row[];

    // ── Surface 2: the LABELED domain — what per-label resolution would give ──
    const labeledTop = (await db.execute(dsql`
      WITH probe AS (
        SELECT sa.id, sa.text, sa.skill_id, sa.domain_id, sa.embedding
        FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
        WHERE s.status = 'active' AND sa.embedding IS NOT NULL
      ), scored AS (
        SELECT p.text, p.skill_id AS want, p.domain_id AS home,
               c.skill_id AS got, c.text AS via,
               1 - (c.embedding <=> p.embedding) AS score,
               row_number() OVER (PARTITION BY p.id ORDER BY c.embedding <=> p.embedding) AS rn
        FROM probe p
        JOIN skill_alias c ON c.domain_id = p.domain_id AND c.embedding IS NOT NULL
        JOIN skill cs ON cs.skill_id = c.skill_id AND cs.status = 'active'
      )
      SELECT text, want, home, got, via, score::text FROM scored WHERE rn = 1
    `)) as unknown as Row[];

    // ── Surface 3: SIBLING confusion — nearest WRONG skill inside the right scope ──
    const siblingTop = (await db.execute(dsql`
      WITH probe AS (
        SELECT sa.id, sa.text, sa.skill_id, sa.domain_id, sa.embedding
        FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
        WHERE s.status = 'active' AND sa.embedding IS NOT NULL
      ), scored AS (
        SELECT p.text, p.skill_id AS want, p.domain_id AS home,
               c.skill_id AS got, c.text AS via,
               1 - (c.embedding <=> p.embedding) AS score,
               row_number() OVER (PARTITION BY p.id ORDER BY c.embedding <=> p.embedding) AS rn
        FROM probe p
        JOIN skill_alias c ON c.domain_id = p.domain_id AND c.embedding IS NOT NULL
        JOIN skill cs ON cs.skill_id = c.skill_id AND cs.status = 'active'
        WHERE c.skill_id <> p.skill_id
      )
      SELECT text, want, home, got, via, score::text FROM scored WHERE rn = 1
    `)) as unknown as Row[];

    const anchorWrong = anchorTop.filter((r) => r.got !== r.want);
    const labeledWrong = labeledTop.filter((r) => r.got !== r.want);

    // Split every surface into merge residue and genuine semantic confusion. The headline
    // ceilings are the semantic ones; the duplicates are reported alongside, never folded in.
    const anchorDup = anchorWrong.filter(isDuplicateText);
    const anchorSem = anchorWrong.filter((r) => !isDuplicateText(r));
    const labeledDup = labeledWrong.filter(isDuplicateText);
    const labeledSem = labeledWrong.filter((r) => !isDuplicateText(r));
    const siblingDup = siblingTop.filter(isDuplicateText);
    const siblingSem = siblingTop.filter((r) => !isDuplicateText(r));

    const anchorDanger = anchorSem.filter((r) => num(r) >= FLOOR);
    const labeledDanger = labeledSem.filter((r) => num(r) >= FLOOR);
    const siblingDanger = siblingSem.filter((r) => num(r) >= FLOOR);

    const measured = {
      anchor_path_negative_ceiling: ceilingOf(anchorSem),
      labeled_domain_negative_ceiling: ceilingOf(labeledSem),
      sibling_confusion_ceiling: ceilingOf(siblingSem),
    };
    const duplicateResidue = {
      anchor_path: anchorDup.length,
      labeled_domain: labeledDup.length,
      sibling: siblingDup.length,
      ceiling: ceilingOf([...anchorDup, ...labeledDup, ...siblingDup]),
      distinct_phrases: [
        ...new Set(anchorDup.concat(labeledDup, siblingDup).map((r) => r.text)),
      ].sort(),
    };

    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND — every query vector is already stored.`);
    console.log(`  target                 = ${hostClass(url)}   role=${who?.who}`);
    console.log(`  embedding model        = ${model} (single — cosine is comparable)`);
    console.log(`  probes                 = ${anchorTop.length} embedded aliases on active skills`);
    console.log(`  anchor scope           = ${anchor}`);
    console.log(`  floor                  = ${FLOOR}\n`);

    const line = (label: string, now: number, then: number): void => {
      const delta = now - then;
      const verdict = now >= FLOOR ? "  *** BREACHES THE FLOOR ***" : "";
      console.log(
        `  ${label.padEnd(34)} ${then.toFixed(4)}  ->  ${now.toFixed(4)}   ` +
          `(${delta >= 0 ? "+" : ""}${delta.toFixed(4)})${verdict}`,
      );
    };
    console.log("  --- the 2026-07-14 calibration, re-measured ---");
    console.log(`  ${"".padEnd(34)} 2026-07-14      now`);
    line("labeled-domain negative ceiling", measured.labeled_domain_negative_ceiling, RECORDED_2026_07_14.labeled_domain_negative_ceiling);
    line("sibling-confusion ceiling", measured.sibling_confusion_ceiling, RECORDED_2026_07_14.sibling_confusion_ceiling);
    line("ANCHOR-path negative ceiling", measured.anchor_path_negative_ceiling, RECORDED_2026_07_14.anchor_path_negative_ceiling);

    console.log(`\n  --- misassignments AT OR ABOVE the ${FLOOR} floor ---`);
    console.log(`  anchor path      ${String(anchorDanger.length).padStart(4)} of ${anchorTop.length}   <- would be ASSIGNED today`);
    console.log(`  labeled domain   ${String(labeledDanger.length).padStart(4)} of ${labeledTop.length}   <- would survive a scoping fix`);
    console.log(`  sibling (any)    ${String(siblingDanger.length).padStart(4)} of ${siblingTop.length}   <- wrong skill within the RIGHT scope`);

    console.log(`
  --- merge residue, reported separately ---`);
    console.log(
      `  ${duplicateResidue.distinct_phrases.length} phrase(s) exist on TWO skills with identical ` +
        `vectors, scoring ${duplicateResidue.ceiling.toFixed(4)}:
    ` +
        duplicateResidue.distinct_phrases.join(", ") +
        `
  TD-01 copied these onto skill_drawing_reading without removing the originals, so the
` +
        `  winner is decided by index order and the assignment is NONDETERMINISTIC between a live
` +
        `  skill and a corpus-deprecated one. A real defect, but not semantic confusion — excluded
` +
        `  from the ceilings above; it needs the D-7C alias cleanup, not a scoping fix.`,
    );

    if (anchorDanger.length > 0) {
      console.log(`\n  --- every above-floor SEMANTIC anchor-path collision ---`);
      for (const r of [...anchorDanger].sort((a, b) => num(b) - num(a))) {
        console.log(
          `    ${r.text.padEnd(26)} [${r.home.padEnd(18)}] want ${r.want.padEnd(30)} ` +
            `got ${r.got.padEnd(28)} ${num(r).toFixed(4)} via "${r.via}"`,
        );
      }
    }

    // THE ONE A SCOPING FIX CANNOT REACH. Sibling confusion happens INSIDE the correct domain,
    // so per-label resolution (TAX-6) leaves it exactly where it is. Printed in full because
    // it decides whether re-domaining is sufficient or merely necessary.
    if (siblingDanger.length > 0) {
      console.log(
        `
  --- above-floor SIBLING confusion, inside the CORRECT scope (${siblingDanger.length}) ---
` +
          `  NOT live misassignments: each probe's OWN alias still wins at 1.0000, and the sibling
` +
          `  below is the RUNNER-UP. What the number measures is MARGIN — and what has been lost
` +
          `  is the floor's ability to REJECT that sibling if a real paraphrase ever reorders the
` +
          `  two. The 2026-07-14 calibration set ${FLOOR} deliberately above the worst sibling
` +
          `  (0.722) so a sibling could never be assigned; at ${'${'}measured.sibling_confusion_ceiling.toFixed(4)${'}'} it no longer can.
` +
          `  These also survive any scoping fix — they are already inside the right domain.`,
      );
      for (const r of [...siblingDanger].sort((a, b) => num(b) - num(a))) {
        console.log(
          `    ${r.text.padEnd(30)} [${r.home.padEnd(18)}] own ${r.want.padEnd(30)} ` +
            `sibling ${r.got.padEnd(28)} ${num(r).toFixed(4)} via "${r.via}"`,
        );
      }
    }

    const out = arg("json");
    if (out !== undefined) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "vernacular-collision-resweep",
            ...provenance({
              source: `pnpm db:audit:vernacular-resweep --anchor=${anchor}`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `every skill_alias row with a non-null embedding whose skill is active ` +
                `(${anchorTop.length} probes), scored against the same population in three ` +
                `scopes: the ${anchor} anchor pool, each probe's own domain_id, and each ` +
                `probe's own domain_id excluding its own skill`,
            }),
            embedding_model: model,
            ai_spend_inr: 0,
            zero_spend_reason:
              "Every probe and candidate vector was already stored; no text was embedded.",
            measurement_caveat:
              "Query vectors are the aliases' own stored embeddings. That is the most " +
              "favourable input for retrieving the alias's OWN skill, so a miss is definitive. " +
              "It also means these negative ceilings are ceilings over the phrases the corpus " +
              "contains — a worker paraphrase outside the corpus could score higher against a " +
              "wrong skill. Each ceiling is therefore a LOWER BOUND on the true ceiling.",
            floor: FLOOR,
            anchor_scope: anchor,
            probes: anchorTop.length,
            recorded_2026_07_14: RECORDED_2026_07_14,
            measured,
            sibling_collisions_above_floor: siblingDanger
              .map((r) => ({
                phrase: r.text,
                domain: r.home,
                own_skill: r.want,
                sibling_skill: r.got,
                via: r.via,
                score: Number(num(r).toFixed(4)),
              }))
              .sort((a, b) => b.score - a.score),
            sibling_note:
              "These are RUNNER-UPS, not current misassignments: each probe's own alias wins at " +
              "1.0. The figure measures margin. The 2026-07-14 calibration placed the floor above " +
              "the worst sibling (0.722) so a sibling could never be assigned; that property is " +
              "now gone, and it is not recoverable by fixing domain scoping because these " +
              "collisions are already inside the correct domain.",
            labeled_domain_ceiling_is_vacuous:
              "0.0000 because a probe scoped to its OWN domain always matches its own alias at " +
              "1.0, so there is never a wrong top-1. The meaningful number for the correctly " +
              "scoped case is the SIBLING ceiling, not this one.",
            duplicate_text_residue: duplicateResidue,
            floor_clears_all_three:
              measured.anchor_path_negative_ceiling < FLOOR &&
              measured.labeled_domain_negative_ceiling < FLOOR &&
              measured.sibling_confusion_ceiling < FLOOR,
            above_floor_counts: {
              anchor_path: anchorDanger.length,
              labeled_domain: labeledDanger.length,
              sibling: siblingDanger.length,
            },
            anchor_path_collisions_above_floor: anchorDanger
              .map((r) => ({
                phrase: r.text,
                home_domain: r.home,
                wanted: r.want,
                got: r.got,
                via: r.via,
                score: Number(num(r).toFixed(4)),
              }))
              .sort((a, b) => b.score - a.score),
            labeled_domain_collisions_above_floor: labeledDanger.map((r) => ({
              phrase: r.text,
              home_domain: r.home,
              wanted: r.want,
              got: r.got,
              via: r.via,
              score: Number(num(r).toFixed(4)),
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
