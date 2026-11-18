/**
 * #2754 item 9 (second half) — convert each company's unused Campus balance into BadaBhai credits.
 *
 * One unused-plan line of the bundle becomes, at most, ONE credit lot (`credit_lots.source =
 * 'migrated'`) and ONE ledger line (`reason = 'campus_conversion'`), keyed
 * `campus_conversion:<line key>` (the bundle's stable `key`). The wallet helper checks the key under
 * the wallet lock, so a second run — of this batch or any other — adds nothing.
 *
 * ONE TRANSACTION PER LINE: the lot, the ledger line and the import ledger row commit together.
 *
 * The rules are `decideBalance` (mapping.ts): unused CV views convert one for one; a paid plan never
 * posted converts its quota from `--plan-quota`; the free tier and a never-registered payment do not
 * convert. A line of a company the import did not place converts nothing either.
 *
 * VALIDITY. #2754's default is "the remaining days of the Campus plan job, never less than 30 days
 * from move day". Bundle format v1 carries no plan expiry, so every converted lot gets the same
 * `validityDays` (`--credit-validity-days`, default 30, never below 30) until Campus adds it.
 */
import { grantCreditsWithinTx, type Database } from "@badabhai/db";
import type { CampusBundle } from "./bundle.schema";
import { decideBalance } from "./mapping";
import { lockRow, writeRow, FINISHED_STATES, type OpenBatch } from "./import-ledger.repository";

/** The floor of a converted lot's validity (#2754 Money defaults). */
export const MIN_CONVERTED_VALIDITY_DAYS = 30;

export function campusConversionKey(lineKey: string): string {
  return `campus_conversion:${lineKey}`;
}

export interface BalanceImportOptions {
  planQuota: Readonly<Record<string, number>>;
  validityDays: number;
}

export interface BalanceImportSummary {
  converted: number;
  credits: number;
  alreadyDone: number;
  notConverted: Record<string, number>;
}

const bump = (tally: Record<string, number>, key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};

export async function importBalances(
  db: Database,
  batch: OpenBatch,
  bundle: CampusBundle,
  placed: ReadonlyMap<string, string>,
  opts: BalanceImportOptions,
): Promise<BalanceImportSummary> {
  if (!Number.isInteger(opts.validityDays) || opts.validityDays < MIN_CONVERTED_VALIDITY_DAYS) {
    throw new RangeError(`validityDays must be a whole number of at least ${MIN_CONVERTED_VALIDITY_DAYS}`);
  }
  const summary: BalanceImportSummary = { converted: 0, credits: 0, alreadyDone: 0, notConverted: {} };

  for (const line of bundle.unusedPlans) {
    await db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const prior = await lockRow(tx, "balance", line.key);
      if (prior && FINISHED_STATES.has(prior.state)) {
        summary.alreadyDone += 1;
        return;
      }
      const companySourceId = line.company_source_id ?? null;
      const row = (state: "created" | "skipped" | "exception", targetId: string | null, reason: string | null, detail: Record<string, unknown>) =>
        writeRow(tx, { batchId: batch.id, kind: "balance", sourceId: line.key, companySourceId, state, targetId, reason, detail });

      const decision = decideBalance(line, opts.planQuota);
      const detail: Record<string, unknown> = { line: line.line, plan_code: line.plan_code ?? null };
      if (!decision.convert) {
        await row(decision.reason === "plan_quota_unknown" ? "exception" : "skipped", null, decision.reason, detail);
        bump(summary.notConverted, decision.reason);
        return;
      }
      const payerId = companySourceId ? placed.get(companySourceId) : undefined;
      if (payerId === undefined) {
        await row("skipped", null, "company_not_placed", detail);
        bump(summary.notConverted, "company_not_placed");
        return;
      }
      const result = await grantCreditsWithinTx(tx, {
        payerId,
        credits: decision.credits,
        lot: { source: "migrated", validityDays: opts.validityDays, isTest: batch.isTest },
        ledger: { reason: "campus_conversion", idempotencyKey: campusConversionKey(line.key) },
      });
      if (!result.applied) {
        // The key is already on the ledger from a run whose import row was lost: count it, never
        // grant twice. There is no lot id to name, so the row stays an exception for a person.
        await row("exception", null, "conversion_key_already_used", detail);
        bump(summary.notConverted, "conversion_key_already_used");
        return;
      }
      await row("created", result.lotId, null, {
        ...detail,
        credits: decision.credits,
        validity_days: opts.validityDays,
        payer_id: payerId,
      });
      summary.converted += 1;
      summary.credits += decision.credits;
    });
  }
  return summary;
}
