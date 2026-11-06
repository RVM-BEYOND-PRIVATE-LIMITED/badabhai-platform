/**
 * B2 (#2555) — cost-ledger backfill: stamp historical completions from the event spine.
 *
 * Fills `profile_completion_ledger` from `profile.extraction_completed` events —
 * one row per finished profile, with the test flag resolved the same way the live
 * writer resolves it:
 *
 *   * worker row still present → its `is_test_account`;
 *   * worker row gone + a `worker.test_login` event for that worker → true
 *     (the test seam mints ONLY for the synthetic range, so the event IS the
 *     re-tag — no phone, no hash, no decryption of anything);
 *   * worker row gone + no test-login event → false (a real account that OTP'd).
 *
 * IDEMPOTENT: rows are keyed on `profile_id`; existing rows are skipped, never
 * rewritten. Re-running reports the same counts with zero writes. DRY-RUN IS THE
 * DEFAULT; `--apply` writes.
 *
 * PRIVACY: opaque ids + a boolean + timestamps only. No PII is read or printed.
 * The `worker.test_login` check reads the event NAME and subject, never the payload.
 *
 *   pnpm db:backfill:cost-ledger            # dry run + counts
 *   pnpm db:backfill:cost-ledger --apply    # write
 */
import { config } from "dotenv";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";

import { createDbClient, type Database } from "./client";
import { enforceOpsGuard } from "./ops-guard";
import { aiJobs, events, profileCompletionLedger, workers } from "./schema";

config({ path: "../../.env" });

const NAME = "backfill:cost-ledger";

/**
 * The completed statuses, mirrored by VALUE from `PROFILE_COMPLETED_STATUSES`
 * (admin-dashboard.dto) — packages/db cannot import apps/api, and the backfill must
 * filter the spine on the same positive set the dashboard's denominator documents.
 * Drafts produced nothing; `extracting` is in flight.
 */
const COMPLETED_STATUSES = ["extracted", "confirmed"] as const;

export interface CostLedgerBackfillPlan {
  /** Rows that would be / were inserted: profile_id → the stamped row. */
  readonly rows: ReadonlyArray<{
    profileId: string;
    chatSessionId: string | null;
    aiJobId: string | null;
    workerId: string | null;
    completedAt: Date;
    isTestAccount: boolean;
  }>;
  /** profile_ids that already have a ledger row — skipped, never rewritten. */
  readonly skipped: number;
  /** Of `rows`: completions whose worker is gone and were re-tagged TEST. */
  readonly retaggedDeletedTest: number;
  /** Of `rows`: completions whose worker is gone and were re-tagged REAL. */
  readonly retaggedDeletedReal: number;
}

/**
 * Plan the backfill: read the spine, resolve every flag, diff against the ledger.
 * Pure read — safe to run anywhere, including production (dry run).
 */
export async function planCostLedgerBackfill(
  db: Database,
  limit = 5000,
): Promise<CostLedgerBackfillPlan> {
  const completions = await db
    .select({
      profileId: dsql<string>`${events.payload}->>'profile_id'`,
      workerId: dsql<string>`${events.payload}->>'worker_id'`,
      aiJobId: dsql<string>`${events.payload}->>'ai_job_id'`,
      status: dsql<string>`${events.payload}->>'profile_status'`,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .where(
      and(
        eq(events.eventName, "profile.extraction_completed"),
        inArray(dsql<string>`${events.payload}->>'profile_status'`, [...COMPLETED_STATUSES]),
      ),
    )
    .orderBy(events.occurredAt, events.id)
    .limit(limit);

  const existing = new Set(
    (
      await db
        .select({ profileId: profileCompletionLedger.profileId })
        .from(profileCompletionLedger)
    ).map((r) => r.profileId),
  );

  const rows: Array<{
    profileId: string;
    chatSessionId: string | null;
    aiJobId: string | null;
    workerId: string | null;
    completedAt: Date;
    isTestAccount: boolean;
  }> = [];
  let skipped = 0;
  let retaggedDeletedTest = 0;
  let retaggedDeletedReal = 0;

  for (const c of completions) {
    if (!c.profileId || existing.has(c.profileId)) {
      skipped += 1;
      continue;
    }
    // The live flag when the worker row survives; the test-login re-tag when it does
    // not. One indexed PK read, and the EXISTS only fires on the deleted path.
    let isTestAccount: boolean;
    let workerGone = false;
    if (c.workerId) {
      const live = await db
        .select({ isTestAccount: workers.isTestAccount })
        .from(workers)
        .where(eq(workers.id, c.workerId))
        .limit(1);
      if (live.length > 0) {
        isTestAccount = live[0]!.isTestAccount;
      } else {
        workerGone = true;
        const seen = await db
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.subjectType, "worker"),
              eq(events.subjectId, c.workerId),
              eq(events.eventName, "worker.test_login"),
            ),
          )
          .limit(1);
        isTestAccount = seen.length > 0;
      }
    } else {
      isTestAccount = false;
    }
    if (workerGone) {
      if (isTestAccount) retaggedDeletedTest += 1;
      else retaggedDeletedReal += 1;
    }
    // The session behind the completion, best-effort via the extraction job's
    // input_ref (the event itself names none — same join the old cost read used).
    // NULL when unresolvable: the denominator counts workers, never sessions, so a
    // miss costs nothing and is honest.
    let chatSessionId: string | null = null;
    if (c.aiJobId) {
      const job = await db
        .select({ sessionId: dsql<string>`${aiJobs.inputRef}->>'session_id'` })
        .from(aiJobs)
        .where(eq(aiJobs.id, c.aiJobId))
        .limit(1);
      const sid = job[0]?.sessionId;
      chatSessionId = typeof sid === "string" && sid.length > 0 ? sid : null;
    }
    rows.push({
      profileId: c.profileId,
      chatSessionId,
      aiJobId: c.aiJobId,
      workerId: c.workerId,
      completedAt: new Date(c.occurredAt),
      isTestAccount,
    });
  }

  return { rows, skipped, retaggedDeletedTest, retaggedDeletedReal };
}

/**
 * Write a plan's rows. `ON CONFLICT (profile_id) DO NOTHING` — a concurrent live
 * extraction that landed the same profile wins, and this write degrades to a skip.
 * Returns the number actually inserted.
 */
export async function applyCostLedgerBackfill(
  db: Database,
  plan: CostLedgerBackfillPlan,
): Promise<number> {
  let inserted = 0;
  for (const r of plan.rows) {
    const done = await db
      .insert(profileCompletionLedger)
      .values({
        profileId: r.profileId,
        chatSessionId: r.chatSessionId,
        aiJobId: r.aiJobId,
        workerId: r.workerId,
        completedAt: r.completedAt,
        isTestAccount: r.isTestAccount,
        source: "backfill",
      })
      .onConflictDoNothing({ target: profileCompletionLedger.profileId })
      .returning({ profileId: profileCompletionLedger.profileId });
    inserted += done.length;
  }
  return inserted;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  // The target decides, not NODE_ENV: a mutating run against a production-like target
  // needs the dual authorisation; a dry run is always allowed (that is how an operator
  // learns what it would do).
  const { connectionString: databaseUrl } = enforceOpsGuard({
    script: NAME,
    connectionString: process.env.DATABASE_URL,
    mutating: apply,
  });
  const { db, sql } = createDbClient(databaseUrl, { max: 1 });
  try {
    const plan = await planCostLedgerBackfill(db);
    const inserted = apply ? await applyCostLedgerBackfill(db, plan) : 0;
    console.log(
      `[${NAME}] ${apply ? "APPLIED" : "DRY RUN (no writes). Re-run with --apply to write."}`,
    );
    console.log(
      `  completions: scanned=${plan.rows.length + plan.skipped} ` +
        `inserted=${apply ? inserted : plan.rows.length} skipped_existing=${plan.skipped}`,
    );
    console.log(
      `  re-tagged deleted accounts: test=${plan.retaggedDeletedTest} real=${plan.retaggedDeletedReal}`,
    );
    if (!apply) {
      console.log(`  (dry run — ${plan.rows.length} row(s) would be written with --apply)`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run the writer when invoked directly (so importing this module in tests is side-effect-free).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /backfill-0159-cost-ledger\.ts$/.test(process.argv[1] ?? "");
if (invokedDirectly) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${NAME}] failed:`, err);
    process.exit(1);
  });
}
