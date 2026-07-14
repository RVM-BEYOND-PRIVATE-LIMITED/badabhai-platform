/**
 * Skill-vocabulary seed (ADR-0030 / TAX-2) — loads the canonical `@badabhai/taxonomy`
 * SKILL_CORPUS into `skill` (+ its source aliases into `skill_alias`, embedding = NULL).
 *
 * GUARDED: refuses to run when NODE_ENV === "production" (mirrors seed.ts / seed-demand.ts).
 *   The corpus is reference data, but seeding is an ops action — kept off prod by default.
 * IDEMPOTENT: skills upsert on the immutable `skill_id` (labels/domain propagate; the id
 *   never changes); aliases use a DETERMINISTIC id derived from (skill_id, text, lang) with
 *   ON CONFLICT DO NOTHING — so a re-run is a no-op at the row level AND never clobbers an
 *   embedding a later phase (TAX-4) may have written. Double-run → identical row counts.
 * PRIVACY (ADR-0030 SG-1): the corpus is reference vocabulary — no worker PII anywhere.
 * NOT embeddings: `skill_alias.embedding` stays NULL here; embedding is TAX-3/4 (a gated
 *   real provider call). The RVM Hinglish wedge + its aliases are TAX-5, not this seed.
 *
 *   pnpm db:seed:skills
 *   (DATABASE_URL is read from the environment / repo-root .env, like the other seeds.
 *    Build @badabhai/taxonomy first — `pnpm build` — so the corpus resolves.)
 */
import { SKILL_CORPUS, validateSkillCorpus, type SkillSeed } from "@badabhai/taxonomy";
import { config } from "dotenv";

import { createDbClient } from "./client";
import { skillAliases, skills } from "./schema";
import { deterministicAliasId as aliasId } from "./skill-alias-id";

// Load the repo-root .env (CWD is packages/db when run via the package script).
config({ path: "../../.env" });

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("[seed:skills] refusing to seed the skill vocabulary in production.");
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[seed:skills] DATABASE_URL is not set");

  // Never seed an invalid corpus (unknown domain / bad source / dup id).
  const problems = validateSkillCorpus();
  if (problems.length > 0) {
    throw new Error(`[seed:skills] corpus invalid:\n  - ${problems.join("\n  - ")}`);
  }

  const now = new Date();
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    let skillCount = 0;
    let aliasCount = 0;

    for (const s of SKILL_CORPUS as readonly SkillSeed[]) {
      // 1) The canonical skill — upsert on the immutable skill_id (id never changes).
      await db
        .insert(skills)
        .values({
          skillId: s.skillId,
          labelEn: s.labelEn,
          labelHi: s.labelHi,
          domainId: s.domainId,
          source: s.source,
          status: s.status,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: skills.skillId,
          set: {
            labelEn: s.labelEn,
            labelHi: s.labelHi,
            domainId: s.domainId,
            source: s.source,
            status: s.status,
            updatedAt: now,
          },
        });
      skillCount += 1;

      // 2) Source aliases — deterministic id + DO NOTHING (idempotent, embedding-safe).
      //    domain_id is denormalized from the skill (ADR-0030 domain-scoped filter).
      for (const a of s.aliases) {
        await db
          .insert(skillAliases)
          .values({
            id: aliasId(s.skillId, a.text, a.lang),
            skillId: s.skillId,
            text: a.text,
            lang: a.lang,
            source: a.source,
            domainId: s.domainId,
            // embedding stays NULL — TAX-3/4 populates it via a gated real call.
          })
          .onConflictDoNothing({ target: skillAliases.id });
        aliasCount += 1;
      }
    }

    console.log("[seed:skills] skill vocabulary seeded (embeddings NULL — TAX-3/4 populates):");
    console.log(`  skills  = ${skillCount}`);
    console.log(`  aliases = ${aliasCount} (deterministic ids; re-run is a no-op)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[seed:skills] failed:", err);
  process.exit(1);
});
