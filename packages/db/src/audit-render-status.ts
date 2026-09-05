/**
 * How many resume rows are stuck at render_status 'pending', and for how long. READ-ONLY, ₹0.
 *
 * ===========================================================================================
 * WHY A COUNT OF 'pending' IS A BUG REPORT AND NOT A GAUGE
 * ===========================================================================================
 * A render takes seconds. `POST /resume/generate` writes the row 'pending' and enqueues the
 * job; `ResumeRenderProcessor` picks it up and flips it to 'rendered' or 'failed'. So 'pending'
 * is a state a row should occupy for about as long as it takes WeasyPrint to run — and a row
 * that has been 'pending' for a day is not slow, it is ABANDONED.
 *
 * Until #1399 the abandonment was systematic. The processor's no-PDF path RETURNED instead of
 * throwing, so BullMQ completed the job on attempt 1, `isFinalAttempt` was never true, none of
 * the terminal branches ran, and no retry followed. Every render failure — a missing WeasyPrint
 * binary, a render timeout, a FontResolutionError, a template throw — left its row 'pending'
 * permanently. `enqueueRender` did the same, more quietly: when the queue `add` threw, the catch
 * logged and moved on, leaving a row 'pending' with no job behind it at all.
 *
 * That is why the age buckets below matter more than the totals. #1399 fixed the two writers; it
 * deliberately did NOT backfill, so every row this script reports in the older buckets predates
 * the fix and will stay 'pending' until something forces a re-render (a photo, preference,
 * credential or work-history change) or an ops regenerate.
 *
 * ===========================================================================================
 * WHAT THIS WILL NOT DO
 * ===========================================================================================
 * It does not write, re-enqueue, or repair anything. It cannot tell you WHY a row is stuck —
 * the row records no failure reason, and the BullMQ job that would have carried one completed
 * successfully or was never created. And it cannot distinguish "stuck" from "deliberately
 * parked": while `RESUME_RENDER_ENABLED` is off, every row is 'pending' BY DESIGN and the
 * numbers here mean nothing until it is on. Check the switch before reading the buckets.
 *
 * A 'rendered' row with no document is not a fault either — migration 0095 ADDED
 * `resume_document` as a nullable column and never backfilled it, so no row rendered before it
 * has one. That is why the distribution reports `with_document` separately rather than assuming
 * status and document move together.
 *
 * ===========================================================================================
 * THE AGE BUCKETS MEASURE `generated_at`, WHICH A REGENERATE DOES NOT RESET
 * ===========================================================================================
 * There is no `updated_at` on `generated_resumes` — `generated_at` and `rendered_at` are the
 * only timestamps, and `rendered_at` is null on exactly the rows being aged. But
 * `ResumeRepository.createInitial({overwrite:true})` — the manual `POST /resume/generate` over
 * an existing v1 — sets the row back to 'pending' WITHOUT touching `generated_at`. So a resume
 * regenerated a minute ago, on a row first generated in March, is aged as five months stranded.
 *
 * The report therefore breaks the pending rows out by whether they have EVER rendered
 * (`resume_document IS NOT NULL`, which the overwrite deliberately leaves in place). Those are
 * re-pended rows whose age is unreliable; a row that has never rendered is aged correctly.
 *
 * ===========================================================================================
 * PRIVACY
 * ===========================================================================================
 * Reads exactly four columns of `generated_resumes`: `render_status`, `generated_at`, and the
 * NULL-ness (never the content) of `resume_document` and `pdf_storage_key`. It selects no name,
 * no phone, no worker id, no resume text, no storage key and no document body. Every number
 * that leaves this script is an aggregate over a status column.
 *
 *   pnpm db:audit:render-status
 */
import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { createDbClient } from "./client";

// The repository-root file first, as the other db runners do. `pnpm db:*` runs with
// cwd = packages/db, where a bare `config()` finds nothing, and this runner reads
// DATABASE_URL straight from the environment. dotenv never overwrites an already-set
// variable, so a real environment (CI, a container) still wins.
config({ path: "../../.env" });
config();

const SCRIPT = "audit:render-status";

/** One row of the render_status distribution. */
export interface StatusRow {
  render_status: string;
  rows: number;
  with_document: number;
  with_pdf: number;
}

/** The age histogram of the 'pending' rows, in whole counts. */
export interface PendingAges {
  under_1h: number;
  h1_to_24h: number;
  d1_to_7d: number;
  over_7d: number;
  oldest: Date | null;
  /**
   * Pending rows that have rendered at least once (`resume_document IS NOT NULL`) — i.e. rows a
   * regenerate put back to 'pending'. Their `generated_at` is the ORIGINAL generation, so their
   * bucket overstates how long they have been waiting. Reported so the age columns can be read
   * honestly, not to be subtracted from them.
   */
  re_pended: number;
}

/**
 * How many pending rows are old enough that no ordinary render latency explains them.
 *
 * THE THRESHOLD IS ONE HOUR, and it is deliberately generous. A render is a seconds-scale job
 * even under load and even after three attempts with exponential backoff, so anything past an
 * hour is a row nothing is coming back for. Kept as a pure function so the judgement is
 * assertable without a database — the numbers are the easy part, the line between "slow" and
 * "abandoned" is the part worth pinning.
 */
export function strandedCount(ages: PendingAges): number {
  return ages.h1_to_24h + ages.d1_to_7d + ages.over_7d;
}

/** Right-aligned integer, so the columns line up without a table library. */
function pad(n: number, width: number): string {
  return String(n).padStart(width, " ");
}

async function main(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);

  // Show WHICH database — never credentials.
  const parsed = new URL(url);
  console.log(`[${SCRIPT}] target host=${parsed.hostname} db=${parsed.pathname.slice(1)}`);
  console.log(`[${SCRIPT}] READ-ONLY — no writes, no re-enqueue\n`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    await db.execute(dsql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`);
    const [ro] = (await db.execute(dsql`SHOW default_transaction_read_only`)) as unknown as {
      default_transaction_read_only: string;
    }[];
    if (ro?.default_transaction_read_only !== "on") {
      throw new Error(`[${SCRIPT}] session is not read-only; refusing to measure`);
    }

    // A ZERO FROM A ROLE WITHOUT BYPASSRLS IS NOT EVIDENCE — it is indistinguishable from "not
    // permitted to look", and this script exists to be believed.
    const [who] = (await db.execute(dsql`
      SELECT current_user AS who,
             (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass_rls
    `)) as unknown as { who: string; bypass_rls: boolean }[];
    if (who?.bypass_rls !== true) {
      throw new Error(
        `[${SCRIPT}] role ${who?.who} does not bypass RLS. Every count would be a permission ` +
          `artifact rather than a measurement; refusing to report.`,
      );
    }

    const dist = (await db.execute(dsql`
      SELECT render_status,
             count(*)::int                     AS rows,
             count(resume_document)::int       AS with_document,
             count(pdf_storage_key)::int       AS with_pdf
        FROM generated_resumes
       GROUP BY render_status
       ORDER BY 2 DESC
    `)) as unknown as StatusRow[];

    const total = dist.reduce((n, r) => n + r.rows, 0);
    console.log("render_status distribution");
    if (dist.length === 0) {
      console.log("  (no generated_resumes rows at all)");
    }
    for (const r of dist) {
      console.log(
        `  ${r.render_status.padEnd(9)} ${pad(r.rows, 7)} rows` +
          `   with_document ${pad(r.with_document, 7)}` +
          `   with_pdf ${pad(r.with_pdf, 7)}`,
      );
    }
    console.log(`  ${"total".padEnd(9)} ${pad(total, 7)} rows\n`);

    const [ages] = (await db.execute(dsql`
      SELECT
        count(*) FILTER (WHERE generated_at >= now() - interval '1 hour')::int  AS under_1h,
        count(*) FILTER (WHERE generated_at <  now() - interval '1 hour'
                           AND generated_at >= now() - interval '1 day')::int   AS h1_to_24h,
        count(*) FILTER (WHERE generated_at <  now() - interval '1 day'
                           AND generated_at >= now() - interval '7 days')::int  AS d1_to_7d,
        count(*) FILTER (WHERE generated_at <  now() - interval '7 days')::int  AS over_7d,
        count(*) FILTER (WHERE resume_document IS NOT NULL)::int                 AS re_pended,
        min(generated_at)                                                       AS oldest
      FROM generated_resumes
      WHERE render_status = 'pending'
    `)) as unknown as PendingAges[];

    const a = ages ?? {
      under_1h: 0,
      h1_to_24h: 0,
      d1_to_7d: 0,
      over_7d: 0,
      oldest: null,
      re_pended: 0,
    };
    console.log("pending rows by age");
    console.log(`  under 1 hour   ${pad(a.under_1h, 7)}   (a render in flight looks like this)`);
    console.log(`  1-24 hours     ${pad(a.h1_to_24h, 7)}`);
    console.log(`  1-7 days       ${pad(a.d1_to_7d, 7)}`);
    console.log(`  over 7 days    ${pad(a.over_7d, 7)}`);
    console.log(`  oldest         ${a.oldest ? new Date(a.oldest).toISOString() : "-"}`);
    console.log(
      `  re-pended      ${pad(a.re_pended, 7)}   (regenerated rows — aged from the ORIGINAL\n` +
        `                           generation, since generated_at is not reset; may not be stranded)\n`,
    );

    const stranded = strandedCount(a);
    if (stranded === 0) {
      console.log("✓ No pending row is older than an hour — nothing looks abandoned.");
    } else {
      console.log(
        `⚠ ${stranded} pending row(s) older than an hour. A render is a seconds-scale job, so\n` +
          `  these are not slow, they are stranded. #1399 stopped NEW ones being created; it\n` +
          `  did not backfill these, which was a deliberate scoping decision.\n` +
          `  If RESUME_RENDER_ENABLED is currently off, disregard: every row is pending by design.`,
      );
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
