import { Injectable, Logger } from "@nestjs/common";
import type { ResumeImportFailureName } from "@badabhai/types";

import { AiService } from "../../ai/ai.service";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import type { RequestContext } from "../../common/request-context";
import { TRADE_FORM_KINDS, type TradeFormKind } from "../trade-form-router";

/**
 * One Hinglish line off an uploaded résumé (RI-summary, backend-only slice).
 *
 * WHAT THIS PHASE OWNS AND WHAT IT DELIBERATELY DOES NOT. This service reads the
 * same document the parse just read, for {Job Role} + {total experience} + {short
 * summary} in Hinglish (Roman script). It does NOT decide where the worker goes,
 * does NOT stage a suggestion, does NOT write a row, does NOT emit an event, and
 * does NOT touch the chat — the Langfuse trace is the verification surface, and
 * the chat display is a follow-up slice. That split is why a summary failure can
 * never cost a worker their onboarding.
 *
 * BACKEND-ONLY MEANS BEST-EFFORT. Every failure — unreachable service, degraded
 * far side, off-contract reply, unknown role — returns null and logs PII-free
 * (role id + lengths + closed reason, never the Hinglish text). The caller
 * (`ResumeImportProcessor`) runs this beside the route and ignores null.
 *
 * THE ROLE LIST IS THE 9 ENABLED FORMS, NOT THE 21 DECLARED KINDS. The parse's
 * `trade_association` classifies against `TRADE_FORM_KINDS_ALL` (21, vocabulary
 * included); this summary classifies for a worker-facing line that will open a
 * form-or-chat confirm — so only kinds with a form behind them are honest options.
 * `TRADE_FORM_KINDS` is derived from the role registry's `formEnabled: true` filter,
 * which is the single source of truth for "routable".
 *
 * AI NEVER OWNS A BUSINESS DECISION HERE (§3). The model selects among
 * caller-supplied ids; `narrowRoleKind` below decides what survives. Anything
 * outside the list becomes null — "no judgment" — and the deterministic router
 * stays the decider.
 */
@Injectable()
export class ResumeSummaryService {
  private readonly logger = new Logger(ResumeSummaryService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiCost: AiCostRecorder,
  ) {}

  /**
   * Summarise the import's document, or null when there is nothing to show.
   *
   * NEVER THROWS for a model-side failure: null means "no summary", and the import
   * proceeds exactly as if this call never happened. Only a programming bug (a
   * malformed storage key shape we built ourselves) is allowed to throw — and this
   * method builds no keys, it only forwards the one the parse already used.
   */
  async summarize(
    workerId: string,
    storageKey: string,
    mime: string,
    ctx: RequestContext,
  ): Promise<ResumeSummary | null> {
    const out = await this.ai.summarizeResume(
      {
        schema_version: "resume.v1",
        // PSEUDONYMOUS BY CONTRACT. The far side attributes spend to this and nothing
        // else; it never learns which worker row it belongs to.
        worker_ref: workerId,
        storage_key: storageKey,
        mime,
        // Spread off the frozen source of truth so the wire can never carry a live
        // reference a consumer could widen at runtime (same freeze discipline as the
        // parse's `trade_kinds`).
        role_kinds: [...TRADE_FORM_KINDS],
      },
      ctx,
    );

    if (!out) {
      // NULL MEANS UNREACHABLE AND ONLY THAT — every semantic failure comes back as a
      // healthy 200 carrying its own reason. So this is an outage, and it must not be
      // recorded as a problem with the worker's document.
      this.logger.warn(`résumé summary unavailable for worker ${workerId.slice(0, 8)}…`);
      return null;
    }

    // THE SPEND IS RECORDED BEFORE ANY BRANCH BELOW CAN RETURN. A call that happened was
    // billed whatever its content turned out to be. `record` no-ops on a null `meta`.
    await this.aiCost.record(
      out.ai_metadata,
      "resume_profile_summary",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId },
    );

    if (out.failure_reason) {
      // PII-FREE: a closed reason, never model text.
      this.logger.log(
        `résumé summary degraded for worker ${workerId.slice(0, 8)}… reason=${out.failure_reason}`,
      );
      return {
        roleKind: null,
        experienceText: null,
        summaryText: null,
        failureReason: out.failure_reason as ResumeImportFailureName,
      };
    }

    // THE SECOND WALL. The far side already narrowed once; this runs even when the far
    // side predates the classification entirely (`role_kind` absent ⇒ null). Membership,
    // not a cast: whatever is not in the enabled set becomes null so the caller has to
    // decide what an unknown kind means rather than inheriting a value no form can serve.
    const roleKind = narrowRoleKind(out.role_kind);

    // COUNTS AND A CLOSED ROLE ID, never the Hinglish text. The summary strings are
    // worker-derived free text that passed one wall, not two — they belong on the
    // Langfuse trace (already masked there), not in our logs.
    this.logger.log(
      `résumé summary ready for worker ${workerId.slice(0, 8)}… role=${roleKind ?? "null"} ` +
        `exp_len=${out.experience_text?.length ?? 0} summary_len=${out.summary_text?.length ?? 0}`,
    );

    if (roleKind === null && out.experience_text === null && out.summary_text === null) {
      return null;
    }

    return {
      roleKind,
      experienceText: out.experience_text,
      summaryText: out.summary_text,
      failureReason: null,
    };
  }
}

/**
 * The contract's open string, narrowed to the 9 enabled kinds — or null.
 *
 * A MEMBERSHIP TEST, NOT A CAST. `as TradeFormKind` asserts what it cannot know;
 * this checks, and whatever is not in the set becomes null so the caller has to
 * decide what an unknown kind means rather than inheriting a value no form behind it
 * could ever serve.
 */
function narrowRoleKind(kind: string | null | undefined): TradeFormKind | null {
  return (TRADE_FORM_KINDS as readonly string[]).includes(kind ?? "")
    ? (kind as TradeFormKind)
    : null;
}

/**
 * What the (future) chat confirm will be handed. Deliberately NOT persisted here:
 * nothing about a summary is a claim the worker has made, and ruling D2 says a
 * suggestion becomes an answer only when he confirms it. Backend-only in this slice
 * means this value is logged (PII-free) and returned for Langfuse verification —
 * never written, never emitted, never rendered.
 */
export interface ResumeSummary {
  readonly roleKind: TradeFormKind | null;
  readonly experienceText: string | null;
  readonly summaryText: string | null;
  readonly failureReason: ResumeImportFailureName | null;
}
