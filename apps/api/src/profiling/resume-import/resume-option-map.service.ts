import { Injectable, Logger } from "@nestjs/common";
import type { ResumeMapQuestion, ResumeOptionMapping } from "@badabhai/ai-contracts";
import type { ResumeImportFailureName } from "@badabhai/types";

import { AiService } from "../../ai/ai.service";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import type { RequestContext } from "../../common/request-context";

/**
 * Document lines onto pack option ids (RI-autofill, owner override B, 2026-09-20,
 * of ruling D2).
 *
 * WHAT THIS PHASE OWNS AND WHAT IT DELIBERATELY DOES NOT. This service runs the
 * THIRD LLM call over an already-uploaded résumé — after the parse (cited values)
 * and the summary (Hinglish line) — and returns gated mappings: at most one per
 * pack question, every id verbatim from that question's closed options, every
 * mapping cited. It does NOT write an answer, does NOT emit an event, and does NOT
 * decide anything: the caller stages the mappings beside the route, and the
 * worker's identity "haan" is what applies them (override B).
 *
 * BEST-EFFORT, like the summary. Every failure — unreachable service, degraded far
 * side, off-contract reply, no citable mapping — returns an empty list and logs
 * PII-free (counts and a closed reason, never document text or option prose). The
 * import proceeds exactly as if this call never happened, and the Haan hands over
 * to an unfilled form.
 *
 * AI SELECTS, CODE DECIDES — as far as B allows. The model selects among
 * caller-supplied ids; `narrowMappings` below is the deterministic second wall
 * that decides what survives: membership against the pack's own option lists (not
 * the model's word for them), cardinality per answer type, one mapping per
 * question. Whatever is not in the set is dropped, never repaired.
 */
@Injectable()
export class ResumeOptionMapService {
  private readonly logger = new Logger(ResumeOptionMapService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiCost: AiCostRecorder,
  ) {}

  /**
   * Map the import's document onto the pack's option questions, or [] when there
   * is nothing stageable.
   *
   * NEVER THROWS for a model-side failure: [] means "no mappings", and the import
   * proceeds exactly as if this call never happened.
   */
  async map(
    workerId: string,
    storageKey: string,
    mime: string,
    questions: readonly ResumeMapQuestion[],
    ctx: RequestContext,
  ): Promise<MappedOption[]> {
    if (questions.length === 0) return [];

    const out = await this.ai.mapResumeOptions(
      {
        schema_version: "resume.v1",
        // PSEUDONYMOUS BY CONTRACT. The far side attributes spend to this and nothing
        // else; it never learns which worker row it belongs to.
        worker_ref: workerId,
        storage_key: storageKey,
        mime,
        // Spread off the caller's arrays so the wire can never carry a live reference
        // a consumer could widen at runtime (same freeze discipline as the parse's
        // `trade_kinds`).
        questions: questions.map((q) => ({
          question_key: q.question_key,
          answer_type: q.answer_type,
          options: q.options.map((o) => ({ option_key: o.option_key, label_text: o.label_text })),
        })),
      },
      ctx,
    );

    if (!out) {
      // NULL MEANS UNREACHABLE AND ONLY THAT — every semantic failure comes back as a
      // healthy 200 carrying its own reason. So this is an outage, and it must not be
      // recorded as a problem with the worker's document.
      this.logger.warn(`résumé option-map unavailable for worker ${workerId.slice(0, 8)}…`);
      return [];
    }

    // THE SPEND IS RECORDED BEFORE ANY BRANCH BELOW CAN RETURN. A call that happened was
    // billed whatever its content turned out to be. `record` no-ops on a null `meta`.
    await this.aiCost.record(
      out.ai_metadata,
      "resume_option_map",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId },
    );

    if (out.failure_reason) {
      // PII-FREE: a closed reason, never model text.
      this.logger.log(
        `résumé option-map degraded for worker ${workerId.slice(0, 8)}… reason=${out.failure_reason}`,
      );
      return [];
    }

    // THE SECOND WALL. The far side already gated once; this runs even when the far
    // side predates the contract entirely. Membership against the PACK's own lists —
    // not the model's word for them — cardinality per answer type, one mapping per
    // question, first wins.
    const narrowed = narrowMappings(out.mappings ?? [], questions);

    // COUNTS AND QUESTION KEYS, never option prose or document text. Mapped ids are
    // closed-vocabulary pack keys — safe beside the counts the route service logs.
    this.logger.log(
      `résumé option-map ready for worker ${workerId.slice(0, 8)}… ` +
        `${narrowed.length} mapped of ${questions.length} asked`,
    );
    return narrowed;
  }
}

/**
 * The far side's mappings, narrowed against the pack's own option lists — or dropped.
 *
 * A MEMBERSHIP TEST, NOT A CAST, applied per mapping: the question must be one we
 * asked, every id must be one of THAT question's options verbatim, a single_select
 * takes at most one id, and only the first mapping per question survives. Whatever
 * fails any of these is dropped — never repaired, never truncated. Repair would mean
 * ticking a box nobody can point at in the document.
 */
function narrowMappings(
  mappings: readonly ResumeOptionMapping[],
  questions: readonly ResumeMapQuestion[],
): MappedOption[] {
  const byKey = new Map(questions.map((q) => [q.question_key, q]));
  const seen = new Set<string>();
  const kept: MappedOption[] = [];
  for (const mapping of mappings) {
    if (seen.has(mapping.question_key)) continue;
    const question = byKey.get(mapping.question_key);
    if (!question) continue;
    const allowed = new Set(question.options.map((o) => o.option_key));
    // STRICT, NOT FILTERING. A mapping carrying even one id outside the question's
    // closed list is dropped whole — keeping the "good" ids would mean trusting the
    // model's judgment about which half of its answer to believe, which is exactly
    // the repair the gates exist to refuse. The far side holds the same rule, so an
    // honest mapping never trips this.
    const keys = [...new Set(mapping.option_keys)];
    if (keys.length === 0 || !keys.every((k) => allowed.has(k))) continue;
    if (question.answer_type === "single_select" && keys.length > 1) continue;
    seen.add(mapping.question_key);
    kept.push({ questionKey: mapping.question_key, optionKeys: keys });
  }
  return kept;
}

/**
 * What the route service stages. Deliberately NOT persisted here and NOT an answer:
 * nothing about a mapping is a claim the worker has made until his identity "haan"
 * applies it (override B). Closed ids only — no prose, no spans, no document text.
 */
export interface MappedOption {
  readonly questionKey: string;
  readonly optionKeys: readonly string[];
}

/** The far side's closed failure vocabulary, for callers that count degradations. */
export type ResumeOptionMapFailure = ResumeImportFailureName;
