/**
 * D3 — Matching V1 `job_postings` backfill (migration 0054).
 *
 * Two jobs, both idempotent:
 *
 *  1. PUBLISHED_AT: `published_at = created_at` for every non-draft posting that has
 *     none. Exact, not a guess — a posting that is not a draft was visible from the
 *     moment it was created, and the V1 feed orders by published_at.
 *
 *  2. MATCH SKILLS (a PROPOSAL, never a guess): for OPEN payer postings with an empty
 *     `match_skill_ids`, propose ids by NORMALIZED KEYWORD MATCH of `role_title` against
 *     the MATCH_SKILLS labels (labelEn + labelHi). At most `max_skills_per_posting`.
 *     ANYTHING UNRESOLVED IS LEFT EMPTY and printed to an OPS WORKLIST (stdout + a JSON
 *     file). It is never approximated, never defaulted, and never inferred from
 *     description free text. An empty match set means the posting reaches nobody —
 *     fail-closed and visible, which is the correct failure for a matching system.
 *
 *     `reach_skill_ids` is set alongside as match ∪ `skill_related` neighbours, so the
 *     GIN reconciliation index is true the moment the ids land.
 *
 * DRY-RUN IS THE DEFAULT; `--apply` writes. The worklist is written in BOTH modes — its
 * whole purpose is to be read before you decide anything.
 *
 * PRIVACY: reads `role_title` (non-PII by the ADR-0012 contract) and writes ids only.
 * The worklist file carries posting ids + role titles — treat it as internal ops data
 * and do not commit it (`*.worklist.json` is gitignored via the repo's tmp conventions;
 * write it outside the repo if in doubt).
 *
 *   pnpm db:backfill:job-postings                                # dry run + worklist
 *   pnpm db:backfill:job-postings --apply                        # write
 *   pnpm db:backfill:job-postings --apply --worklist=/tmp/wl.json
 */
import { writeFileSync } from "node:fs";
import { and, eq, isNull, or, sql as dsql } from "drizzle-orm";

import { createDbClient, type Database } from "./client";
import { jobPostings, matchConfig } from "./schema";
import { loadMatchTaxonomy, validateMatchTaxonomy } from "./match-taxonomy";
import { expandReachSkillIds, proposeMatchSkills } from "./match-v1-derive";
import {
  argValue,
  asObject,
  asStringArray,
  finiteOrNull,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";

const NAME = "backfill:job-postings";

const FALLBACK_MAX_SKILLS = 3;

async function readMaxSkills(db: Database): Promise<number> {
  const rows = await db
    .select({ config: matchConfig.config })
    .from(matchConfig)
    .where(eq(matchConfig.isActive, true))
    .limit(1);
  const cfg = asObject(rows[0]?.config);
  const n = cfg ? finiteOrNull(cfg.max_skills_per_posting) : null;
  if (n === null || !Number.isInteger(n) || n < 1) {
    console.warn(
      `[${NAME}] no usable match_config.max_skills_per_posting — falling back to ` +
        `${FALLBACK_MAX_SKILLS}. Run db:seed:match:vocabulary first.`,
    );
    return FALLBACK_MAX_SKILLS;
  }
  return n;
}

interface WorklistEntry {
  jobPostingId: string;
  roleTitle: string;
  reason: "no_label_match";
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);

  const worklistPath = argValue("worklist") ?? "matching-v1-unresolved-postings.worklist.json";

  const taxonomy = loadMatchTaxonomy(NAME);
  const problems = validateMatchTaxonomy(taxonomy);
  if (problems.length > 0) {
    throw new Error(`[${NAME}] match vocabulary invalid:\n  - ${problems.join("\n  - ")}`);
  }

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  const now = new Date();
  try {
    const maxSkills = await readMaxSkills(db);
    const industryBySkill = new Map(taxonomy.MATCH_SKILLS.map((s) => [s.skillId, s.industryId]));

    // ── 1. published_at ──────────────────────────────────────────────────────
    const needPublished = await db
      .select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(isNull(jobPostings.publishedAt), dsql`${jobPostings.status} <> 'draft'`));

    let publishedWritten = 0;
    if (opts.apply && needPublished.length > 0) {
      const rows = await db
        .update(jobPostings)
        .set({ publishedAt: dsql`${jobPostings.createdAt}`, updatedAt: now })
        .where(and(isNull(jobPostings.publishedAt), dsql`${jobPostings.status} <> 'draft'`))
        .returning({ id: jobPostings.id });
      publishedWritten = rows.length;
    }

    // ── 2. match_skill_ids proposal ──────────────────────────────────────────
    // OPEN, payer-owned postings with no match ids. Ops-created postings (payer_id NULL)
    // are deliberately included too — they are equally invisible without match ids — but
    // the worklist distinguishes nothing, because the fix is the same for both.
    const candidates = await db
      .select({
        id: jobPostings.id,
        roleTitle: jobPostings.roleTitle,
        matchSkillIds: jobPostings.matchSkillIds,
        industryId: jobPostings.industryId,
      })
      .from(jobPostings)
      .where(
        and(
          eq(jobPostings.status, "open"),
          or(
            dsql`jsonb_array_length(${jobPostings.matchSkillIds}) = 0`,
            isNull(jobPostings.matchSkillIds),
          ),
        ),
      );

    const worklist: WorklistEntry[] = [];
    let resolved = 0;
    let written = 0;

    for (const p of candidates) {
      if (asStringArray(p.matchSkillIds).length > 0) continue; // defensive
      const proposal = proposeMatchSkills(p.roleTitle, taxonomy.MATCH_SKILLS, maxSkills);
      if (proposal.length === 0) {
        worklist.push({ jobPostingId: p.id, roleTitle: p.roleTitle, reason: "no_label_match" });
        continue;
      }
      resolved += 1;
      if (!opts.apply) continue;

      const reach = await expandReachSkillIds(db, proposal);
      // industry_id follows the proposed skills when the posting has none; a posting that
      // already carries one is NEVER re-industried by a keyword guess.
      const industryId = p.industryId ?? industryBySkill.get(proposal[0]!) ?? null;
      const rows = await db
        .update(jobPostings)
        .set({
          matchSkillIds: proposal,
          reachSkillIds: reach,
          ...(industryId ? { industryId } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(jobPostings.id, p.id),
            // Optimistic guard: only write if it is STILL empty, so a concurrent ops edit
            // during the backfill wins instead of being clobbered.
            dsql`jsonb_array_length(${jobPostings.matchSkillIds}) = 0`,
          ),
        )
        .returning({ id: jobPostings.id });
      written += rows.length;
    }

    // The worklist is written in BOTH modes — reading it is the point.
    writeFileSync(
      worklistPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: opts.apply ? "apply" : "dry-run",
          unresolvedCount: worklist.length,
          note:
            "These OPEN postings could not be resolved to a match skill from role_title. " +
            "They are LEFT EMPTY on purpose and reach nobody. An ops human must set " +
            "match_skill_ids (and reach_skill_ids) for each, or close them.",
          postings: worklist,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    printCounts(NAME, {
      max_skills_per_posting: maxSkills,
      "postings needing published_at": needPublished.length,
      "published_at written": publishedWritten,
      "open postings with no match ids": candidates.length,
      "resolved by label match": resolved,
      "match ids written": written,
      "UNRESOLVED → ops worklist": worklist.length,
      "worklist file": worklistPath,
    });

    if (worklist.length > 0) {
      console.log(
        `[${NAME}] OPS WORKLIST — ${worklist.length} posting(s) reach NOBODY until fixed:`,
      );
      for (const w of worklist.slice(0, 50)) {
        console.log(`  ${w.jobPostingId}  ${JSON.stringify(w.roleTitle)}`);
      }
      if (worklist.length > 50)
        console.log(`  … and ${worklist.length - 50} more (see ${worklistPath})`);
    }

    printFooter(NAME, opts, publishedWritten + written);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
