/**
 * D-7C-1 — what the duplicate-text cleanup would actually change. READ-ONLY, **zero AI spend**.
 *
 * ===========================================================================
 * THE QUESTION
 * ===========================================================================
 * §5a found eight phrases stored on two skills each with identical vectors, and recommended a
 * cleanup. "Recommended a cleanup" is not evidence that the cleanup helps. Three things were
 * unmeasured:
 *
 *   1. **Which rows are involved** — §5a reported eight PHRASES from the probe side. The row
 *      side is what a runner writes, and it is not the same population: a duplicate whose
 *      second holder is PROVISIONAL never appears as a live collision, so it never appeared
 *      in the sweep, and it becomes one the moment that skill is promoted.
 *   2. **What the cleanup costs.** Removing a row removes it from its LEGACY SLUG, and the
 *      surviving copy may live in a different slug. The phrase survives globally and vanishes
 *      from the scope a caller queries.
 *   3. **Whether it fixes the collision it is credited with.** `dimensional inspection` →
 *      `skill_drawing_reading` @ 0.7570 is attributed to this defect. That is a hypothesis
 *      about WHICH alias wins, and it is checkable.
 *
 * ===========================================================================
 * HOW IT ANSWERS THEM WITHOUT WRITING ANYTHING
 * ===========================================================================
 * The de-election write is `UPDATE skill_alias SET embedding = NULL WHERE id = $1`, and every
 * retrieval predicate in the system filters `embedding IS NOT NULL`. So the post-write corpus
 * is exactly the pre-write corpus minus those ids — which a `WHERE id <> ALL(...)` reproduces
 * perfectly, in a read-only session, over vectors that already exist. **Zero spend, and it is
 * a simulation of the real write rather than a model of it.**
 *
 * Three scenarios are measured: today, the four ratified-and-unapplied elections, and those
 * plus the four proposed ones. The middle one is separate because an authorised write that is
 * merely owed must not be reported together with one that is not authorised at all.
 *
 * ===========================================================================
 * WHAT IT WILL NOT DO
 * ===========================================================================
 * No write path exists in this file. `--plan` prints the statements a runner WOULD issue; the
 * runner that issues them is `db:decollide:aliases`, which has its own two-signal ops guard.
 * This audit does not elect winners either — it measures the elections it is handed.
 *
 *   pnpm db:audit:alias-cleanup [--plan] [--json=<out>] [--anchor=<slug>]
 */
import { writeFileSync } from "node:fs";

import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import {
  ALIAS_EXCLUSIONS_PATH,
  loadAliasExclusions,
  type AliasExclusion,
} from "./alias-exclusions";
import {
  buildScenarios,
  classifyDuplicateGroup,
  isLive,
  loadCleanupProposal,
  orphanedPhrases,
  PROPOSED_CLEANUP_PATH,
  scopeOrphanedPhrases,
  unresolvedGroups,
  type DuplicateGroup,
  type DuplicateMember,
  type Scenario,
} from "./alias-cleanup-plan";
import { createDbClient } from "./client";
import { D7C_NEUTRAL_SUBJECTS } from "./deprecation-hop0";
import { provenance } from "./evidence-provenance";
import { hostClass } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "audit:alias-cleanup";
const ANCHOR = "cnc-machining";
const FLOOR = 0.75;

/**
 * The collisions this cleanup is credited with fixing. Traced explicitly in every scenario,
 * because "the ceiling went down" does not establish that a NAMED defect was the thing fixed.
 */
const TRACED_PHRASES = ["dimensional inspection", "welding ka kaam", "fitting ka kaam"] as const;

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

/** Same rule §5a uses, so the two instruments partition the surface identically. */
const isDuplicateText = (r: Row): boolean =>
  r.text.trim().toLowerCase() === r.via.trim().toLowerCase();

/**
 * `id <> ALL(ARRAY[...]::uuid[])` for the excluded set.
 *
 * Not `NOT IN ()`: an empty tuple is a syntax error, so the empty scenario — the baseline, the
 * one every delta is measured against — would be the case that fails. An empty ARRAY is valid
 * and means "exclude nothing", which is exactly what S0 is.
 */
/** `IN (…)` from a JS array — a drizzle array interpolates as a tuple, and `ANY(tuple)` is a syntax error. */
const inList = (xs: readonly string[]) =>
  dsql`(${dsql.join(
    xs.map((x) => dsql`${x}`),
    dsql`, `,
  )})`;

const notExcluded = (col: string, ids: readonly string[]) =>
  ids.length === 0
    ? dsql.raw("TRUE")
    : dsql`${dsql.raw(col)} <> ALL(ARRAY[${dsql.join(
        ids.map((i) => dsql`${i}`),
        dsql`, `,
      )}]::uuid[])`;

interface SurfaceResult {
  readonly rows: readonly Row[];
  readonly semanticCeiling: number;
  readonly aboveFloor: readonly Row[];
  readonly duplicates: readonly Row[];
}

type Db = ReturnType<typeof createDbClient>["db"];

/**
 * Score every remaining probe against a candidate pool, with the excluded ids absent from both.
 *
 * `scope` selects the surface: the fixed anchor slug production queries, or each probe's own
 * slug. `excludeOwnSkill` turns the same query into the sibling measurement.
 */
async function surface(
  db: Db,
  excluded: readonly string[],
  scope: "anchor" | "labeled",
  anchor: string,
  excludeOwnSkill: boolean,
): Promise<SurfaceResult> {
  const candidateScope =
    scope === "anchor" ? dsql`c.domain_id = ${anchor}` : dsql`c.domain_id = p.domain_id`;
  const ownSkill = excludeOwnSkill ? dsql`AND c.skill_id <> p.skill_id` : dsql``;

  const rows = (await db.execute(dsql`
    WITH probe AS (
      SELECT sa.id, sa.text, sa.skill_id, sa.domain_id, sa.embedding
      FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
      WHERE s.status = 'active' AND sa.embedding IS NOT NULL AND ${notExcluded("sa.id", excluded)}
    ), scored AS (
      SELECT p.text, p.skill_id AS want, p.domain_id AS home,
             c.skill_id AS got, c.text AS via,
             1 - (c.embedding <=> p.embedding) AS score,
             row_number() OVER (PARTITION BY p.id ORDER BY c.embedding <=> p.embedding) AS rn
      FROM probe p
      JOIN skill_alias c ON ${candidateScope} AND c.embedding IS NOT NULL
        AND ${notExcluded("c.id", excluded)}
      JOIN skill cs ON cs.skill_id = c.skill_id AND cs.status = 'active'
      WHERE TRUE ${ownSkill}
    )
    SELECT text, want, home, got, via, score::text FROM scored WHERE rn = 1
  `)) as unknown as Row[];

  const wrong = excludeOwnSkill ? rows : rows.filter((r) => r.got !== r.want);
  const duplicates = wrong.filter(isDuplicateText);
  const semantic = wrong.filter((r) => !isDuplicateText(r));
  return {
    rows,
    semanticCeiling: ceilingOf(semantic),
    aboveFloor: semantic.filter((r) => num(r) >= FLOOR),
    duplicates,
  };
}

interface Collision {
  readonly phrase: string;
  readonly home: string;
  readonly own_skill: string;
  readonly other_skill: string;
  readonly via: string;
  readonly score: number;
}

/** Sorted highest-first, because the ceiling IS the first row and the reader wants it there. */
const collisions = (rows: readonly Row[]): Collision[] =>
  rows
    .map((r) => ({
      phrase: r.text,
      home: r.home,
      own_skill: r.want,
      other_skill: r.got,
      via: r.via,
      score: Number(num(r).toFixed(4)),
    }))
    .sort((a, b) => b.score - a.score);

interface ScenarioMeasurement {
  readonly id: string;
  readonly label: string;
  readonly excluded_alias_ids: readonly string[];
  readonly probes: number;
  readonly ceilings: Record<string, number>;
  readonly above_floor: Record<string, number>;
  readonly duplicate_residue_rows: number;
  readonly duplicate_residue_phrases: readonly string[];
  readonly anchor_above_floor: readonly Collision[];
  readonly sibling_above_floor: readonly Collision[];
  readonly traced: readonly {
    phrase: string;
    scope: string;
    got: string;
    via: string;
    score: number;
    verdict: string;
  }[];
}

async function measureScenario(
  db: Db,
  s: Scenario,
  anchor: string,
): Promise<ScenarioMeasurement> {
  const a = await surface(db, s.excluded, "anchor", anchor, false);
  const l = await surface(db, s.excluded, "labeled", anchor, false);
  const sib = await surface(db, s.excluded, "labeled", anchor, true);

  const dupRows = [...a.duplicates, ...l.duplicates, ...sib.duplicates];
  const traced = TRACED_PHRASES.flatMap((phrase) => {
    const hit = a.rows.find((r) => r.text === phrase);
    if (hit === undefined) return [];
    return [
      {
        phrase,
        scope: `anchor:${anchor}`,
        got: hit.got,
        via: hit.via,
        score: Number(num(hit).toFixed(4)),
        verdict:
          hit.got === hit.want
            ? "CORRECT"
            : num(hit) >= FLOOR
              ? "MISASSIGNED ABOVE FLOOR"
              : "wrong but below floor (unresolved, not misassigned)",
      },
    ];
  });

  return {
    id: s.id,
    label: s.label,
    excluded_alias_ids: s.excluded,
    probes: a.rows.length,
    ceilings: {
      anchor_path_negative: a.semanticCeiling,
      labeled_domain_negative: l.semanticCeiling,
      sibling_confusion: sib.semanticCeiling,
    },
    above_floor: {
      anchor_path: a.aboveFloor.length,
      labeled_domain: l.aboveFloor.length,
      sibling: sib.aboveFloor.length,
    },
    duplicate_residue_rows: dupRows.length,
    duplicate_residue_phrases: [...new Set(dupRows.map((r) => r.text))].sort(),
    anchor_above_floor: collisions(a.aboveFloor),
    sibling_above_floor: collisions(sib.aboveFloor),
    traced,
  };
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
  const anchor = arg("anchor") ?? ANCHOR;
  const showPlan = process.argv.includes("--plan");

  const ratified = loadAliasExclusions();
  const proposed = loadCleanupProposal();

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
      throw new Error(
        `[${SCRIPT}] ${models.length} embedding models present; cosine is not comparable.`,
      );
    }

    console.log(`[${SCRIPT}] READ-ONLY, ZERO SPEND — the write is simulated by omitting rows.`);
    console.log(`  target = ${hostClass(url)}  role=${who?.who}  bypassrls=${who?.bypass_rls}`);
    console.log(`  ratified elections = ${ratified.length} (${ALIAS_EXCLUSIONS_PATH})`);
    console.log(`  proposed elections = ${proposed.length} (${PROPOSED_CLEANUP_PATH})\n`);

    // ── 1. every duplicate-text group, from the ROW side ──
    const raw = (await db.execute(dsql`
      SELECT sa.id AS alias_id, sa.skill_id, sa.text, sa.domain_id,
             (sa.embedding IS NOT NULL) AS embedded, s.status AS skill_status,
             lower(btrim(sa.text)) AS norm
      FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
      WHERE lower(btrim(sa.text)) IN (
        SELECT lower(btrim(x.text)) FROM skill_alias x
        GROUP BY 1 HAVING count(DISTINCT x.skill_id) > 1
      )
      ORDER BY norm, sa.skill_id
    `)) as unknown as (DuplicateMember & { norm: string })[];

    const byNorm = new Map<string, DuplicateMember[]>();
    for (const r of raw) {
      byNorm.set(r.norm, [...(byNorm.get(r.norm) ?? []), r]);
    }
    const groups: DuplicateGroup[] = [...byNorm.entries()]
      .map(([norm, members]) => ({ norm, members }))
      .sort((a, b) => a.norm.localeCompare(b.norm));

    const ratifiedIds = new Set(ratified.map((x) => x.alias_id));
    const allIds = new Set([...ratifiedIds, ...proposed.map((x) => x.alias_id)]);

    // The D-7C seed removes its three subjects' aliases from retrieval by the status predicate,
    // which is the same removal a de-election performs by the embedding predicate. Modelling it
    // as an exclusion is exact, not an approximation — see DEPRECATION_IS_EXCLUSION.
    const d7cAliases = (await db.execute(dsql`
      SELECT sa.id AS alias_id FROM skill_alias sa
      WHERE sa.embedding IS NOT NULL AND sa.skill_id IN ${inList(D7C_NEUTRAL_SUBJECTS)}
    `)) as unknown as { alias_id: string }[];
    const d7cIds = d7cAliases.map((r) => r.alias_id);
    const scenarios = buildScenarios(ratified, proposed, d7cIds);
    const withD7c = new Set([...allIds, ...d7cIds]);

    console.log(`  --- duplicate-text groups: ${groups.length} ---`);
    for (const g of groups) {
      const today = classifyDuplicateGroup(g, new Set());
      const after = classifyDuplicateGroup(g, allIds);
      const holders = g.members
        .map((m) => `${m.skill_id}${isLive(m) ? "" : `(${m.skill_status}${m.embedded ? "" : ",unembedded"})`}`)
        .join(" / ");
      console.log(
        `    ${g.norm.padEnd(40)} ${today.padEnd(17)} -> ${after.padEnd(17)} ${holders}`,
      );
    }

    // ── 2. the safety rules, checked against LIVE rows ──
    const orphans = orphanedPhrases(groups, allIds);
    const scopeOrphans = scopeOrphanedPhrases(groups, allIds);
    const unresolved = unresolvedGroups(groups, allIds);

    console.log(`\n  --- safety ---`);
    console.log(`    phrases orphaned globally      ${orphans.length}${orphans.length ? `  ${orphans.join(", ")}` : "   (none — every contested text keeps a holder)"}`);
    console.log(`    phrases orphaned IN A SLUG     ${scopeOrphans.length}`);
    for (const o of scopeOrphans) console.log(`      ${o}`);
    // THE FINDING THIS AUDIT EXISTS FOR. Two separately-ratified decisions, each safe alone.
    const crossOrphans = orphanedPhrases(groups, withD7c);
    const crossScopeOrphans = scopeOrphanedPhrases(groups, withD7c);
    console.log(
      `    phrases orphaned once D-7C ALSO seeds  ${crossOrphans.length}` +
        (crossOrphans.length ? `   <<< CROSS-DECISION CONFLICT` : ""),
    );
    for (const o of crossOrphans) console.log(`      ${o}`);
    console.log(`    groups still nondeterministic  ${unresolved.length}${unresolved.length ? `  ${unresolved.map((g) => g.norm).join(", ")}` : ""}`);

    // ── 3. the counterfactual sweep ──
    const measurements: ScenarioMeasurement[] = [];
    for (const s of scenarios) measurements.push(await measureScenario(db, s, anchor));

    console.log(`\n  --- three ceilings, per scenario (floor ${FLOOR}) ---`);
    console.log(
      `    ${"scenario".padEnd(28)} ${"anchor".padStart(8)} ${"labeled".padStart(8)} ` +
        `${"sibling".padStart(8)}   ${"above-floor a/l/s".padStart(18)}  dup-rows`,
    );
    for (const m of measurements) {
      console.log(
        `    ${m.id.padEnd(28)} ${m.ceilings["anchor_path_negative"]!.toFixed(4).padStart(8)} ` +
          `${m.ceilings["labeled_domain_negative"]!.toFixed(4).padStart(8)} ` +
          `${m.ceilings["sibling_confusion"]!.toFixed(4).padStart(8)}   ` +
          `${`${m.above_floor["anchor_path"]}/${m.above_floor["labeled_domain"]}/${m.above_floor["sibling"]}`.padStart(18)}  ` +
          `${String(m.duplicate_residue_rows).padStart(8)}`,
      );
    }

    const key = (c: Collision): string => `${c.phrase}|${c.own_skill}|${c.other_skill}`;
    const byId = new Map(measurements.map((m) => [m.id, m]));
    const s0 = byId.get("S0_TODAY")!;
    const s2 = byId.get("S2_RATIFIED_PLUS_PROPOSED")!;
    const s3 = byId.get("S3_PLUS_D7C_DEPRECATION")!;
    const baseSib = new Set(s0.sibling_above_floor.map(key));

    // Attribute each removal to the decision that causes it. Comparing S0 with the LAST
    // scenario would credit the cleanup with collisions that only disappear because D-7C
    // deprecates a whole skill — a different decision, with a different authorisation.
    const s2Sib = new Set(s2.sibling_above_floor.map(key));
    const s3Sib = new Set(s3.sibling_above_floor.map(key));
    const cleared = s0.sibling_above_floor.filter((c) => !s2Sib.has(key(c)));
    const clearedByD7c = s2.sibling_above_floor.filter((c) => !s3Sib.has(key(c)));
    const introduced = s3.sibling_above_floor.filter((c) => !baseSib.has(key(c)));

    const show = (title: string, cs: readonly Collision[]): void => {
      console.log(`    ${title} ${cs.length}`);
      for (const c of cs) {
        console.log(
          `      ${c.phrase.padEnd(30)} ${c.own_skill} vs ${c.other_skill} ${c.score.toFixed(4)}`,
        );
      }
    };
    console.log(
      `\n  --- the ${s0.sibling_above_floor.length} above-floor sibling collisions, ` +
        `attributed to the decision that clears them ---`,
    );
    show("cleared by the ALIAS CLEANUP    ", cleared);
    show("cleared by the D-7C SEED        ", clearedByD7c);
    show("introduced                      ", introduced);
    console.log(
      `    REMAIN after both               ${s3.sibling_above_floor.length}   ` +
        `<- what no corpus decision reaches`,
    );

    console.log(`\n  --- the named collisions, traced through every scenario ---`);
    for (const m of measurements) {
      console.log(`    ${m.id}`);
      for (const t of m.traced) {
        console.log(
          `      ${t.phrase.padEnd(24)} -> ${t.got.padEnd(28)} ${t.score.toFixed(4)} ` +
            `via "${t.via}"   ${t.verdict}`,
        );
      }
    }

    // ── 4. --plan: the exact rows a runner would touch ──
    if (showPlan) {
      console.log(`\n  --- PLAN: statements db:decollide:aliases WOULD issue ---`);
      console.log(`  (this audit has no write path; the runner has its own two-signal guard)`);
      const show = (x: AliasExclusion, source: string): void => {
        const live = raw.find((r) => r.alias_id === x.alias_id);
        const state =
          live === undefined
            ? "!! ROW NOT FOUND — a stale file; the runner refuses"
            : live.embedded
              ? "embedded -> would become NULL"
              : "already NULL — no-op";
        console.log(`    UPDATE skill_alias SET embedding = NULL WHERE id = '${x.alias_id}';`);
        console.log(
          `      ${source}  ${x.skill_id} "${x.text}" @ ${x.domain_id ?? "(null)"} ` +
            `-> winner ${x.winner_skill_id ?? "(retired)"}   [${state}]`,
        );
      };
      for (const x of ratified) show(x, "RATIFIED  ");
      for (const x of proposed) show(x, "PROPOSED  ");
      console.log(
        `\n    ${ratified.length} ratified + ${proposed.length} proposed = ` +
          `${ratified.length + proposed.length} rows. **NONE APPLIED BY THIS AUDIT.**`,
      );
    }

    const out = arg("json");
    if (out !== undefined) {
      const base = s0;
      const best = s2;
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            kind: "alias-collision-cleanup",
            decision: "D-7C-1",
            ...provenance({
              source: `pnpm db:audit:alias-cleanup --anchor=${anchor}`,
              target: hostClass(url),
              readOnly: true,
              role: who?.who ?? null,
              bypassRls: who?.bypass_rls ?? false,
              populationPredicate:
                `every skill_alias row whose lower(btrim(text)) is shared by more than one ` +
                `skill_id (${raw.length} rows in ${groups.length} groups); the counterfactual ` +
                `scores the same three surfaces as §5a with the elected ids absent from both ` +
                `probe and candidate pools`,
            }),
            embedding_model: models[0]?.embedding_model ?? null,
            ai_spend_inr: 0,
            zero_spend_reason:
              "The de-election write only NULLs embeddings, and every retrieval predicate " +
              "filters embedding IS NOT NULL. Omitting the rows from the query reproduces the " +
              "post-write corpus exactly, using vectors that already exist.",
            floor: FLOOR,
            anchor_scope: anchor,
            ratified_election_count: ratified.length,
            proposed_election_count: proposed.length,
            owner_decision: "PENDING",
            groups: groups.map((g) => ({
              norm: g.norm,
              today: classifyDuplicateGroup(g, new Set()),
              after_ratified: classifyDuplicateGroup(g, ratifiedIds),
              after_all: classifyDuplicateGroup(g, allIds),
              members: g.members.map((m) => ({
                alias_id: m.alias_id,
                skill_id: m.skill_id,
                text: m.text,
                domain_id: m.domain_id,
                embedded: m.embedded,
                skill_status: m.skill_status,
                live: isLive(m),
                elected_out: allIds.has(m.alias_id),
              })),
            })),
            orphaned_globally: orphans,
            scope_orphaned: scopeOrphans,
            d7c_subject_alias_ids: d7cIds,
            orphaned_if_d7c_also_seeds: crossOrphans,
            scope_orphaned_if_d7c_also_seeds: crossScopeOrphans,
            cross_decision_conflict:
              crossOrphans.length === 0
                ? null
                : "The 2026-08-21 elections give these phrases to skills the D-7C seed would " +
                  "deprecate. Each decision is safe alone; applied together they remove the " +
                  "phrases from retrieval entirely. ORDERING IS NOT A FIX — the end state is " +
                  "the same either way. OWNER DECISION REQUIRED.",
            unresolved_after_all: unresolved.map((g) => g.norm),
            scenarios: measurements,
            sibling_collisions_cleared_by_cleanup: cleared,
            sibling_collisions_cleared_by_d7c_seed: clearedByD7c,
            sibling_collisions_introduced: introduced,
            sibling_collisions_surviving_cleanup: s2.sibling_above_floor,
            sibling_collisions_surviving_cleanup_and_d7c: s3.sibling_above_floor,
            delta_today_to_full_cleanup: {
              anchor_path_negative:
                best.ceilings["anchor_path_negative"]! - base.ceilings["anchor_path_negative"]!,
              sibling_confusion:
                best.ceilings["sibling_confusion"]! - base.ceilings["sibling_confusion"]!,
              above_floor_anchor: best.above_floor["anchor_path"]! - base.above_floor["anchor_path"]!,
              above_floor_sibling: best.above_floor["sibling"]! - base.above_floor["sibling"]!,
              duplicate_residue_rows:
                best.duplicate_residue_rows - base.duplicate_residue_rows,
            },
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
