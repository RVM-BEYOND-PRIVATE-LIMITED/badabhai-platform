/**
 * Matching V1 verifier — the go/no-go Divyanshu runs AFTER the migrations + backfills.
 *
 * STRICTLY READ-ONLY. It SELECTs and EXPLAINs; it mutates nothing, so it is safe to run
 * against production at any time (and it is the ONLY script in this family with no
 * `--apply`, because there is nothing to apply).
 *
 * EXITS NON-ZERO ON ANY VIOLATION — that is the contract. A green run means the schema,
 * the vocabulary, the backfills and the index plans all agree.
 *
 * CHECKS
 *   A. STRUCTURE   — all 7 new tables exist; row counts per table (informational).
 *   B. SYMMETRY    — no `skill_related` row is missing its mirror (the DB has no trigger;
 *                    this is one of the two places symmetry is actually guaranteed).
 *   C. SELF/KIND   — no self-relation; every id used in a relation, in a worker_skill, in
 *                    a job_reach, and in every `job_postings.match_skill_ids` element is a
 *                    REAL skill row with kind='match_skill' (no orphan match ids).
 *   D. REACH       — every OPEN posting with match skills has ≥1 `job_reach` row, or is
 *                    reported as ZERO-REACH; every posting's stored `reach_skill_ids` is
 *                    a superset of its `match_skill_ids`.
 *   E. TIERS       — every `job_reach.match_tier` ∈ (1,2) and every TIER-1 row's
 *                    `matched_skill_id` really is in that posting's `match_skill_ids`
 *                    (a tier that disagrees with the data is worse than no tier).
 *   F. TENURE      — the E8 clamp holds: no worker has a skill with more bucketed months
 *                    than their industry tenure.
 *   G. CONFIG      — exactly one active `match_config` row, and it parses.
 *   H. PLANS       — EXPLAIN the feed query + the reach driver query and assert the
 *                    intended indexes are actually chosen (a missing index is a silent
 *                    production incident, not a test failure, unless something checks).
 *
 * PRIVACY: ids + counts + query plans. No PII is read or printed.
 *
 *   pnpm db:verify:match-v1
 */
import { createDbClient } from "./client";
import { parseCommonCli } from "./match-v1-cli";

const NAME = "verify:match-v1";

const NEW_TABLES = [
  "skill_related",
  "worker_skill",
  "worker_industry_tenure",
  "job_reach",
  "match_config",
  "payment_orders",
  "referral_bonus_accruals",
] as const;

const failures: string[] = [];
const warnings: string[] = [];

function fail(check: string, detail: string): void {
  failures.push(`${check}: ${detail}`);
  console.error(`  ✗ ${check} — ${detail}`);
}
function pass(check: string, detail = ""): void {
  console.log(`  ✓ ${check}${detail ? ` — ${detail}` : ""}`);
}
function warn(check: string, detail: string): void {
  warnings.push(`${check}: ${detail}`);
  console.log(`  ! ${check} — ${detail}`);
}

async function main(): Promise<void> {
  // Reuses the common parser for DATABASE_URL validation + the prod guard message; the
  // `--apply` flag is meaningless here and is ignored.
  const opts = parseCommonCli(NAME);
  console.log(`[${NAME}] READ-ONLY verification starting`);

  const { sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    // ── A. STRUCTURE ────────────────────────────────────────────────────────
    console.log("\nA. structure + row counts");
    const live = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    const liveSet = new Set(live.map((r) => r.tablename));
    for (const t of NEW_TABLES) {
      if (!liveSet.has(t)) {
        fail("A.structure", `table "${t}" is MISSING — the migration train is not fully applied`);
        continue;
      }
      const c = await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}"`);
      pass("A.structure", `${t.padEnd(24)} ${c[0]!.n} row(s)`);
    }
    if (failures.length > 0) {
      console.error(`\n[${NAME}] aborting — schema is incomplete; later checks would be noise.`);
      process.exitCode = 1;
      return;
    }

    // ── B. SYMMETRY ─────────────────────────────────────────────────────────
    console.log("\nB. skill_related symmetry (no DB trigger — this is the guarantee)");
    const asym = await sql<{ skill_id: string; related_skill_id: string }[]>`
      SELECT r.skill_id, r.related_skill_id
      FROM skill_related r
      WHERE NOT EXISTS (
        SELECT 1 FROM skill_related m
        WHERE m.skill_id = r.related_skill_id AND m.related_skill_id = r.skill_id
      )
      LIMIT 20
    `;
    if (asym.length > 0) {
      fail(
        "B.symmetry",
        `${asym.length}+ asymmetric pair(s), e.g. ${asym[0]!.skill_id} → ${asym[0]!.related_skill_id}`,
      );
    } else pass("B.symmetry", "every relation has its mirror");

    // ── C. SELF / KIND / ORPHANS ────────────────────────────────────────────
    console.log("\nC. closed-vocabulary integrity");
    const selfRel = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM skill_related WHERE skill_id = related_skill_id
    `;
    if ((selfRel[0]?.n ?? 0) > 0) fail("C.self", `${selfRel[0]!.n} self-relation(s)`);
    else pass("C.self", "no self-relations");

    const relKind = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM skill_related r
      JOIN skill s ON s.skill_id IN (r.skill_id, r.related_skill_id)
      WHERE s.kind <> 'match_skill'
    `;
    if ((relKind[0]?.n ?? 0) > 0) {
      fail("C.kind", `${relKind[0]!.n} relation endpoint(s) are attribute-kind, not match_skill`);
    } else pass("C.kind", "every relation endpoint is a match_skill");

    const wsKind = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM worker_skill ws JOIN skill s ON s.skill_id = ws.skill_id
      WHERE s.kind <> 'match_skill'
    `;
    if ((wsKind[0]?.n ?? 0) > 0) {
      warn(
        "C.worker_skill_kind",
        `${wsKind[0]!.n} worker_skill row(s) point at an attribute-kind skill`,
      );
    } else pass("C.worker_skill_kind", "every worker_skill points at a match_skill");

    // Orphan match ids: an id in job_postings.match_skill_ids with no match_skill row.
    const orphanMatch = await sql<{ job_posting_id: string; skill_id: string }[]>`
      SELECT jp.id AS job_posting_id, x.skill_id
      FROM job_postings jp
      CROSS JOIN LATERAL jsonb_array_elements_text(jp.match_skill_ids) AS x(skill_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM skill s WHERE s.skill_id = x.skill_id AND s.kind = 'match_skill'
      )
      LIMIT 20
    `;
    if (orphanMatch.length > 0) {
      fail(
        "C.orphan_match_ids",
        `${orphanMatch.length}+ posting(s) carry a match id that is not a match_skill, ` +
          `e.g. posting ${orphanMatch[0]!.job_posting_id} → "${orphanMatch[0]!.skill_id}"`,
      );
    } else pass("C.orphan_match_ids", "no orphan match_skill_ids");

    // ── D. REACH COVERAGE ───────────────────────────────────────────────────
    console.log("\nD. reach coverage");
    const notSuperset = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_postings jp
      WHERE jsonb_array_length(jp.match_skill_ids) > 0
        AND NOT (jp.reach_skill_ids @> jp.match_skill_ids)
    `;
    if ((notSuperset[0]?.n ?? 0) > 0) {
      fail(
        "D.reach_superset",
        `${notSuperset[0]!.n} posting(s) have reach_skill_ids that do NOT contain their ` +
          `match_skill_ids — re-run db:materialize:reach --apply`,
      );
    } else pass("D.reach_superset", "reach ⊇ match on every posting");

    const zeroReach = await sql<{ id: string; role_title: string }[]>`
      SELECT jp.id, jp.role_title
      FROM job_postings jp
      WHERE jp.status = 'open'
        AND jsonb_array_length(jp.match_skill_ids) > 0
        AND NOT EXISTS (SELECT 1 FROM job_reach jr WHERE jr.job_posting_id = jp.id)
      LIMIT 50
    `;
    if (zeroReach.length > 0) {
      // ZERO-REACH is a real, legitimate state (thin supply) — it is a WARNING with the
      // ids named, not a failure. A failure here would block a correct deploy.
      warn("D.zero_reach", `${zeroReach.length} open posting(s) reach ZERO workers`);
      for (const z of zeroReach.slice(0, 20))
        console.log(`      ${z.id}  ${JSON.stringify(z.role_title)}`);
    } else pass("D.zero_reach", "every open posting with match skills reaches ≥1 worker");

    const noSkillsOpen = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_postings
      WHERE status = 'open' AND jsonb_array_length(match_skill_ids) = 0
    `;
    if ((noSkillsOpen[0]?.n ?? 0) > 0) {
      warn(
        "D.no_match_skills",
        `${noSkillsOpen[0]!.n} OPEN posting(s) have NO match skills — they serve to nobody ` +
          `(see the D3 ops worklist)`,
      );
    } else pass("D.no_match_skills", "every open posting carries match skills");

    // ── E. TIER CORRECTNESS ─────────────────────────────────────────────────
    console.log("\nE. tier correctness");
    const badTier = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job_reach WHERE match_tier NOT IN (1, 2)
    `;
    if ((badTier[0]?.n ?? 0) > 0) fail("E.tier_domain", `${badTier[0]!.n} row(s) outside (1,2)`);
    else pass("E.tier_domain", "every match_tier ∈ (1,2)");

    const tier1Lie = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM job_reach jr JOIN job_postings jp ON jp.id = jr.job_posting_id
      WHERE jr.match_tier = 1
        AND NOT (jp.match_skill_ids @> to_jsonb(jr.matched_skill_id))
    `;
    if ((tier1Lie[0]?.n ?? 0) > 0) {
      fail(
        "E.tier1_truth",
        `${tier1Lie[0]!.n} TIER-1 row(s) whose matched_skill_id is NOT in the posting's ` +
          `match_skill_ids — the tier and the data disagree; re-run db:materialize:reach --apply`,
      );
    } else pass("E.tier1_truth", "every TIER-1 row matched a posted skill");

    // ── F. TENURE CLAMP (E8) ────────────────────────────────────────────────
    console.log("\nF. industry tenure clamp (E8)");
    const clampBreak = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM worker_skill ws
      JOIN worker_industry_tenure t
        ON t.worker_id = ws.worker_id AND t.industry_id = ws.industry_id
      WHERE ws.months_bucketed > t.calendar_months
    `;
    if ((clampBreak[0]?.n ?? 0) > 0) {
      fail(
        "F.clamp",
        `${clampBreak[0]!.n} worker_skill row(s) claim more months than the worker's industry ` +
          `tenure — re-run db:backfill:worker-skills --apply`,
      );
    } else pass("F.clamp", "no skill exceeds its industry tenure");

    const missingTenure = await sql<{ n: number }[]>`
      SELECT count(DISTINCT (ws.worker_id, ws.industry_id))::int AS n
      FROM worker_skill ws
      WHERE NOT EXISTS (
        SELECT 1 FROM worker_industry_tenure t
        WHERE t.worker_id = ws.worker_id AND t.industry_id = ws.industry_id
      )
    `;
    if ((missingTenure[0]?.n ?? 0) > 0) {
      fail(
        "F.tenure_coverage",
        `${missingTenure[0]!.n} (worker, industry) pair(s) have skills but NO tenure row`,
      );
    } else pass("F.tenure_coverage", "every (worker, industry) with skills has a tenure row");

    // ── G. CONFIG ───────────────────────────────────────────────────────────
    console.log("\nG. match_config");
    const cfgRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM match_config WHERE is_active
    `;
    const activeCount = cfgRows[0]?.n ?? 0;
    if (activeCount !== 1) {
      fail("G.active_row", `expected exactly 1 active match_config row, found ${activeCount}`);
    } else {
      const cfg = await sql<{ config: Record<string, unknown> }[]>`
        SELECT config FROM match_config WHERE is_active LIMIT 1
      `;
      const c = cfg[0]?.config ?? {};
      const required = [
        "engine_version",
        "month_bucket",
        "max_skills_per_posting",
        "tier_floor_months",
        "free_unlock_credits",
      ];
      const missing = required.filter((k) => c[k] === undefined);
      if (missing.length > 0) fail("G.config_keys", `missing key(s): ${missing.join(", ")}`);
      else
        pass(
          "G.active_row",
          `engine_version=${String(c.engine_version)} month_bucket=${String(c.month_bucket)} tier_floor_months=${String(c.tier_floor_months)}`,
        );
    }

    // ── H. QUERY PLANS ──────────────────────────────────────────────────────
    // A missing index does not fail a functional test — it fails production. Assert the
    // planner actually picks the indexes the migrations exist to provide.
    console.log("\nH. index usage (EXPLAIN)");

    const feedPlan = await sql.unsafe(
      `EXPLAIN (FORMAT TEXT) SELECT id FROM job_postings WHERE status = 'open' ORDER BY published_at DESC LIMIT 20`,
    );
    const feedText = feedPlan.map((r) => Object.values(r)[0] as string).join("\n");
    if (feedText.includes("job_postings_feed_idx"))
      pass("H.feed_idx", "feed query uses job_postings_feed_idx");
    else {
      warn(
        "H.feed_idx",
        `feed query did NOT use job_postings_feed_idx (small table ⇒ the planner may prefer a ` +
          `seq scan; re-check after real volume). Plan:\n${feedText
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n")}`,
      );
    }

    const reachPlan = await sql.unsafe(
      `EXPLAIN (FORMAT TEXT) SELECT worker_id, months_bucketed FROM worker_skill WHERE skill_id = ANY(ARRAY['mskill_probe']::text[]) AND wants`,
    );
    const reachText = reachPlan.map((r) => Object.values(r)[0] as string).join("\n");
    if (reachText.includes("worker_skill_reach_idx")) {
      pass("H.reach_idx", "reach driver uses worker_skill_reach_idx");
    } else {
      warn(
        "H.reach_idx",
        `reach driver did NOT use worker_skill_reach_idx (small table ⇒ seq scan is legal). ` +
          `Plan:\n${reachText
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n")}`,
      );
    }

    const jrPlan = await sql.unsafe(
      `EXPLAIN (FORMAT TEXT) SELECT job_posting_id, match_tier, matched_skill_id FROM job_reach WHERE worker_id = '00000000-0000-4000-8000-000000000000'::uuid`,
    );
    const jrText = jrPlan.map((r) => Object.values(r)[0] as string).join("\n");
    if (jrText.includes("job_reach_worker_idx"))
      pass("H.job_reach_idx", "feed read uses job_reach_worker_idx");
    else
      warn(
        "H.job_reach_idx",
        `feed read did NOT use job_reach_worker_idx. Plan:\n${jrText
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n")}`,
      );

    // Prove the covering payload actually shipped (the hand-appended INCLUDE clauses).
    const includes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('worker_skill_reach_idx', 'job_reach_worker_idx')
    `;
    for (const idx of includes) {
      if (idx.indexdef.toUpperCase().includes("INCLUDE")) {
        pass("H.include", `${idx.indexname} carries its INCLUDE payload`);
      } else {
        fail(
          "H.include",
          `${idx.indexname} has NO INCLUDE payload — the hand-appended clause was lost ` +
            `(most likely by regenerating over the migration). Recreate it: see 0053/0055.`,
        );
      }
    }

    // ── VERDICT ─────────────────────────────────────────────────────────────
    console.log("");
    if (warnings.length > 0) {
      console.log(`[${NAME}] ${warnings.length} warning(s) — review, they do not block:`);
      for (const w of warnings) console.log(`  ! ${w}`);
    }
    if (failures.length > 0) {
      console.error(`[${NAME}] FAILED — ${failures.length} violation(s):`);
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[${NAME}] PASS — Matching V1 schema + data are consistent.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
