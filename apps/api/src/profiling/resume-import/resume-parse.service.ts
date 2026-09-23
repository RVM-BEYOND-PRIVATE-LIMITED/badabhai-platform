import { Injectable, Logger } from "@nestjs/common";
import type { ResumeEmployment, TargetField } from "@badabhai/ai-contracts";
import type { ParsedField } from "@badabhai/ai-contracts";
import {
  RESUME_DEGRADED_POSTURES,
  RESUME_EXTRACTION_METHODS,
  TRADE_FORM_KINDS_ALL,
  type ResumeDegradedPostureName,
  type ResumeExtractionMethodName,
  type ResumeImportFailureName,
  type TradeFormKindName,
} from "@badabhai/types";

import { AiService } from "../../ai/ai.service";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { EventsService } from "../../events/events.service";
import type { RequestContext } from "../../common/request-context";
import { ResumeImportRepository } from "./resume-import.repository";
import { RESUME_PARSE_TARGET_FIELDS } from "./resume-parse-fields";
import { applyResumeParseGates, filterEmployments } from "./resume-parse-gates";

/**
 * Drive one résumé import through the AI service and the second wall (ADR-0041 RI-3).
 *
 * WHAT THIS PHASE OWNS AND WHAT IT DELIBERATELY DOES NOT. This service gets a document read
 * and the result gated. It does NOT decide where the worker goes next and does NOT stage a
 * single suggestion — `routeToTradeForm`, the occupation resolve and the staged
 * `suggestions_enc` payload are RI-4. That split is why no `profile.resume_parsed` event is
 * emitted here: its payload REQUIRES `route` and `form_kind`, which are RI-4's outputs, and
 * emitting it with a guessed route would record a handover that never happened.
 *
 * AND IT IS WHY A SUCCESSFUL PARSE WRITES NO STATUS HERE (amended 2026-09-15). This service used
 * to mark the row `parsed` and leave the route to a second update. A client polling between the
 * two read a terminal status beside a null route, took the null for "chat", and sent a
 * form-routed worker to the chat. The extraction facts now ride on the draft, and
 * `ResumeRouteService` writes them together with the route in `settleParsed`'s single guarded
 * UPDATE. Only a FAILURE is terminal here, because a failure has nothing left to decide.
 *
 * `profile.resume_parse_failed` IS emitted here, because everything it names is known here —
 * and because ruling D9 makes failure the ordinary case rather than the exceptional one. It
 * is the feature's quality metric, not an error log: a meaningful share of imports will be
 * `ocr_below_floor`, and that is the number RI-7 exists to move.
 *
 * EXCEPT FOR TWO REASONS, WHERE THE SETTLE IS HANDED BACK TO THE CALLER (D9 amendment
 * 2026-09-22, #1654). {@link RESUME_SUMMARY_SURVIVING_FAILURES} names them. For those, `parse`
 * returns a `failed` draft with `settled: false` and writes NOTHING; the processor stages the
 * identity summary and then calls {@link settleFailure}, which runs the identical transaction
 * this service would have run. The reason is an ordering the client can observe: `markFailed`
 * makes the row TERMINAL, and the worker-app's poll returns on the first terminal read and
 * navigates straight into the chat. Settling before the summary had staged its line therefore
 * raced the bubble off the screen every time. The parsed path never had this problem because
 * the summary stages while the row is still `parsing` and `settleParsed` follows it; this makes
 * the failed path match.
 */
/**
 * The `notes` codes that mean "no real model call reached this document" (#1656).
 *
 * A CLOSED SET ON BOTH SIDES, and this is the API-side half of it. Anything the far side
 * sends that is not in here is DROPPED rather than logged OR recorded: `notes` is a contract
 * vocabulary, and the day it stops being one is the day an unrecognised string from a
 * model reply lands in our logs — and, since #1656, in a column and on the event spine.
 *
 * DERIVED FROM {@link RESUME_DEGRADED_POSTURES} RATHER THAN RE-TYPED. The same two codes are
 * now a CHECK constraint in `packages/db`, a `z.enum` on `profile.resume_parsed`, and this
 * filter. A hand-written third copy would drift the first time a posture was added, and the
 * symptom would be an event the registry refuses for a row the database happily stored.
 *
 * The other `notes` values (`fields_rejected`, `employments_rejected`,
 * `lines_dropped_by_masker`, `extraction_truncated`) describe a call that DID happen and
 * are not this signal - they belong to RI-7's quality story, not to "was anything even
 * attempted".
 */
const DEGRADED_POSTURE_NOTES: ReadonlySet<string> = new Set<string>(RESUME_DEGRADED_POSTURES);

@Injectable()
export class ResumeParseService {
  private readonly logger = new Logger(ResumeParseService.name);

  constructor(
    private readonly imports: ResumeImportRepository,
    private readonly ai: AiService,
    private readonly aiCost: AiCostRecorder,
    private readonly events: EventsService,
  ) {}

  /**
   * Parse the import if it is still waiting to be parsed.
   *
   * IDEMPOTENT BY STATUS, not by a lock. A row that has left `uploaded` has either been
   * parsed or is being parsed, and re-running would spend a second model call on the same
   * document — the cheapest kind of duplicate charge to make and the hardest to notice, since
   * both calls succeed and the second simply overwrites the first.
   */
  async parse(workerId: string, importId: string, ctx: RequestContext): Promise<ParsedDraft> {
    const row = await this.imports.findForWorker(importId, workerId);
    if (!row) return { status: "not_found" };
    if (row.status !== "uploaded") {
      return { status: "already_settled", importStatus: row.status };
    }

    // THE RETURN VALUE IS THE LOCK, and discarding it made the repository's documented
    // concurrency control a comment. `markParsing` is a conditional UPDATE `WHERE status =
    // 'uploaded'`; the loser of two concurrent deliveries gets zero rows back and must STOP.
    // Without this check both deliveries read `uploaded` at the line above, both called the
    // AI service, and both billed for reading one document.
    if (!(await this.imports.markParsing(importId))) {
      return { status: "already_settled", importStatus: "parsing" };
    }

    const out = await this.ai.parseResume(
      {
        schema_version: "resume.v1",
        // PSEUDONYMOUS BY CONTRACT. The far side attributes spend to this and nothing else;
        // it never learns which worker row it belongs to.
        worker_ref: workerId,
        storage_key: row.storageKey,
        mime: row.mime,
        target_fields: RESUME_PARSE_TARGET_FIELDS as unknown as TargetField[],
        // Task 1 B2 — the CLOSED option list for the model's trade classification.
        // Spread off the frozen source of truth so the wire can never carry a live
        // reference a consumer could widen at runtime (same freeze discipline as
        // the registry the kinds come from).
        trade_kinds: [...TRADE_FORM_KINDS_ALL],
      },
      ctx,
    );

    if (!out) {
      // NULL MEANS UNREACHABLE AND ONLY THAT — every semantic failure comes back as a healthy
      // 200 carrying its own reason. So this is an outage, and it must not be recorded as a
      // problem with the worker's document.
      return this.fail(row.id, workerId, "parse_unavailable", null, ctx);
    }

    // THE SPEND IS RECORDED BEFORE ANY BRANCH BELOW CAN RETURN. A call that happened was
    // billed whatever its content turned out to be, and an off-contract reply is exactly the
    // case a spend investigation needs to see. `record` no-ops on a null `meta`, which is what
    // every degraded far-side path sends rather than a fabricated zero.
    await this.aiCost.record(
      out.ai_metadata,
      "resume_parse",
      null,
      ctx.correlationId,
      ctx.requestId,
      {
        workerId,
      },
    );

    // ---- #1656: THE DEGRADED POSTURE, WHICH NOTHING READ ------------------------------
    //
    // `notes` is on the wire contract and NOTHING in this directory ever read it. The far
    // side already distinguishes the two cases and its own module comment says conflating
    // them "hides the one that needs an operator":
    //
    //   mock_no_parse   - a POSTURE. No model call happened at all: a spend cap, a
    //                     provider cooldown, a cost ceiling or the kill switch sent the
    //                     router to the deterministic mock. `empty_resume_parse` is
    //                     contract-valid with zero fields and NO failure_reason, so this
    //                     settles as a clean `parsed` carrying nothing.
    //   llm_unavailable - an INCIDENT. A provider was reached and failed.
    //
    // Consequence, and the reason this is not cosmetic: "how often does our parser let a
    // worker down" - the number ADR-0041 RI-7 exists to move - counted spend-capped no-ops
    // as SUCCESSFUL PARSES. The import is still allowed to proceed (a degraded posture is
    // not a failure and must not cost the worker his onboarding, ruling D9); it is simply
    // no longer silent.
    //
    // CLOSED VOCABULARY, COUNTS AND CODES ONLY. `notes` is a closed set on both sides and
    // must stay one; this keeps the intersection with the codes we know and drops anything
    // else rather than echoing an unrecognised string into our logs, our column or the spine.
    //
    // THE LOG LINE STAYS, AND SO DOES THE RECORD, because they serve different readers. The
    // warn is for the engineer reading one import at 2am; the value below is for the funnel,
    // which cannot aggregate a log line — and aggregating it is the entire acceptance
    // criterion of #1656. `degradedPosture` rides the draft to `ResumeRouteService`, which
    // writes it in the same single guarded UPDATE as the route and puts it on
    // `profile.resume_parsed`.
    const posture = selectDegradedPosture(out.notes);
    if (posture !== null) {
      this.logger.warn(
        `résumé parse ran DEGRADED for import ${row.id}: ${posture} ` +
          `(fields will be empty; this is not a document failure)`,
      );
    }

    if (out.failure_reason) {
      return this.fail(
        row.id,
        workerId,
        out.failure_reason as ResumeImportFailureName,
        narrowExtractionMethod(out.extraction_method),
        ctx,
      );
    }

    // A SUCCESS MUST NAME HOW THE TEXT WAS RECOVERED. The contract types `extraction_method` as
    // an open, nullable string; the column's CHECK and `profile.resume_parsed` both require the
    // closed set, and the event's field is NOT nullable. A cast used to paper over the gap, so a
    // far side that said "success" without a method — or with one outside the set — produced a
    // settle the database refused and an event the registry refused, AFTER the spend. It is an
    // off-contract reply, and it is recorded as exactly that.
    const extractionMethod = narrowExtractionMethod(out.extraction_method);
    if (extractionMethod === null) {
      return this.fail(row.id, workerId, "parse_output_invalid", null, ctx);
    }

    // ---- THE SECOND WALL ---------------------------------------------------------------
    // The six gates already ran over there. They run again here, narrowed to the ones that
    // can run without the document (see `resume-parse-gates.ts` for exactly which, and why
    // pretending to the other two would be worse than admitting they are absent). On this
    // route the far wall runs under a masking policy the owner can flip, which is precisely
    // when a second opinion is worth having.
    const gated = applyResumeParseGates(out.fields, RESUME_PARSE_TARGET_FIELDS as TargetField[]);
    const { kept: employments, rejected: employmentsRejected } = filterEmployments(out.employments);

    if (gated.rejections.length > 0 || employmentsRejected > 0) {
      // COUNTS AND GATE IDS, never values — the rejected value is by definition the one thing
      // that may not be logged.
      this.logger.warn(
        `resume parse re-gated import=${row.id}: ` +
          `${gated.rejections.length} fields and ${employmentsRejected} employments dropped ` +
          `by the second wall`,
      );
    }

    // NO WRITE. The row stays `parsing` until the route service settles it in one statement —
    // see the class docblock for the defect a write here caused.
    //
    // `storageKey` + `mime` RIDE ON THE DRAFT so the RI-summary second call can re-read the
    // same document without a second indexed lookup. They are the row's own key and closed-set
    // mime the parse already validated — never client input — and carrying them here is what
    // keeps the summary off the request path and off a second read.
    return {
      status: "parsed",
      importId: row.id,
      storageKey: row.storageKey,
      mime: row.mime,
      fields: gated.accepted,
      employments,
      // Task 1 B2 — the model's trade classification, narrowed to the closed list
      // (or null). Recorded, NOT acted on: `routeToTradeForm` stays the decider
      // until the handover-policy ruling lands the recall path.
      associationKind: narrowTradeKind(out.trade_association?.kind),
      extractionMethod,
      pageCount: out.page_count,
      ocrConfidence: out.ocr_confidence,
      // #1656 - THE SAME VALUE THE WARN ABOVE NAMED, carried rather than recomputed so a log
      // line and a recorded fact can never describe different imports.
      degradedPosture: posture,
    };
  }

  /**
   * Settle a failure this service deliberately left unsettled (D9 amendment, #1654).
   *
   * THE SAME TRANSACTION `fail` RUNS, called from the other side of the identity summary.
   * Same `markFailed`, same `WHERE status = 'parsing'` guard, same single transaction, same
   * `profile.resume_parse_failed:<importId>` idempotency key — this method exists to MOVE that
   * write in time, never to weaken it. A draft that already carries `settled: true` is not
   * this method's business and gets no second write.
   *
   * THE RETURN IS "DID THIS CALL RECORD IT", for the same reason `markFailed`'s is: a
   * redelivery, or a row erased mid-flight, gets `false` and emits nothing. The caller may
   * ignore it — the processor does — because there is nothing left for it to decide.
   */
  async settleFailure(
    workerId: string,
    draft: FailedDraft,
    ctx: RequestContext,
  ): Promise<boolean> {
    if (draft.settled) return false;
    return this.recordFailure(draft.importId, workerId, draft.reason, draft.extractionMethod, ctx);
  }

  /**
   * Turn a failure into a draft, recording it NOW unless the summary must run first.
   *
   * TWO REASONS ARE DEFERRED and the rest are not — see {@link RESUME_SUMMARY_SURVIVING_FAILURES}
   * for which and why. Deferring costs a window: if the process dies between here and
   * {@link settleFailure} the row stays `parsing`, and the redelivery finds it past `uploaded`,
   * returns `already_settled` and does NOT read the document again. That is the identical
   * fail-closed trade the parsed path already makes (ADR-0041 §7) — the row waits for a sweep
   * rather than a second charge — and it is why the window was acceptable to open.
   *
   * A `false` from the guard is reported as `already_settled`, not as `failed` — this call did
   * not record a failure, and saying so would be a claim about a row it did not write.
   */
  private async fail(
    importId: string,
    workerId: string,
    reason: ResumeImportFailureName,
    extractionMethod: ResumeExtractionMethodName | null,
    ctx: RequestContext,
  ): Promise<ParsedDraft> {
    if (RESUME_SUMMARY_SURVIVING_FAILURES.has(reason)) {
      return { status: "failed", importId, reason, extractionMethod, settled: false };
    }
    const recorded = await this.recordFailure(importId, workerId, reason, extractionMethod, ctx);
    if (!recorded) return { status: "already_settled", importStatus: "settled_elsewhere" };
    return { status: "failed", importId, reason, extractionMethod, settled: true };
  }

  /**
   * Record the failure and count it — together, and only if this call is the one that settled.
   *
   * ONE TRANSACTION, BECAUSE THE EVENT IS THE METRIC. A `failed` row without its event is a
   * failure the funnel never counted; an event without the row is one counted twice on the next
   * delivery. `markFailed` is guarded `WHERE status = 'parsing'`, and its boolean is what
   * entitles this call to emit: a row that had already left `parsing` gets no second event.
   *
   * THE IDEMPOTENCY KEY IS A SECOND, INDEPENDENT GUARD. The status guard stops a duplicate at the
   * row; the key stops one at the events table (`ON CONFLICT DO NOTHING`). Either alone would
   * hold today. Both mean a later edit that loosens one does not silently double-count.
   *
   * THE ONLY WRITER OF `failed`, reached from both the immediate path ({@link fail}) and the
   * deferred one ({@link settleFailure}). A second copy of this transaction is how one of the
   * two would one day emit without the row, or write the row without the event.
   */
  private async recordFailure(
    importId: string,
    workerId: string,
    reason: ResumeImportFailureName,
    extractionMethod: ResumeExtractionMethodName | null,
    ctx: RequestContext,
  ): Promise<boolean> {
    return this.imports.withTransaction(async (tx) => {
      if (!(await this.imports.markFailed(importId, reason, extractionMethod, tx))) return false;
      await this.events.emit({
        event_name: "profile.resume_parse_failed",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          import_id: importId,
          reason,
          // Nullable BECAUSE the commonest failures happen before a method is chosen — an
          // encrypted PDF never gets that far.
          extraction_method: extractionMethod,
        },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        idempotencyKey: `profile.resume_parse_failed:${importId}`,
        tx,
      });
      return true;
    });
  }
}

/**
 * The failure reasons the "Kya ye aap hi hain?" identity summary SURVIVES (ruling D9
 * amendment, owner, 2026-09-22, #1654).
 *
 * OURS, NOT THE DOCUMENT'S — that is the whole rule. On these two the extraction SUCCEEDED
 * and only our own model reply was unusable: `parse_output_invalid` is a reply that failed
 * its contract (or named no extraction method), `parse_deadline_exceeded` is a reply that
 * never arrived in time. The summary pipeline therefore stands on exactly the text a clean
 * parse would have stood on, and a worker whose document we read perfectly well should not
 * lose his first bubble to our own defect.
 *
 * CLOSED, AND IT STAYS CLOSED even though the other six would be harmless. The summary runs
 * its OWN `extract()` over the same document, so `no_text_layer`, `encrypted_document`,
 * `empty_document`, `unsupported_document`, `ocr_below_floor` and `parse_unavailable` all
 * degrade inside it and stage nothing anyway — the set is not what makes them silent. It is
 * what stops us paying a storage fetch and a model call to REDISCOVER that they are silent,
 * on the majority path. Do not "simplify" this away.
 *
 * DEFERRAL IS THE OTHER HALF. A reason in this set makes `parse` return `settled: false` and
 * write nothing, so the summary can stage while the row is still `parsing`; see the class
 * docblock for the race that forced it.
 */
export const RESUME_SUMMARY_SURVIVING_FAILURES: ReadonlySet<ResumeImportFailureName> = new Set<
  ResumeImportFailureName
>(["parse_output_invalid", "parse_deadline_exceeded"]);

/**
 * The contract's open string, narrowed to the closed set — or null.
 *
 * A MEMBERSHIP TEST, NOT A CAST. `as ResumeExtractionMethodName` asserts what it cannot know;
 * this checks, and whatever is not in the set becomes null so the caller has to decide what an
 * unknown method means rather than inheriting a value two CHECKs would refuse.
 */
function narrowExtractionMethod(
  method: string | null | undefined,
): ResumeExtractionMethodName | null {
  return (RESUME_EXTRACTION_METHODS as readonly string[]).includes(method ?? "")
    ? (method as ResumeExtractionMethodName)
    : null;
}

/**
 * Task 1 B2 — the model's trade classification, narrowed to the closed
 * 21-kind list, or null.
 *
 * A MEMBERSHIP TEST, NOT A CAST — the same posture as `narrowExtractionMethod`
 * above, for the same reason: whatever is not in the set becomes null so the
 * caller has to decide what an unknown kind means rather than inheriting a
 * value the column CHECK would refuse. The far side already narrowed once;
 * this is the second wall, and it runs even when the far side predates the
 * classification entirely (`trade_association` absent ⇒ null).
 */
function narrowTradeKind(kind: string | null | undefined): TradeFormKindName | null {
  return (TRADE_FORM_KINDS_ALL as readonly string[]).includes(kind ?? "")
    ? (kind as TradeFormKindName)
    : null;
}

/**
 * #1656 — the far side's `notes`, narrowed to AT MOST ONE degraded posture, or null.
 *
 * ONE VALUE, NOT AN ARRAY, and the far side is what makes that safe rather than lossy: the two
 * codes are appended under a single `if not meta.real_call: ... elif not meta.success: ...`
 * around a single `router.run` (`apps/ai-service/app/resume_import/resume_parse.py`), and the
 * response de-duplicates `notes` before it is sent. At most one can arrive.
 *
 * SO THIS IS THE GUARD FOR THE DAY THAT STOPS BEING TRUE. It scans in
 * {@link RESUME_DEGRADED_POSTURES} order — not in the order the wire happened to use, which is
 * the far side's business and not a contract — so a far side that one day sent both records
 * `llm_unavailable`, the INCIDENT someone must look at, rather than letting an ops posture hide
 * it. Deterministic on input, and independent of array order either side.
 *
 * A MEMBERSHIP TEST, NOT A CAST — the same posture as `narrowExtractionMethod` and
 * `narrowTradeKind` above. Anything outside the closed set is dropped: it is never logged,
 * never written to the column, and never reaches the event.
 */
function selectDegradedPosture(
  notes: readonly string[] | null | undefined,
): ResumeDegradedPostureName | null {
  if (!notes || notes.length === 0) return null;
  const seen = new Set<string>(notes.filter((n) => DEGRADED_POSTURE_NOTES.has(n)));
  return RESUME_DEGRADED_POSTURES.find((code) => seen.has(code)) ?? null;
}

/**
 * What RI-4 will be handed. Deliberately NOT persisted here: nothing about a parse is a claim
 * the worker has made, and ruling D2 says a suggestion becomes an answer only when he confirms
 * it. An import abandoned between this phase and the next must leave zero claims behind.
 *
 * THE PARSED VARIANT CARRIES THE EXTRACTION FACTS because nothing else writes them any more:
 * `settleParsed` records them in the same statement as the route. `extractionMethod` is the
 * closed set, never null — a success without a method is refused as `parse_output_invalid`.
 */
export type ParsedDraft =
  | { status: "not_found" }
  | { status: "already_settled"; importStatus: string }
  | FailedDraft
  | {
      status: "parsed";
      importId: string;
      /**
       * The row's own storage key + closed-set mime, carried so the RI-autofill option-map
       * call can re-read the same document without a second lookup. Validated by the
       * confirm path long before the parse ran — never client input at this point.
       *
       * THE RI-SUMMARY CALL NO LONGER READS THESE (#1654). It fetches the row itself — it
       * always did, to check for an already-staged line — and now sources the key and the
       * mime from that same read, because the `failed` draft it must also serve could never
       * have carried them. `ResumeOptionMapService.map` is what keeps them here.
       */
      storageKey: string;
      mime: string;
      fields: Record<string, ParsedField>;
      employments: ResumeEmployment[];
      /**
       * Task 1 B2 — which of the 21 declared trades the model judged this
       * résumé, or null (no judgment / none fits / far side predates it).
       * RECORDED, NOT ACTED ON: routing still comes from `routeToTradeForm`
       * alone until the recall path is ruled in.
       */
      associationKind: TradeFormKindName | null;
      extractionMethod: ResumeExtractionMethodName;
      pageCount: number | null;
      ocrConfidence: number | null;
      /**
       * #1656 — why no real model call stood behind this parse, or null when one did.
       *
       * A PARSE FACT, WHICH IS WHY IT TRAVELS HERE rather than being re-derived at the
       * settle: only this service ever sees `notes`. `settleParsed` writes it in the same
       * single guarded UPDATE as the route, and `profile.resume_parsed` carries it, so the
       * funnel can subtract spend-capped no-ops from "how often does our parser let a worker
       * down" instead of counting them as successful parses.
       *
       * NULL IS A FACT HERE, unlike on the column: this draft was built by code that looked.
       */
      degradedPosture: ResumeDegradedPostureName | null;
    };

/**
 * A parse that produced nothing usable, and whether THIS service already recorded it.
 *
 * `settled: true` — the row is `failed` and `profile.resume_parse_failed` is emitted. Nothing
 * is owed.
 *
 * `settled: false` — the row is still `parsing` and NO event exists yet. The caller owes it a
 * {@link ResumeParseService.settleFailure}, and is expected to stage the identity summary
 * first; that ordering is the point of the deferral (#1654) and the reason the two fields
 * below travel with the draft — `settleFailure` needs the reason AND the extraction method to
 * write the same row `fail` would have written.
 */
export interface FailedDraft {
  status: "failed";
  importId: string;
  reason: ResumeImportFailureName;
  /** Nullable BECAUSE the commonest failures happen before a method is chosen. */
  extractionMethod: ResumeExtractionMethodName | null;
  settled: boolean;
}
