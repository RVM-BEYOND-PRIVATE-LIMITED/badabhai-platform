import { Injectable, Logger } from "@nestjs/common";
import type { ResumeImportStatusName } from "@badabhai/types";

import { PiiCryptoService } from "../../common/pii-crypto.service";
import type { EmploymentSuggestion } from "../../profiles/employment-suggestions";
import { ResumeImportRepository } from "./resume-import.repository";
import type { ResumeSuggestion } from "./resume-suggestions";

export type { ResumeSuggestion };

/**
 * The import states whose staged identity line may be served to the chat (#1654).
 *
 * THE OUTCOME STATES, BOTH OF THEM. `parsed` is the ordinary one. `failed` is the D9
 * amendment: two failure reasons are ours rather than the document's, and the summary that
 * ran before the row was settled stands on exactly the text a clean parse would have used.
 *
 * `uploaded` AND `parsing` ARE EXCLUDED and that is not cosmetic — the summary stages WHILE
 * the row is `parsing`, so a row in that state can genuinely carry a line. Serving it would
 * offer the bubble to a client that has not finished polling and is still on the upload
 * screen, and the offer would be spent against a turn nobody saw. `discarded` left the flow.
 */
const IDENTITY_SERVABLE_STATUSES: ReadonlySet<ResumeImportStatusName> =
  new Set<ResumeImportStatusName>(["parsed", "failed"]);

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
   *   - `route === "chat"` — a worker handed to a trade form is meant to settle his résumé's facts
   *     on the form, not here. RI-4 put them BESIDE matching question screens; #1503 (2026-09-15)
   *     removed the universal questions those suggestions target, because the owner ruled that
   *     those facts live on the pages that own them (Preferences, Qualifications, Work History).
   *     THE INTERIM GAP, STATED PLAINLY: until those pages render suggestions (#1504), a
   *     form-routed worker on a current app build sees NO résumé facts — experience, city, salary,
   *     education, availability — anywhere. Only a suggestion keyed to one of his trade pack's
   *     own questions still reaches a screen. This condition is left as it is rather than
   *     re-routing those workers into the chat offer, because that is a routing change the owner
   *     has not ruled on; tracked on #1503/#1504.
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

      const suggestions = this.decodeEnvelope(row.suggestionsEnc).answers;
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

  /**
   * The Hinglish line the CHAT should ask "is this you?" over, or `null` (RI-identity).
   *
   * TWO CONDITIONS, and deliberately NOT the three `pendingForChat` carries:
   *
   *   - the import has REACHED AN OUTCOME — `parsed` or `failed`. An `uploaded` or `parsing`
   *     row is still in flight and the client has not left the upload screen; a `discarded`
   *     one left the flow.
   *   - at least one staged identity column non-null — a judgment of nothing is no bubble.
   *
   * `failed` IS SERVED, AND THE STAGED COLUMNS DO THE REAL GATING (ruling D9 amendment,
   * owner, 2026-09-22, #1654). A worker whose document we read perfectly well, and whose
   * import then failed on OUR model reply (`parse_output_invalid`, `parse_deadline_exceeded`),
   * still gets his line: the summary pipeline stood on exactly the text a clean parse would
   * have stood on. A worker whose DOCUMENT failed — no text layer, encrypted, empty,
   * unsupported, below the OCR floor — cannot reach this branch with anything to show,
   * because `ResumeImportProcessor` never calls the summary for those reasons and nothing
   * else writes those three columns. The closed reason set is NOT repeated here on purpose:
   * two copies of it would be two chances to disagree, and the emptiness of the columns is
   * the stronger statement — it holds even if the set is later widened.
   *
   * NO ROUTE CONDITION, unlike `pendingForChat`'s `route === "chat"`. That gate exists
   * because staged FACTS settle on the form for form-routed workers; the identity question
   * is asked on the chat screen every worker passes through, form-bound or not, and "is
   * this you?" is meaningful before any routing consequence. Narrowing it to one road
   * would silence the turn for exactly the workers whose résumé named a trade.
   *
   * Returns the id ALONGSIDE the line because the caller stores the id, not the line:
   * the envelope must not carry worker-derived prose in clear through Redis.
   */
  async identityForChat(workerId: string): Promise<{
    importId: string;
    roleKind: string | null;
    experienceText: string | null;
    summaryText: string | null;
  } | null> {
    try {
      const row = await this.imports.findLatestForWorker(workerId);
      if (!row || !IDENTITY_SERVABLE_STATUSES.has(row.status)) return null;
      if (
        row.identityRoleKind === null &&
        row.identityExperienceText === null &&
        row.identitySummaryText === null
      ) {
        return null;
      }
      return {
        importId: row.id,
        roleKind: row.identityRoleKind,
        experienceText: row.identityExperienceText,
        summaryText: row.identitySummaryText,
      };
    } catch (error) {
      // SOFT, like every other read here. A worker whose import row is unreadable gets the
      // ordinary interview — which is the interview he would have had with no résumé at all.
      this.logger.warn(
        `résumé identity unavailable for worker ${workerId.slice(0, 8)}…: ` +
          `${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Where one import routed the worker, by id (RI-identity handover).
   *
   * WHAT THIS IS FOR AND ONLY THIS: the identity "haan" must hand a form-routed worker
   * to the form the import already settled — otherwise the "yes" would strand the route
   * the router decided. Route and form kind only: no storage key, no mime, no document,
   * no suggestions — the narrowest read that can answer "which form, if any".
   *
   * A FAILED IMPORT ANSWERS `route: null`, AND THAT IS THE RULED BEHAVIOUR (#1654). The D9
   * amendment lets the identity turn appear over a failed import, so "Haan" can now be tapped
   * on one — and a failed row never settled a route, so `routeForImport` yields no handover,
   * the identity-answered event is still recorded, and the worker falls through to ordinary
   * selection in the same bubble. No crash, no stranded route, and NO consolation path: the
   * owner ruled that the tap simply has no visible consequence. Do not invent one here.
   */
  async routeForImport(
    workerId: string,
    importId: string,
  ): Promise<{ route: string | null; formKind: string | null } | null> {
    try {
      const row = await this.imports.findForWorker(importId, workerId);
      // WORKER-SCOPED, like every read on that repository — see `forImport` above.
      if (!row) return null;
      return { route: row.route, formKind: row.formKind };
    } catch (error) {
      this.logger.warn(
        `résumé route unreadable for import ${importId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The staged option mappings for one specific import, by id (RI-autofill).
   *
   * WHAT THIS IS FOR AND ONLY THIS: the identity "haan" applies these as the
   * worker's form answers (owner override B). Closed ids only — the envelope never
   * carried prose or spans, so there is nothing here to decrypt beyond the ids.
   * SOFT, on the same terms as every other read here: an unreadable row applies
   * nothing and the Haan hands over to an unfilled form.
   */
  async mappedOptionsForImport(
    workerId: string,
    importId: string,
  ): Promise<readonly StagedOptionMapping[]> {
    try {
      const row = await this.imports.findForWorker(importId, workerId);
      // WORKER-SCOPED, like every read on that repository — see `forImport` above.
      if (!row) return [];
      return this.decodeEnvelope(row.suggestionsEnc).optionMap;
    } catch (error) {
      this.logger.warn(
        `résumé option mappings unreadable for import ${importId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /** The suggestions staged against one specific import, by id. */
  async forImport(
    workerId: string,
    importId: string,
  ): Promise<ReadonlyMap<string, ResumeSuggestion>> {
    try {
      const row = await this.imports.findForWorker(importId, workerId);
      // WORKER-SCOPED, like every read on that repository. An id from an envelope is still an id
      // from outside this class, and there is no method here that could fetch another worker's
      // row even if one were somehow supplied.
      if (!row) return new Map();
      return this.decodeEnvelope(row.suggestionsEnc).answers;
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
      return row ? this.decodeEnvelope(row.suggestionsEnc).answers : empty;
    } catch (error) {
      this.logger.warn(
        `résumé suggestions unreadable for worker ${workerId.slice(0, 8)}…; serving the form ` +
          `without them: ${(error as Error).message}`,
      );
      return empty;
    }
  }

  /**
   * The employments a worker's most recent résumé parsed out, as Work History suggestions.
   *
   * THE ONE METHOD THAT READS THE ENVELOPE'S OTHER HALF. `forWorker`/`forImport`/`pendingForChat`
   * exist for the pack-question form and never needed `employments` — this is the sole caller
   * `WorkerEmploymentService.getForWorker` (#1504's edit page) reaches for résumé-sourced rows.
   * SOFT, on the same terms as every other read here: a worker whose import row is unreadable
   * gets the page with no résumé suggestion, never a 500.
   */
  async employmentSuggestionsForWorker(workerId: string): Promise<readonly EmploymentSuggestion[]> {
    try {
      const row = await this.imports.findLatestForWorker(workerId);
      return row ? this.decodeEnvelope(row.suggestionsEnc).employments : [];
    } catch (error) {
      this.logger.warn(
        `résumé employment suggestions unreadable for worker ${workerId.slice(0, 8)}…; serving ` +
          `the page without them: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * One encrypted column → validated suggestions, of both kinds it may carry.
   *
   * VALIDATED ON THE WAY OUT, not trusted because we wrote it. This blob was written by an
   * earlier deploy and will be read by later ones; a shape that has drifted must degrade to "no
   * suggestion" rather than reach a response and fail its own contract in front of the worker.
   *
   * TWO ENVELOPE SHAPES, TOLD APART BY ONE KEY. Every row written before employment suggestions
   * shipped is the FLAT `{ question_key: ResumeSuggestion }` map this column has always held —
   * `ResumeRouteService` used to encrypt `Object.fromEntries(suggestions)` directly, with no
   * wrapper. A row written after carries `{ answers: {...}, employments: [...] }` instead.
   * `"answers" in record` distinguishes them: a legacy flat map would have to declare a pack
   * question literally keyed `"answers"` to be misread here, and no pack ever has.
   *
   * SHARED BY EVERY READER ON PURPOSE — the form's, the chat offer's, the by-id one and the
   * employment page's. Separate copies of this validation would be separate chances for one of
   * them to accept a shape the others reject, and the one that accepted it would ship it onward.
   */
  private decodeEnvelope(token: string | null): {
    readonly answers: ReadonlyMap<string, ResumeSuggestion>;
    readonly employments: readonly EmploymentSuggestion[];
    readonly optionMap: readonly StagedOptionMapping[];
  } {
    const answers = new Map<string, ResumeSuggestion>();
    const employments: EmploymentSuggestion[] = [];
    const optionMap: StagedOptionMapping[] = [];
    if (token === null) return { answers, employments, optionMap };

    const parsed: unknown = JSON.parse(this.crypto.decrypt(token));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { answers, employments, optionMap };
    }
    const record = parsed as Record<string, unknown>;

    const answersSource =
      "answers" in record && typeof record.answers === "object" && record.answers !== null
        ? (record.answers as Record<string, unknown>)
        : record;
    for (const [questionKey, value] of Object.entries(answersSource)) {
      if (isSuggestion(value)) answers.set(questionKey, value);
    }

    if (Array.isArray(record.employments)) {
      for (const value of record.employments) {
        if (isEmploymentSuggestion(value)) employments.push(value);
      }
    }

    // The third envelope shape (RI-autofill). Rows predating the mapping carry no
    // `option_map` key and read as empty — additive, not a migration. Each entry is
    // re-validated: a blob written by an earlier deploy that drifted degrades to
    // "no mappings" rather than reaching a write.
    if (Array.isArray(record.option_map)) {
      for (const value of record.option_map) {
        const staged = toStagedOptionMapping(value);
        if (staged) optionMap.push(staged);
      }
    }
    return { answers, employments, optionMap };
  }
}

/** One staged option mapping: closed ids for one pack question. */
export interface StagedOptionMapping {
  readonly questionKey: string;
  readonly optionKeys: readonly string[];
}

/**
 * Wire shape → staged mapping, or null.
 *
 * The envelope speaks snake_case (`question_key`, `option_keys`) — the same convention
 * `answers` (`option_keys`) and `employments` (`employer_name`) already keep — while
 * TypeScript callers read camelCase. Validating AND remapping in one function keeps the
 * wire convention in exactly one place: a blob that drifted degrades to "no mapping"
 * rather than reaching a write.
 */
function toStagedOptionMapping(value: unknown): StagedOptionMapping | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<{
    question_key: unknown;
    option_keys: unknown;
  }>;
  if (typeof candidate.question_key !== "string" || candidate.question_key.length === 0) {
    return null;
  }
  if (!Array.isArray(candidate.option_keys) || candidate.option_keys.length === 0) return null;
  if (!candidate.option_keys.every((k): k is string => typeof k === "string" && k.length > 0)) {
    return null;
  }
  return { questionKey: candidate.question_key, optionKeys: [...candidate.option_keys] };
}

function isEmploymentSuggestion(value: unknown): value is EmploymentSuggestion {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<EmploymentSuggestion>;
  if (candidate.source !== "resume" && candidate.source !== "chat") return false;
  const values = candidate.values as Partial<EmploymentSuggestion["values"]> | undefined;
  if (values === undefined || values === null || typeof values !== "object") return false;
  const fields: readonly (keyof EmploymentSuggestion["values"])[] = [
    "employer_name",
    "employer_city",
    "role_label",
    "start_ym",
    "end_ym",
    "work_done",
  ];
  return fields.every((field) => values[field] === null || typeof values[field] === "string");
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
