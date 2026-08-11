/**
 * D4 — Matching V1 CUTOVER CONTINUITY: convert legacy `jobs` → `job_postings`.
 *
 * ⚠️ WITHOUT THIS THE WORKER FEED IS EMPTY AT FLAG FLIP. `job_postings` becomes THE
 * served entity (owner ruling 2026-07-30) and today's live supply lives in `jobs`. This
 * script carries it across.
 *
 * FOR EACH `jobs` ROW WITH status='open':
 *   1. INSERT a `job_postings` row — role_title=title, city, pay_min/pay_max, shift,
 *      needed_by, description copied verbatim; match_skill_ids from
 *      TRADE_TO_MATCH_SKILL[trade_key]; reach_skill_ids = match ∪ skill_related;
 *      industry_id from the match skill; status='open'; published_at = jobs.created_at
 *      (the honest visibility time, not now()); source_job_id = jobs.id.
 *   2. Set the `jobs` row status='closed'.
 *
 * IDEMPOTENCY — the chosen mechanism, stated plainly: a `job_postings.source_job_id`
 * column (added in migration 0054) with a UNIQUE index. The insert is
 * `ON CONFLICT (source_job_id) DO NOTHING`, so a re-run inserts nothing and the whole
 * script becomes a no-op. This was chosen over a separate mapping table because the
 * provenance belongs ON the posting (it answers "where did this come from?" forever),
 * and over a marker in a text field because a text marker cannot be a UNIQUE constraint.
 *
 * WHAT IS NOT TOUCHED:
 *   * Existing `applications` rows keep pointing at the now-CLOSED `jobs` rows. They are
 *     NEVER repointed at the new postings (migration 0056 header: coexist, never repoint).
 *   * `jobs` rows are not deleted — only closed. The originals stay readable forever.
 *
 * TWO VALUES THIS SCRIPT REFUSES TO GUESS (both are REQUIRED CLI args):
 *   --ops-actor=<uuid>   the `created_by` stamped on each new posting.
 *   --org-label="..."    `job_postings.org_label` is NOT NULL and `jobs` is faceless by
 *                        design (ADR-0009 §2: zero employer identity). There is no
 *                        correct value to derive, so the script demands one instead of
 *                        inventing employer-shaped copy. It MUST NOT be a real employer
 *                        name (that would put PII on a faceless row) — use a neutral
 *                        label. It is PII-checked before use.
 *   --vacancy-band=      `vacancy_band` is NOT NULL and `jobs` carries no vacancy count.
 *                        Defaults to '1' — the most CONSERVATIVE band, because ADR-0016
 *                        capacity counts active vacancies and over-claiming is the
 *                        harmful direction.
 *
 * DRY-RUN IS THE DEFAULT; `--apply` writes. Each conversion runs in a TRANSACTION so a
 * posting can never exist with its source job still open (or vice versa).
 *
 *   pnpm db:convert:seed-jobs --ops-actor=<uuid> --org-label="Hiring Employer"
 *   pnpm db:convert:seed-jobs --ops-actor=<uuid> --org-label="Hiring Employer" --apply
 */
import { looksLikePii, looksLikeUrl } from "@badabhai/validators";
import { eq, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { jobPostings, jobs } from "./schema";
import { loadMatchTaxonomy, validateMatchTaxonomy, DEFAULT_INDUSTRY_ID } from "./match-taxonomy";
import { expandReachSkillIds } from "./match-v1-derive";
import { argValue, parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";

const NAME = "convert:seed-jobs";

/** Mirrors VACANCY_BANDS (schema.ts job_postings_vacancy_band_chk). */
const VACANCY_BANDS = ["1", "2-5", "6-10", "11-25", "25+"] as const;
type VacancyBandValue = (typeof VACANCY_BANDS)[number];

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);

  const opsActor = argValue("ops-actor");
  if (!opsActor || !/^[0-9a-f-]{36}$/i.test(opsActor)) {
    throw new Error(
      `[${NAME}] --ops-actor=<uuid> is REQUIRED — it becomes job_postings.created_by on ` +
        `every converted row. This script will not invent an actor id.`,
    );
  }

  const orgLabel = argValue("org-label");
  if (!orgLabel || orgLabel.trim().length === 0) {
    throw new Error(
      `[${NAME}] --org-label="..." is REQUIRED. job_postings.org_label is NOT NULL and the ` +
        `legacy jobs table is faceless by design (ADR-0009 §2), so there is nothing to derive ` +
        `it from. Pass a NEUTRAL, NON-EMPLOYER label — never a real company name.`,
    );
  }
  // Fail closed on anything that looks like PII or a URL landing on a faceless row.
  if (looksLikePii(orgLabel) || looksLikeUrl(orgLabel)) {
    throw new Error(
      `[${NAME}] --org-label failed the PII/URL check. job_postings rows created from ` +
        `faceless jobs must not gain employer identity or contact info.`,
    );
  }

  const bandArg = (argValue("vacancy-band") ?? "1") as VacancyBandValue;
  if (!VACANCY_BANDS.includes(bandArg)) {
    throw new Error(`[${NAME}] --vacancy-band must be one of ${VACANCY_BANDS.join(", ")}`);
  }

  const taxonomy = loadMatchTaxonomy(NAME);
  const problems = validateMatchTaxonomy(taxonomy);
  if (problems.length > 0) {
    throw new Error(`[${NAME}] match vocabulary invalid:\n  - ${problems.join("\n  - ")}`);
  }
  const industryBySkill = new Map(taxonomy.MATCH_SKILLS.map((s) => [s.skillId, s.industryId]));

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  const now = new Date();
  try {
    const openJobs = await db
      .select({
        id: jobs.id,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        payMin: jobs.payMin,
        payMax: jobs.payMax,
        shift: jobs.shift,
        neededBy: jobs.neededBy,
        description: jobs.description,
        payerId: jobs.payerId,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(eq(jobs.status, "open"));

    // Which are already converted (the idempotency read).
    const converted = await db
      .select({ sourceJobId: jobPostings.sourceJobId })
      .from(jobPostings)
      .where(dsql`${jobPostings.sourceJobId} IS NOT NULL`);
    const alreadyConverted = new Set(converted.map((r) => r.sourceJobId as string));

    const unbridgedTrades = new Map<string, number>();
    let toConvert = 0;
    let convertedNow = 0;
    let closedNow = 0;
    let skippedAlready = 0;

    for (const j of openJobs) {
      if (alreadyConverted.has(j.id)) {
        skippedAlready += 1;
        continue;
      }
      const mskill = taxonomy.TRADE_TO_MATCH_SKILL[j.tradeKey];
      if (!mskill) {
        // A trade with no bridge converts with NO match ids — it would reach nobody.
        // Counted and reported rather than silently produced.
        unbridgedTrades.set(j.tradeKey, (unbridgedTrades.get(j.tradeKey) ?? 0) + 1);
      }
      toConvert += 1;
      if (!opts.apply) continue;

      const matchIds = mskill ? [mskill] : [];
      const reachIds = await expandReachSkillIds(db, matchIds);
      const industryId = mskill
        ? (industryBySkill.get(mskill) ?? DEFAULT_INDUSTRY_ID)
        : DEFAULT_INDUSTRY_ID;

      // One transaction per job: the posting and the source close land together or not
      // at all, so there is never a window where both entities serve the same vacancy.
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(jobPostings)
          .values({
            createdBy: opsActor,
            payerId: j.payerId,
            orgLabel,
            roleTitle: j.title,
            city: j.city,
            payMin: j.payMin,
            payMax: j.payMax,
            shift: j.shift,
            neededBy: j.neededBy,
            description: j.description,
            vacancyBand: bandArg,
            status: "open",
            industryId,
            matchSkillIds: matchIds,
            reachSkillIds: reachIds,
            publishedAt: j.createdAt,
            sourceJobId: j.id,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: jobPostings.sourceJobId })
          .returning({ id: jobPostings.id });

        if (inserted.length === 0) return; // raced with another run — nothing to close
        convertedNow += 1;

        const closed = await tx
          .update(jobs)
          .set({ status: "closed", updatedAt: now })
          .where(eq(jobs.id, j.id))
          .returning({ id: jobs.id });
        closedNow += closed.length;
      });
    }

    printCounts(NAME, {
      "open jobs found": openJobs.length,
      "already converted (no-op)": skippedAlready,
      "to convert": toConvert,
      "postings created": convertedNow,
      "legacy jobs closed": closedNow,
      "org_label used": JSON.stringify(orgLabel),
      "vacancy_band used": bandArg,
      "trades with NO bridge": unbridgedTrades.size,
    });

    if (unbridgedTrades.size > 0) {
      console.log(
        `[${NAME}] WARNING — these trade_keys have no TRADE_TO_MATCH_SKILL bridge, so their ` +
          `converted postings carry NO match ids and reach NOBODY. Add the bridge in ` +
          `packages/taxonomy and re-run, or fix the postings by hand:`,
      );
      for (const [trade, n] of unbridgedTrades) console.log(`  ${trade.padEnd(28)} ${n} job(s)`);
    }

    printFooter(NAME, opts, convertedNow + closedNow);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
