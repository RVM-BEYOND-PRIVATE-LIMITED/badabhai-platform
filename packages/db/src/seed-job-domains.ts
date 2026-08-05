/**
 * Job-domain catalog seed (migration 0066) — loads packages/db/data/job-domains/*.jsonl
 * into `job_domain` + `job_domain_alias` (embedding = NULL).
 *
 *   pnpm db:seed:domains              # DRY RUN — plans and prints, writes nothing
 *   pnpm db:seed:domains --apply      # writes
 *
 * GUARDS come from the shared `match-v1-cli` harness rather than being re-implemented
 * here, which is the point of that file: dry-run is the DEFAULT, production needs the
 * explicit confirm token, and DATABASE_URL must be set with NO localhost fallback. A
 * seed of thousands of reference rows pointed at the wrong database is exactly the
 * failure that harness exists to prevent.
 *
 * IDEMPOTENT, and specifically embedding-safe:
 *   - domains upsert on the immutable `job_domain_id` (labels/level/selectable
 *     propagate; the id never changes — SG-5 discipline, same as `skill`);
 *   - aliases use a DETERMINISTIC id from (job_domain_id, text, lang) with
 *     ON CONFLICT DO NOTHING, so a re-run never clobbers a vector that
 *     `pnpm db:embed:domains` already paid a real provider call for.
 * Double-run => identical row counts and zero embeddings lost.
 *
 * TWO PASSES, and the reason is structural, not stylistic. `job_domain.parent_job_domain_id`
 * is a SELF-FK, so a level-4 row inserted before its level-3 parent would fail the FK.
 * Pass 1 writes every row with a NULL parent; pass 2 sets the pointers once all rows
 * exist. This is the same split `seed-skills.ts` makes for `replaced_by`.
 *
 * NOT embeddings: `job_domain_alias.embedding` stays NULL here. Run
 * `pnpm db:embed:domains` afterwards — it is a separate, gated, resumable call.
 *
 * PRIVACY: published occupation reference data. No worker PII anywhere, and every log
 * line is ids + counts (printCounts is the only logging helper for that reason).
 */
import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { deterministicJobDomainAliasId as aliasId } from "./job-domain-alias-id";
import { resolveJobDomainCorpus, summariseCorpus, type ResolvedJobDomain } from "./job-domain-corpus";
import { parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";
import { jobDomainAliases, jobDomains } from "./schema";

const SCRIPT = "seed:domains";

/** Multi-row inserts. One-row-at-a-time (what seed-skills does for 48 skills) is minutes
 *  of round-trips at corpus scale, so the batch is not a micro-optimisation. */
const CHUNK = 500;

function chunked<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const opts = parseCommonCli(SCRIPT);
  printHeader(SCRIPT, opts);

  // Never seed an invalid corpus. Throws with EVERY problem listed, not just the first —
  // a truncated scrape produces orphans in families and fixing them one run at a time is
  // miserable.
  const corpus = resolveJobDomainCorpus();
  const summary = summariseCorpus(corpus);
  printCounts(SCRIPT, { ...summary });

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    // What is already there? Drives an honest dry-run delta instead of reporting the
    // corpus size as though every row were new.
    const existing = await db.select({ id: jobDomains.jobDomainId }).from(jobDomains);
    const existingIds = new Set(existing.map((r) => r.id));
    const toInsert = corpus.filter((r) => !existingIds.has(r.jobDomainId)).length;
    const toUpdate = corpus.length - toInsert;

    const aliasRows = corpus.flatMap((r) =>
      (r.aliases ?? []).map((a) => ({
        id: aliasId(r.jobDomainId, a.text, a.lang),
        jobDomainId: r.jobDomainId,
        text: a.text,
        lang: a.lang,
        source: a.source,
        // embedding stays NULL — `pnpm db:embed:domains` fills it.
      })),
    );

    printCounts(SCRIPT, {
      domains_new: toInsert,
      domains_existing: toUpdate,
      alias_rows_offered: aliasRows.length,
      parents_to_link: corpus.filter((r) => r.parentJobDomainId).length,
    });

    if (!opts.apply) {
      printFooter(SCRIPT, opts, toInsert + toUpdate + aliasRows.length);
      return;
    }

    const now = new Date();

    // ── PASS 1: every domain row, parent DELIBERATELY NULL ────────────────────
    // A level-4 row inserted before its level-3 parent violates the self-FK. Pass 2
    // links them once every row exists.
    let domainWrites = 0;
    for (const chunk of chunked(corpus, CHUNK)) {
      await db
        .insert(jobDomains)
        .values(
          chunk.map((r: ResolvedJobDomain) => ({
            jobDomainId: r.jobDomainId,
            labelEn: r.label_en,
            labelHi: r.label_hi,
            descriptionEn: r.description_en,
            source: r.source,
            sourceCode: r.code,
            level: r.level,
            parentJobDomainId: null,
            iscoMajorCode: r.isco_major,
            iscoUnitCode: r.isco_unit,
            skillLevel: r.skill_level,
            industryId: r.industry_id,
            canonicalRoleId: r.canonical_role_id,
            selectable: r.selectable,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: jobDomains.jobDomainId,
          set: {
            labelEn: dsql`excluded.label_en`,
            labelHi: dsql`excluded.label_hi`,
            descriptionEn: dsql`excluded.description_en`,
            source: dsql`excluded.source`,
            sourceCode: dsql`excluded.source_code`,
            level: dsql`excluded.level`,
            iscoMajorCode: dsql`excluded.isco_major_code`,
            iscoUnitCode: dsql`excluded.isco_unit_code`,
            skillLevel: dsql`excluded.skill_level`,
            industryId: dsql`excluded.industry_id`,
            canonicalRoleId: dsql`excluded.canonical_role_id`,
            selectable: dsql`excluded.selectable`,
            updatedAt: now,
            // parent_job_domain_id is NOT propagated here — pass 2 owns it.
          },
        });
      domainWrites += chunk.length;
    }

    // ── PASS 2: link parents, now that every row exists ───────────────────────
    // IS DISTINCT FROM keeps a re-run a genuine no-op rather than a rewrite of every row.
    let parentLinks = 0;
    const withParents = corpus.filter((r) => r.parentJobDomainId);
    for (const chunk of chunked(withParents, CHUNK)) {
      const pairs = dsql.join(
        chunk.map((r) => dsql`(${r.jobDomainId}, ${r.parentJobDomainId})`),
        dsql`, `,
      );
      // `updated_at` is bound as an ISO STRING with an explicit cast, never as the Date
      // object. Drizzle's typed insert in pass 1 can serialize a Date because it knows
      // the column type; a RAW statement does not, so postgres.js is handed a Date it
      // cannot encode and the pass dies with a bare ERR_INVALID_ARG_TYPE out of
      // Buffer.byteLength — no mention of the column, the value, or this line. Same
      // `now` as pass 1, so one run still stamps one timestamp.
      const res = await db.execute(dsql`
        UPDATE "job_domain" AS d
           SET "parent_job_domain_id" = v.parent_id,
               "updated_at" = ${now.toISOString()}::timestamptz
          FROM (VALUES ${pairs}) AS v(id, parent_id)
         WHERE d."job_domain_id" = v.id
           AND d."parent_job_domain_id" IS DISTINCT FROM v.parent_id
      `);
      parentLinks += Number((res as unknown as { count?: number }).count ?? 0);
    }

    // ── Aliases — deterministic id + DO NOTHING (idempotent, embedding-safe) ──
    let aliasWrites = 0;
    for (const chunk of chunked(aliasRows, CHUNK)) {
      await db.insert(jobDomainAliases).values(chunk).onConflictDoNothing({
        target: jobDomainAliases.id,
      });
      aliasWrites += chunk.length;
    }

    printCounts(SCRIPT, {
      domains_written: domainWrites,
      parents_linked: parentLinks,
      alias_rows_offered: aliasWrites,
    });
    console.log(
      `[${SCRIPT}] embeddings are NULL — run 'pnpm db:embed:domains' next, ` +
        `then 'pnpm db:verify:domains' as the gate.`,
    );
    printFooter(SCRIPT, opts, domainWrites + parentLinks + aliasWrites);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${SCRIPT}] failed:`, err);
  process.exit(1);
});
