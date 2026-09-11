import { Injectable, Logger } from "@nestjs/common";
import type { ResumeEmployment, TargetField } from "@badabhai/ai-contracts";
import type { ParsedField } from "@badabhai/ai-contracts";
import type {
  ResumeExtractionMethodName,
  ResumeImportFailureName,
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
 * and the result gated and recorded. It does NOT decide where the worker goes next and does
 * NOT stage a single suggestion — `routeToTradeForm`, the occupation resolve and the staged
 * `suggestions_enc` payload are RI-4. That split is why no `profile.resume_parsed` event is
 * emitted here: its payload REQUIRES `route` and `form_kind`, which are RI-4's outputs, and
 * emitting it with a guessed route would record a handover that never happened.
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

    await this.imports.markParsing(importId);

    const out = await this.ai.parseResume(
      {
        schema_version: "resume.v1",
        // PSEUDONYMOUS BY CONTRACT. The far side attributes spend to this and nothing else;
        // it never learns which worker row it belongs to.
        worker_ref: workerId,
        storage_key: row.storageKey,
        mime: row.mime,
        target_fields: RESUME_PARSE_TARGET_FIELDS as unknown as TargetField[],
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
    await this.aiCost.record(out.ai_metadata, "resume_parse", null, ctx.correlationId, ctx.requestId, {
      workerId,
    });

    if (out.failure_reason) {
      return this.fail(
        row.id,
        workerId,
        out.failure_reason as ResumeImportFailureName,
        out.extraction_method ?? null,
        ctx,
      );
    }

    // ---- THE SECOND WALL ---------------------------------------------------------------
    // The six gates already ran over there. They run again here, narrowed to the ones that
    // can run without the document (see `resume-parse-gates.ts` for exactly which, and why
    // pretending to the other two would be worse than admitting they are absent). On this
    // route the far wall runs under a masking policy the owner can flip, which is precisely
    // when a second opinion is worth having.
    const gated = applyResumeParseGates(out.fields, RESUME_PARSE_TARGET_FIELDS as TargetField[]);
    const { kept: employments, rejected: employmentsRejected } = filterEmployments(
      out.employments,
    );

    if (gated.rejections.length > 0 || employmentsRejected > 0) {
      // COUNTS AND GATE IDS, never values — the rejected value is by definition the one thing
      // that may not be logged.
      this.logger.warn(
        `resume parse re-gated import=${row.id}: ` +
          `${gated.rejections.length} fields and ${employmentsRejected} employments dropped ` +
          `by the second wall`,
      );
    }

    await this.imports.markParsed(row.id, {
      extractionMethod: out.extraction_method,
      pageCount: out.page_count,
      ocrConfidence: out.ocr_confidence,
    });

    return {
      status: "parsed",
      importId: row.id,
      fields: gated.accepted,
      employments,
      extractionMethod: out.extraction_method,
    };
  }

  private async fail(
    importId: string,
    workerId: string,
    reason: ResumeImportFailureName,
    extractionMethod: string | null,
    ctx: RequestContext,
  ): Promise<ParsedDraft> {
    await this.imports.markFailed(importId, reason, extractionMethod);
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
        extraction_method: extractionMethod as ResumeExtractionMethodName | null,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    return { status: "failed", importId, reason };
  }
}

/**
 * What RI-4 will be handed. Deliberately NOT persisted here: nothing about a parse is a claim
 * the worker has made, and ruling D2 says a suggestion becomes an answer only when he confirms
 * it. An import abandoned between this phase and the next must leave zero claims behind.
 */
export type ParsedDraft =
  | { status: "not_found" }
  | { status: "already_settled"; importStatus: string }
  | { status: "failed"; importId: string; reason: ResumeImportFailureName }
  | {
      status: "parsed";
      importId: string;
      fields: Record<string, ParsedField>;
      employments: ResumeEmployment[];
      extractionMethod: string | null;
    };
