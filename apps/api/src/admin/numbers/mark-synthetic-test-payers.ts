import { isSyntheticPayerEmail } from "../../payers/payer-test-login.guard";
import type { TestAccountWrite, UnmarkedPayerWithEmail } from "./admin-numbers.repository";

/**
 * #2755 item 2 — THE CORE of the synthetic-sign-in backfill (`mark-synthetic-test-payers.cli.ts`).
 * Kept apart from the CLI so it runs against a fake in the unit tests: the dry run must write
 * nothing, and no email may ever reach a log line.
 *
 * A company whose sign-in email is in the reserved `.invalid` domain (`isSyntheticPayerEmail`, the
 * test-login seam's own rule) is a test sign-in. The email is encrypted at rest, so SQL cannot find
 * these companies: each unmarked company's email is decrypted IN PROCESS, tested, and dropped.
 */
export interface MarkSyntheticTestPayersDeps {
  /** One keyset page of unmarked companies with a sign-in email, in id order after `afterId`. */
  listUnmarked(afterId: string | null, limit: number): Promise<UnmarkedPayerWithEmail[]>;
  /** The sign-in email from its ciphertext. Throws when it cannot be decrypted. */
  decrypt(ciphertext: string): string;
  /** Mark one company `synthetic_sign_in` (row + event, one transaction). Called only on --apply. */
  mark(payerId: string): Promise<TestAccountWrite>;
  /** One output line. Ids and counts only. */
  log(line: string): void;
}

export interface MarkSyntheticTestPayersOptions {
  readonly apply: boolean;
  readonly batchSize: number;
}

export interface MarkSyntheticTestPayersSummary {
  readonly apply: boolean;
  /** Unmarked companies with a sign-in email that were inspected. */
  readonly scanned: number;
  /** Of those, the ones whose email is synthetic. */
  readonly synthetic: number;
  /** Marked by this run (apply), or that would be (dry run). */
  readonly marked: number;
  /** Synthetic, but marked by someone else between the read and the write. */
  readonly alreadyMarked: number;
  /** An email that would not decrypt, or a mark that failed. Never retried silently. */
  readonly failed: number;
  /** The ids marked (or that would be), in id order. */
  readonly ids: readonly string[];
}

export async function markSyntheticTestPayers(
  deps: MarkSyntheticTestPayersDeps,
  opts: MarkSyntheticTestPayersOptions,
): Promise<MarkSyntheticTestPayersSummary> {
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) {
    throw new RangeError("batchSize must be a positive integer");
  }
  let scanned = 0;
  let synthetic = 0;
  let alreadyMarked = 0;
  let failed = 0;
  const ids: string[] = [];
  let afterId: string | null = null;

  for (;;) {
    const page = await deps.listUnmarked(afterId, opts.batchSize);
    if (page.length === 0) break;
    afterId = page[page.length - 1]!.id;

    for (const row of page) {
      scanned += 1;
      let email: string;
      try {
        email = deps.decrypt(row.emailEnc);
      } catch {
        failed += 1;
        deps.log(`  ${row.id} could not decrypt the sign-in email; skipped`);
        continue;
      }
      if (!isSyntheticPayerEmail(email)) continue;
      synthetic += 1;
      if (!opts.apply) {
        ids.push(row.id);
        deps.log(`  ${row.id} would be marked synthetic_sign_in`);
        continue;
      }
      try {
        const out = await deps.mark(row.id);
        if (out === "changed") {
          ids.push(row.id);
          deps.log(`  ${row.id} marked synthetic_sign_in`);
        } else if (out === "unchanged") {
          alreadyMarked += 1;
        } else {
          failed += 1;
          deps.log(`  ${row.id} is gone (deleted between the read and the mark)`);
        }
      } catch (err) {
        failed += 1;
        // The write binds only ids, a boolean and a time, so its message carries no PII.
        deps.log(`  ${row.id} mark FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (page.length < opts.batchSize) break;
  }

  const summary: MarkSyntheticTestPayersSummary = {
    apply: opts.apply,
    scanned,
    synthetic,
    marked: ids.length,
    alreadyMarked,
    failed,
    ids,
  };
  deps.log(
    `  summary: ${opts.apply ? "APPLIED" : "DRY RUN"} scanned=${scanned} synthetic=${synthetic} ` +
      `${opts.apply ? "marked" : "would_mark"}=${ids.length} already_marked=${alreadyMarked} ` +
      `failed=${failed}${opts.apply ? "" : " (nothing written; re-run with --apply)"}`,
  );
  return summary;
}
