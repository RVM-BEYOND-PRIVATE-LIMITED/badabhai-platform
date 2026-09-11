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

  async forWorker(workerId: string): Promise<ReadonlyMap<string, ResumeSuggestion>> {
    const empty = new Map<string, ResumeSuggestion>();
    try {
      // THE MOST RECENT IMPORT, not all of them. A worker who uploads twice has corrected
      // himself, and merging both would resurrect what the second upload was meant to replace.
      const row = await this.imports.findLatestForWorker(workerId);
      if (!row || row.suggestionsEnc === null) return empty;

      const parsed: unknown = JSON.parse(this.crypto.decrypt(row.suggestionsEnc));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

      // VALIDATED ON THE WAY OUT, not trusted because we wrote it. This blob was written by an
      // earlier deploy and will be read by later ones; a shape that has drifted must degrade to
      // "no suggestion" rather than reach the response and fail its own contract on the way to
      // the worker.
      const out = new Map<string, ResumeSuggestion>();
      for (const [questionKey, value] of Object.entries(parsed)) {
        if (isSuggestion(value)) out.set(questionKey, value);
      }
      return out;
    } catch (error) {
      this.logger.warn(
        `résumé suggestions unreadable for worker ${workerId.slice(0, 8)}…; serving the form ` +
          `without them: ${(error as Error).message}`,
      );
      return empty;
    }
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
