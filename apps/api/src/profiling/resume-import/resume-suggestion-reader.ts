import { Injectable, Logger } from "@nestjs/common";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import { ResumeImportRepository } from "./resume-import.repository";
import type { ResumeSuggestion } from "./resume-suggestions";

export type { ResumeSuggestion };

/**
 * What a worker's most recent résumé suggested, decrypted for one request and then forgotten
 * (ADR-0041 RI-4).
 *
 * ── A SEPARATE CLASS, AND THAT IS THE POINT ──────────────────────────────────────────────
 *
 * `TradeFormService` needs exactly one fact from the résumé feature — what it suggested — and
 * giving it the repository would give it the storage key, the mime, the byte size and the
 * ability to write. This narrows the surface to a single read that cannot say anything else,
 * so the form module never grows a reason to know a document exists.
 *
 * ── EVERY FAILURE IS SOFT, AND THE REASON IS NOT POLITENESS ──────────────────────────────
 *
 * The form is the worker's actual task; a suggestion is a convenience beside it. A row that
 * will not decrypt — a key rotated without its backfill, a payload written by an older shape —
 * must cost him the convenience and never the form. Ruling D9 sets that posture for every
 * other path in this feature and there is no reason for this one to be the exception.
 *
 * The failure is LOGGED, because a decrypt that stops working is a real defect and silence
 * would make it invisible: the worker simply sees an empty form and reports nothing.
 */
@Injectable()
export class ResumeSuggestionReader {
  private readonly logger = new Logger(ResumeSuggestionReader.name);

  constructor(
    private readonly imports: ResumeImportRepository,
    private readonly crypto: PiiCryptoService,
  ) {}

  /**
   * The import whose facts the CHAT should offer to confirm, or `null` (ADR-0041 RI-5).
   *
   * THREE CONDITIONS, ALL REQUIRED, and each rules out a different wrong offer:
   *
   *   - `status === "parsed"` — an import still being read has nothing to show, and a FAILED one
   *     has nothing to show ever.
   *   - `route === "chat"` — a worker handed to a trade form sees his suggestions BESIDE the
   *     questions (RI-4). Offering them here as well would ask him to confirm the same facts
   *     twice, once blind and once in context.
   *   - a non-empty payload — an offer with nothing in it is a spent ask that asks nothing.
   *
   * Returns the id ALONGSIDE the suggestions because the caller stores the id, not the facts:
   * the envelope must not carry a worker's trade, city and salary in clear through Redis.
   */
  async pendingForChat(
    workerId: string,
  ): Promise<{ importId: string; suggestions: ReadonlyMap<string, ResumeSuggestion> } | null> {
    try {
      const row = await this.imports.findLatestForWorker(workerId);
      if (!row || row.status !== "parsed" || row.route !== "chat") return null;

      const suggestions = this.decode(row.suggestionsEnc);
      return suggestions.size > 0 ? { importId: row.id, suggestions } : null;
    } catch (error) {
      // SOFT, like every other read here. A worker whose import row is unreadable gets the
      // ordinary interview — which is the interview he would have had with no résumé at all.
      this.logger.warn(
        `résumé confirm offer unavailable for worker ${workerId.slice(0, 8)}…: ` +
          `${(error as Error).message}`,
      );
      return null;
    }
  }

  /** The suggestions staged against one specific import, by id. */
  async forImport(workerId: string, importId: string): Promise<ReadonlyMap<string, ResumeSuggestion>> {
    try {
      const row = await this.imports.findForWorker(importId, workerId);
      // WORKER-SCOPED, like every read on that repository. An id from an envelope is still an id
      // from outside this class, and there is no method here that could fetch another worker's
      // row even if one were somehow supplied.
      if (!row) return new Map();
      return this.decode(row.suggestionsEnc);
    } catch (error) {
      this.logger.warn(
        `résumé suggestions unreadable for import ${importId}: ${(error as Error).message}`,
      );
      return new Map();
    }
  }

  async forWorker(workerId: string): Promise<ReadonlyMap<string, ResumeSuggestion>> {
    const empty = new Map<string, ResumeSuggestion>();
    try {
      // THE MOST RECENT IMPORT, not all of them. A worker who uploads twice has corrected
      // himself, and merging both would resurrect what the second upload was meant to replace.
      const row = await this.imports.findLatestForWorker(workerId);
      return row ? this.decode(row.suggestionsEnc) : empty;
    } catch (error) {
      this.logger.warn(
        `résumé suggestions unreadable for worker ${workerId.slice(0, 8)}…; serving the form ` +
          `without them: ${(error as Error).message}`,
      );
      return empty;
    }
  }

  /**
   * One encrypted column → validated suggestions.
   *
   * VALIDATED ON THE WAY OUT, not trusted because we wrote it. This blob was written by an
   * earlier deploy and will be read by later ones; a shape that has drifted must degrade to "no
   * suggestion" rather than reach a response and fail its own contract in front of the worker.
   *
   * SHARED BY ALL THREE READERS ON PURPOSE — the form's, the chat offer's and the by-id one.
   * Three copies of this validation would be three chances for one of them to accept a shape
   * the others reject, and the one that accepted it would be the one that shipped it onward.
   */
  private decode(token: string | null): ReadonlyMap<string, ResumeSuggestion> {
    const out = new Map<string, ResumeSuggestion>();
    if (token === null) return out;

    const parsed: unknown = JSON.parse(this.crypto.decrypt(token));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [questionKey, value] of Object.entries(parsed)) {
      if (isSuggestion(value)) out.set(questionKey, value);
    }
    return out;
  }
}

function isSuggestion(value: unknown): value is ResumeSuggestion {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ResumeSuggestion>;
  if (candidate.source !== "resume") return false;
  if (typeof candidate.confidence !== "number") return false;
  const values = candidate.values;
  if (values === undefined || values === null || typeof values !== "object") return false;
  return Array.isArray(values.option_keys);
}
