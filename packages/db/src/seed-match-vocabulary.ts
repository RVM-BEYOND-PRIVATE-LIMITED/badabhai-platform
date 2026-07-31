/**
 * D1 — Matching V1 match-vocabulary seed (migrations 0052 + 0057).
 *
 * Loads the V1 vocabulary from `@badabhai/taxonomy` into the DB:
 *   1. UPSERT every `MATCH_SKILLS` entry into `skill` with kind='match_skill' + industry_id.
 *   2. BACKFILL every other `skill` row to kind='attribute' (idempotent; also REPAIRS a
 *      row that was mis-tagged by an earlier run).
 *   3. UPSERT the SYMMETRIC `skill_related` rows — BOTH directions per unordered pair.
 *   4. INSERT the single active `match_config` row IF ABSENT (never overwrites an ops edit).
 *
 * DRY-RUN IS THE DEFAULT; `--apply` writes. `NODE_ENV=production` needs
 * MATCH_V1_PROD_CONFIRM (see match-v1-cli.ts). Re-running is a no-op at the row level.
 *
 * THE VALIDATOR IS THE POINT. `skill_related` has NO symmetry trigger (that is a
 * deliberate schema decision — see the table comment in schema.ts), so this script is
 * one of the two places symmetry is actually guaranteed (`verify-match-v1.ts` is the
 * other). It REFUSES, before writing anything, to seed:
 *   * an ASYMMETRIC relation — impossible by construction here, because it expands each
 *     unordered pair into both directed rows; a pair listed twice is rejected instead;
 *   * a SELF relation (a ↔ a);
 *   * a relation touching an ATTRIBUTE-kind id (anything not in MATCH_SKILLS);
 *   * a bridge (role/attribute/trade) that targets a non-match-skill.
 * Any problem aborts the whole run — nothing partial is written.
 *
 * PRIVACY: reference vocabulary only. No worker data is read or written. No PII.
 * INVARIANT #4: deterministic, checked-in data — no LLM produces or reads it.
 *
 *   pnpm db:seed:match:vocabulary            # dry run (counts only)
 *   pnpm db:seed:match:vocabulary --apply    # write
 *   pnpm db:seed:match:vocabulary --apply --prune-relations   # also delete corpus-absent pairs
 */
import { and, eq, inArray, notInArray, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { matchConfig, skillRelated, skills } from "./schema";
import { directedRelationRows, loadMatchTaxonomy, validateMatchTaxonomy } from "./match-taxonomy";
import {
  argFlag,
  argValue,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";

const NAME = "seed:match:vocabulary";

/**
 * The V1 config values (ratified 2026-07-30). Written ONLY when no active `match_config`
 * row exists — an existing row is an ops decision and is never overwritten by a re-run.
 */
export const MATCH_CONFIG_V1 = {
  engine_version: "v1.0",
  month_bucket: 6,
  max_skills_per_posting: 3,
  related_skills_default: "on",
  max_consecutive_same_company: 2,
  applicant_quota: "off",
  tier_floor_months: 36,
  free_unlock_credits: 50,
  boost_supply_floor: 25,
} as const;

/**
 * The ops actor stamped on the seeded config row. Overridable with `--ops-actor=<uuid>`;
 * the default is a stable, clearly-synthetic id so a seeded row is distinguishable from
 * a human edit in the audit trail.
 */
const DEFAULT_OPS_ACTOR = "5eeded00-0052-4a00-8000-000000000052";

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);

  const pruneRelations = argFlag("prune-relations");
  const opsActor = argValue("ops-actor") ?? DEFAULT_OPS_ACTOR;
  if (!/^[0-9a-f-]{36}$/i.test(opsActor)) throw new Error(`[${NAME}] --ops-actor must be a uuid`);

  // 1. Load + VALIDATE before a single write.
  const taxonomy = loadMatchTaxonomy(NAME);
  const problems = validateMatchTaxonomy(taxonomy);
  if (problems.length > 0) {
    throw new Error(
      `[${NAME}] refusing to seed an invalid match vocabulary:\n  - ${problems.join("\n  - ")}`,
    );
  }

  const matchIds = taxonomy.MATCH_SKILLS.map((s) => s.skillId);
  const directed = directedRelationRows(taxonomy.MATCH_SKILL_RELATION_PAIRS);

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  const now = new Date();
  try {
    // ── Plan (both modes read the same live state) ───────────────────────────
    const existingMatchRows = await db
      .select({ skillId: skills.skillId })
      .from(skills)
      .where(inArray(skills.skillId, matchIds));
    const existingMatchIds = new Set(existingMatchRows.map((r) => r.skillId));
    const newSkillCount = matchIds.filter((id) => !existingMatchIds.has(id)).length;

    const mistaggedRows = await db
      .select({ n: dsql<number>`count(*)::int` })
      .from(skills)
      .where(and(eq(skills.kind, "match_skill"), notInArray(skills.skillId, matchIds)));
    const mistagged = mistaggedRows[0]?.n ?? 0;

    const existingRelationRows = await db
      .select({ skillId: skillRelated.skillId, relatedSkillId: skillRelated.relatedSkillId })
      .from(skillRelated);
    const existingRelations = new Set(
      existingRelationRows.map((r) => `${r.skillId}|${r.relatedSkillId}`),
    );
    const wantedRelations = new Set(directed.map((r) => `${r.skillId}|${r.relatedSkillId}`));
    const newRelations = directed.filter(
      (r) => !existingRelations.has(`${r.skillId}|${r.relatedSkillId}`),
    ).length;
    const staleRelations = existingRelationRows.filter(
      (r) => !wantedRelations.has(`${r.skillId}|${r.relatedSkillId}`),
    );

    const activeConfigRows = await db
      .select({ id: matchConfig.id })
      .from(matchConfig)
      .where(eq(matchConfig.isActive, true))
      .limit(1);
    const configNeeded = activeConfigRows.length === 0;

    printCounts(NAME, {
      "match skills in corpus": matchIds.length,
      "match skills to create": newSkillCount,
      "match skills to re-tag": matchIds.length - newSkillCount,
      "rows mis-tagged match_skill": mistagged,
      "directed relation rows": directed.length,
      "relation rows to create": newRelations,
      "relation rows corpus-absent": staleRelations.length,
      "stale relations pruned": pruneRelations ? staleRelations.length : 0,
      "active match_config row": configNeeded ? "MISSING (will seed)" : "present (untouched)",
    });

    const planned =
      newSkillCount +
      mistagged +
      newRelations +
      (pruneRelations ? staleRelations.length : 0) +
      (configNeeded ? 1 : 0);

    if (!opts.apply) {
      if (staleRelations.length > 0 && !pruneRelations) {
        console.log(
          `[${NAME}] NOTE: ${staleRelations.length} relation row(s) exist that the corpus does ` +
            `not describe. They are LEFT ALONE unless --prune-relations is passed (an ops-added ` +
            `pair is a legitimate reason for one to exist).`,
        );
      }
      printFooter(NAME, opts, planned);
      return;
    }

    // ── Apply ────────────────────────────────────────────────────────────────
    // 1. Upsert the match skills. `kind`/`industry_id` are seeder-OWNED and refreshed on
    //    every run; `skill_id` is immutable and never rewritten (ADR-0030 SG-5).
    for (const s of taxonomy.MATCH_SKILLS) {
      await db
        .insert(skills)
        .values({
          skillId: s.skillId,
          labelEn: s.labelEn,
          labelHi: s.labelHi ?? null,
          domainId: s.domainId,
          source: s.source,
          status: s.status ?? "active",
          kind: "match_skill",
          industryId: s.industryId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skills.skillId,
          set: {
            labelEn: s.labelEn,
            labelHi: s.labelHi ?? null,
            domainId: s.domainId,
            source: s.source,
            status: s.status ?? "active",
            kind: "match_skill",
            industryId: s.industryId,
            updatedAt: now,
          },
        });
    }

    // 2. Everything NOT in the corpus is an attribute. Idempotent + self-repairing: a row
    //    the 0052 default already set to 'attribute' is untouched (the WHERE filters it out).
    const retagged = await db
      .update(skills)
      .set({ kind: "attribute", updatedAt: now })
      .where(and(eq(skills.kind, "match_skill"), notInArray(skills.skillId, matchIds)))
      .returning({ id: skills.skillId });

    // 3. Both directed rows per unordered pair. DO NOTHING keeps a re-run a no-op and
    //    never rewrites created_at.
    let relationsWritten = 0;
    for (const r of directed) {
      const inserted = await db
        .insert(skillRelated)
        .values({ skillId: r.skillId, relatedSkillId: r.relatedSkillId })
        .onConflictDoNothing({ target: [skillRelated.skillId, skillRelated.relatedSkillId] })
        .returning({ id: skillRelated.skillId });
      relationsWritten += inserted.length;
    }

    let relationsPruned = 0;
    if (pruneRelations) {
      for (const stale of staleRelations) {
        const gone = await db
          .delete(skillRelated)
          .where(
            and(
              eq(skillRelated.skillId, stale.skillId),
              eq(skillRelated.relatedSkillId, stale.relatedSkillId),
            ),
          )
          .returning({ id: skillRelated.skillId });
        relationsPruned += gone.length;
      }
    }

    // 4. The single active config row — only if absent.
    let configWritten = 0;
    if (configNeeded) {
      const rows = await db
        .insert(matchConfig)
        .values({ config: MATCH_CONFIG_V1, revision: 1, isActive: true, updatedBy: opsActor })
        .returning({ id: matchConfig.id });
      configWritten = rows.length;
    }

    // 5. POST-WRITE SYMMETRY ASSERTION. The DB has no trigger, so prove it here rather
    //    than assume it: every directed row must have its mirror.
    const asymmetric = await sql`
      SELECT r.skill_id, r.related_skill_id
      FROM skill_related r
      WHERE NOT EXISTS (
        SELECT 1 FROM skill_related m
        WHERE m.skill_id = r.related_skill_id AND m.related_skill_id = r.skill_id
      )
      LIMIT 5
    `;
    if (asymmetric.length > 0) {
      throw new Error(
        `[${NAME}] POST-WRITE CHECK FAILED — ${asymmetric.length}+ asymmetric relation row(s) ` +
          `remain (e.g. ${asymmetric[0]!.skill_id} → ${asymmetric[0]!.related_skill_id}). ` +
          `Re-run with --prune-relations, or remove the stray rows by hand.`,
      );
    }

    printCounts(NAME, {
      "match skills upserted": taxonomy.MATCH_SKILLS.length,
      "rows re-tagged to attribute": retagged.length,
      "relation rows inserted": relationsWritten,
      "relation rows pruned": relationsPruned,
      "match_config rows seeded": configWritten,
      "symmetry check": "PASS",
    });
    printFooter(NAME, opts, planned);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
