/**
 * D4 — Matching V1 CUTOVER CONTINUITY: convert legacy `jobs` → `job_postings`.
 *
 * ⚠️ WITHOUT THIS THE WORKER FEED IS EMPTY AT FLAG FLIP. `job_postings` becomes THE
 * served entity (owner ruling 2026-07-30) and today's live supply lives in `jobs`. This
 * script carries it across.
 *
 * FOR EACH `jobs` ROW WITH status='open' AND payer_id NULL (seed/ops rows — see the ADR-0050 fence below):
 *   1. INSERT a `job_postings` row — role_title=title, city, area, pay_min/pay_max,
 *      pay_type, shift, needed_by, description, experience window, benefits,
 *      requirements and role_kind (0131; display only, never a match input) copied
 *      verbatim; match_skill_ids from TRADE_TO_MATCH_SKILL[trade_key]; reach_skill_ids
 *      = match ∪ skill_related; industry_id from the match skill; status='open';
 *      published_at = jobs.created_at (the honest visibility time, not now());
 *      source_job_id = jobs.id.
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
 * WORKER-VISIBLE TEXT IS SCREENED FIRST (#1823 B3). Every pending `title`, `description`
 * and `benefits` / `requirements` chip runs the ADR-0024 screen
 * (`screenJobTextForConversion`). One failure refuses `--apply` for the whole batch before
 * anything is written.
 *
 * `--feed-cutover-now` IS REQUIRED FOR `--apply` WHEN THERE IS ANYTHING TO CONVERT.
 * Closing an open legacy row drains the LIVE worker feed while `MATCH_V1_ENABLED=false`
 * (the committed default — the live feed reads `jobs`, the V1 feed reads `job_reach` and
 * needs D5 materialized first). Running this early emptied the whole deck on 2026-09-18
 * (#1561 follow-up: 18 rows closed on a flag-off deploy, feed went to zero). Pass the flag
 * only when the `MATCH_V1_ENABLED` flip is happening NOW — D5 `db:materialize:reach --apply`
 * must follow in the same window, per the runbook order D4 → D5.
 *
 * WITH `FEED_POSTINGS_UNION_ENABLED` ARMED (#1823, ADR-0049) the drain above no longer
 * happens for SEED rows: the flag-off feed also serves open, published `job_postings`, so a
 * converted row stays on the deck as its posting twin — in the same position
 * (`published_at = jobs.created_at`) and with the worker's applied state kept (the feed's
 * source-job anti-join). One change in kind: the twin is gated by the #1240 skill-overlap
 * rule, so a profiled worker sees it only if he wants one of its reach skills (ADR-0049 R15).
 * The flag above is still required.
 *
 * SEED AND OPS ROWS ONLY — THE ADR-0050 §6.2 FENCE (C6). This script converts ONLY open rows with
 * `payer_id` NULL. It REPORTS and NEVER converts an open payer-owned row (an agency job): copying
 * the agent's `payer_id` would mint an agent-owned posting (#1885), closing the source would take
 * the agency's live job away, and its match skill would be inferred from `trade_key` — each a
 * breach of ADR-0050 C1/C2/C4. Agency inventory reaches V1 through its system-owned TWIN instead
 * (`db:sync:agency-twins`). `--apply` is REFUSED while any open payer-owned row has no twin yet:
 * the flip order is sync → D4 → D5 (ADR-0050 §6.3 step g), and this keeps it that way by
 * construction rather than by run order.
 *
 *   pnpm db:convert:seed-jobs --ops-actor=<uuid> --org-label="Hiring Employer"
 *   pnpm db:convert:seed-jobs --ops-actor=<uuid> --org-label="Hiring Employer" --apply --feed-cutover-now
 */
import { looksLikePii, looksLikeUrl } from "@badabhai/validators";
import { eq, sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { AGENCY_TWIN_SYNC_SOURCE, d4AgencyFence } from "./agency-twin";
import { jobPostings, jobs } from "./schema";
import { loadMatchTaxonomy, validateMatchTaxonomy, DEFAULT_INDUSTRY_ID } from "./match-taxonomy";
import { expandReachSkillIds, screenJobTextForConversion } from "./match-v1-derive";
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
    const allOpenJobs = await db
      .select({
        id: jobs.id,
        tradeKey: jobs.tradeKey,
        title: jobs.title,
        city: jobs.city,
        area: jobs.area,
        payMin: jobs.payMin,
        payMax: jobs.payMax,
        payType: jobs.payType,
        shift: jobs.shift,
        neededBy: jobs.neededBy,
        description: jobs.description,
        minExperienceYears: jobs.minExperienceYears,
        maxExperienceYears: jobs.maxExperienceYears,
        benefits: jobs.benefits,
        requirements: jobs.requirements,
        roleKind: jobs.roleKind,
        payerId: jobs.payerId,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(eq(jobs.status, "open"));

    // Which are already converted (the idempotency read).
    const converted = await db
      .select({ sourceJobId: jobPostings.sourceJobId, syncSource: jobPostings.syncSource })
      .from(jobPostings)
      .where(dsql`${jobPostings.sourceJobId} IS NOT NULL`);
    const alreadyConverted = new Set(
      converted.filter((r) => r.syncSource === null).map((r) => r.sourceJobId as string),
    );
    const twinned = new Set(
      converted
        .filter((r) => r.syncSource === AGENCY_TWIN_SYNC_SOURCE)
        .map((r) => r.sourceJobId as string),
    );

    // THE ADR-0050 §6.2 FENCE (C6). Payer-owned open rows are agency inventory: REPORTED, never
    // converted, and `--apply` waits until every one has its twin (sync → D4 → D5).
    const fence = d4AgencyFence(allOpenJobs, twinned);
    const payerOwned = fence.agencyRows;
    const payerOwnedWithoutTwin = fence.agencyRowsWithoutTwin;
    if (payerOwned.length > 0) {
      console.log(
        `[${NAME}] ${payerOwned.length} open payer-owned (agency) job(s) are NOT converted ` +
          `(ADR-0050 §6.2); ${payerOwnedWithoutTwin.length} of them have no agency twin yet.`,
      );
      for (const j of payerOwnedWithoutTwin) console.log(`  ${j.id} no twin`);
    }
    if (opts.apply && payerOwnedWithoutTwin.length > 0) {
      throw new Error(
        `[${NAME}] REFUSING --apply: ${payerOwnedWithoutTwin.length} open agency job(s) have no ` +
          `system-owned twin. Run db:sync:agency-twins --apply first (ADR-0050 §6.3 step g: ` +
          `sync → D4 → D5). Nothing was written.`,
      );
    }
    const openJobs = fence.convertible;

    // THE FEED-CUTOVER GATE (#1561 follow-up, 2026-09-18). Closing an open legacy row
    // drains the LIVE worker feed while `MATCH_V1_ENABLED=false` — the live feed reads
    // `jobs`, and the V1 replacement reads `job_reach`, which does not exist until D5
    // materializes it. An early `--apply` emptied the whole deck (18 rows, zero supply
    // on both paths). So `--apply` with anything left to convert requires the explicit
    // `--feed-cutover-now` acknowledgement: pass it only when the flag flip is happening
    // NOW, with D5 `db:materialize:reach --apply` in the same window. A no-op re-run
    // (everything already converted) needs no acknowledgement and stays a no-op.
    const pendingJobs = openJobs.filter((j) => !alreadyConverted.has(j.id));
    const pendingConvert = pendingJobs.length;
    if (opts.apply && pendingConvert > 0 && !process.argv.includes("--feed-cutover-now")) {
      throw new Error(
        `[${NAME}] REFUSING --apply: ${pendingConvert} open legacy job(s) would be CLOSED, ` +
          `which drains the live worker feed while MATCH_V1_ENABLED=false. Re-run with ` +
          `--feed-cutover-now when the flag flip is happening NOW (and run D5 ` +
          `db:materialize:reach --apply in the same window), or run without --apply for a dry run.`,
      );
    }

    // THE WORKER-VISIBLE TEXT GATE (#1823 B3). `title`, `description` and each benefits /
    // requirements chip land on the worker card verbatim (the title as `role_title`), so
    // they must pass the same screen every API write into `job_postings` runs on them. The
    // dry run lists what fails; `--apply` refuses the whole batch before any write. Ids,
    // fields and screen names only, never the text.
    const textFailures = screenJobTextForConversion(pendingJobs);
    if (textFailures.length > 0) {
      console.log(
        `[${NAME}] ${textFailures.length} field(s) fail the worker-visible free-text screen ` +
          `(phone/email, company name, link). Fix each jobs row (the agency PATCH, or by hand) ` +
          `and re-run:`,
      );
      for (const f of textFailures) {
        console.log(`  ${f.jobId} ${f.field.padEnd(16)} ${f.screens.join(", ")}`);
      }
      if (opts.apply) {
        throw new Error(
          `[${NAME}] REFUSING --apply: ${textFailures.length} field(s) would put text that ` +
            `fails the worker-visible screen into job_postings. Nothing was written.`,
        );
      }
    }

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
            area: j.area,
            payMin: j.payMin,
            payMax: j.payMax,
            // #1648 — what the band MEANS. NULL stays NULL: the converter never invents one.
            payType: j.payType,
            shift: j.shift,
            neededBy: j.neededBy,
            description: j.description,
            minExperienceYears: j.minExperienceYears,
            maxExperienceYears: j.maxExperienceYears,
            benefits: j.benefits,
            requirements: j.requirements,
            // 0131 — the payer's role pick, carried verbatim (NULL stays NULL). DISPLAY ONLY:
            // the match ids below still come from the trade bridge, never from this.
            roleKind: j.roleKind,
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
      "open jobs found": allOpenJobs.length,
      "seed/ops rows (convertible)": openJobs.length,
      "agency rows (never converted)": payerOwned.length,
      "agency rows with no twin": payerOwnedWithoutTwin.length,
      "already converted (no-op)": skippedAlready,
      "to convert": toConvert,
      "postings created": convertedNow,
      "legacy jobs closed": closedNow,
      "org_label used": JSON.stringify(orgLabel),
      "vacancy_band used": bandArg,
      "trades with NO bridge": unbridgedTrades.size,
      "fields failing the text screen": textFailures.length,
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
