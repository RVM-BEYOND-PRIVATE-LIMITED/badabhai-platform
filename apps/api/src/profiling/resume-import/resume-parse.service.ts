import { Injectable, Logger } from "@nestjs/common";
import type { ResumeEmployment, TargetField } from "@badabhai/ai-contracts";
import type { ParsedField } from "@badabhai/ai-contracts";
import {
  RESUME_EXTRACTION_METHODS,
  TRADE_FORM_KINDS_ALL,
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
 */
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
    };
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
    const recorded = await this.imports.withTransaction(async (tx) => {
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
    if (!recorded) return { status: "already_settled", importStatus: "settled_elsewhere" };
    return { status: "failed", importId, reason };
  }
}

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
  | { status: "failed"; importId: string; reason: ResumeImportFailureName }
  | {
      status: "parsed";
      importId: string;
      /**
       * The row's own storage key + closed-set mime, carried so the RI-summary second
       * call can re-read the same document without a second lookup. Validated by the
       * confirm path long before the parse ran — never client input at this point.
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
    };
