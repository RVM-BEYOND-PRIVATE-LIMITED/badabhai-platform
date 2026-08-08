/**
 * The IDENTIFY phase, as a turn — where a worker's own words become a pinned occupation.
 *
 * THIS IS THE JOIN THE WHOLE PROJECT WAS BUILT FOR. Phase 7 shipped `OccupationService` (the
 * four-rung ladder, the family-level margin, the chip offer) and Phase 5 shipped the
 * orchestrator with an `occupation` field on its envelope that nothing ever wrote. Both sides
 * were tested and neither was connected; this file is the connection, and until it existed the
 * deterministic interview could only ever run the universal pack.
 *
 * THE ORCHESTRATOR CALLS THIS IN-PROCESS, NOT OVER HTTP. `POST /internal/occupation/resolve`
 * exists for the ai-service and for ops tooling; putting a network hop between two classes in
 * the same Nest app on the chat hot path would spend ~30 ms per turn to call a service that is
 * already in the injector.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DO. It never ranks, never scores, and never decides a
 * threshold — every one of those lives in `occupation-calibration.ts` behind reviewed config.
 * It reads a `ResolveResult` and translates it into envelope state and, at most, one question.
 *
 * PRIVACY: the worker's utterance is an ARGUMENT here and is never stored. The one place it
 * could leave — the growth queue — goes through the ai-service's pseudonymizer first and is
 * then hashed, so what lands is `sha256(pseudonymized normalized phrase)` and nothing else.
 */

import { Injectable, Logger } from "@nestjs/common";
import type { OccupationPin, QuestionPackOption } from "@badabhai/ai-contracts";
import { DISAMBIGUATION_ESCAPE_KEY, DISAMBIGUATION_ESCAPE_LABEL } from "@badabhai/config";

import { AiService } from "../ai/ai.service";
import { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";
import { catalogVersionForEvent } from "../occupation/occupation.repository";
import { OccupationService, type ResolveResult } from "../occupation/occupation.service";
import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { DISAMBIGUATION_PROMPT_TEXT } from "./next-question";
import type { OfferedChip, ProfilingEnvelope } from "./conversation-state";

/**
 * How many turns retrieval may come back empty before the engine stops asking.
 *
 * TWO, and the second one is not optimism. The first attempt runs on whatever the worker said
 * to open the conversation, which is frequently a greeting or a fragment ("kaam chahiye"); the
 * second runs on their answer to the trade question, which is the one actually engineered to
 * elicit a trade word. A third would be asking the same thing a third time, which reads as not
 * listening — and the universal pack still produces a real profile, so the cost of giving up is
 * a less specific interview and never a lost one.
 */
export const MAX_IDENTIFY_ATTEMPTS = 2;

/**
 * How many times an interview may CHANGE the occupation it already pinned (plan risk #12).
 *
 * ONE, exactly as the plan specifies. Phase 8 shipped zero and deferred this; the two guards in
 * {@link IdentifyService.maybeRepin} — a family-level `auto` match, on a DIFFERENT family — are
 * what closed that gap without needing production utterances to pick a confidence threshold,
 * because they reuse thresholds the ladder already calibrates.
 */
export const MAX_OCCUPATION_REPINS = 1;

/**
 * The disambiguation question, verbatim.
 *
 * ON-PERSONA BY THE SAME RULES THE PACK VALIDATOR ENFORCES on every authored prompt: the "aap"
 * form, exactly one question mark, no vocative, no exclamation, no emoji, under twenty words.
 * It lives as a constant rather than in a pack because it is asked ABOUT the packs — there is
 * no pack pinned yet at the moment it is served.
 */
export const DISAMBIGUATION_PROMPT = DISAMBIGUATION_PROMPT_TEXT;

/** The outcome of running identification on one turn. */
export interface IdentifyResult {
  /** Envelope fields to merge. Always safe to spread, even on the no-op path. */
  readonly patch: Partial<ProfilingEnvelope>;
  /**
   * Non-null means the orchestrator must serve THIS instead of consulting the engine: the
   * worker is being shown chips and no pack question makes sense until they answer.
   */
  readonly offer: {
    readonly prompt: string;
    readonly chips: readonly OfferedChip[];
    readonly options: readonly QuestionPackOption[];
  } | null;
  /** The occupation just pinned this turn, so the caller can re-resolve the pack immediately. */
  readonly pinned: OccupationPin | null;
}

const NO_OP: IdentifyResult = { patch: {}, offer: null, pinned: null };

@Injectable()
export class IdentifyService {
  private readonly logger = new Logger(IdentifyService.name);

  constructor(
    private readonly occupation: OccupationService,
    private readonly events: EventsService,
    private readonly ai: AiService,
  ) {}

  /**
   * Run identification for one turn, if this turn is one where it should run at all.
   *
   * THE GUARD ORDER MATTERS. A settled occupation short-circuits before anything else, because
   * re-running retrieval on turn nine — when the worker is describing their machines, not their
   * trade — is how a welder becomes a machine operator halfway through their own interview.
   */
  async identify(
    envelope: ProfilingEnvelope,
    text: string,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    // Already pinned. One re-pin is allowed (risk #12) — see {@link maybeRepin} for the two
    // conditions that make it safe.
    if (envelope.occupation !== null) return this.maybeRepin(envelope, text, ctx);

    // An outstanding offer OWNS this turn's message: it is a chip tap or a rejection of the
    // chips, never a fresh phrase to run the ladder on.
    if (envelope.needsDisambiguation && envelope.disambiguationOffer.length > 0) {
      return this.settleOffer(envelope, text, ctx);
    }

    if (envelope.identifyAttempts >= MAX_IDENTIFY_ATTEMPTS) return NO_OP;

    const result = await this.occupation.resolve(text);
    switch (result.status) {
      case "auto":
        return this.pin(result, "matched_lexical", ctx);
      case "disambiguate":
        return this.offer(result, ctx);
      default:
        return this.giveUp(envelope, result, text, ctx);
    }
  }

  /**
   * A worker tapped a chip — or told us none of them fit.
   *
   * RESOLVED THROUGH THE STORED MAP, NEVER BY RE-MATCHING THE TEXT. The label the client sends
   * back is the label we rendered, so an exact (normalized) comparison against the offer is
   * both sufficient and the only thing that cannot drift: re-running retrieval on "welder"
   * would re-enter the very ambiguity the chips were built to settle, and could land on a
   * different occupation than the chip the worker actually looked at.
   */
  private async settleOffer(
    envelope: ProfilingEnvelope,
    text: string,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    const typed = normalizeOccupationText(text);
    const tapped = envelope.disambiguationOffer.find(
      (chip) => normalizeOccupationText(chip.label) === typed,
    );

    // No chip matched. The worker typed something else entirely rather than tapping — which is
    // an ANSWER, not a failure: they are telling us their trade in their own words again. Clear
    // the offer and let the next turn run the ladder on what they said, inside the attempt
    // budget that already bounds this.
    if (tapped === undefined) {
      this.logger.log(
        `disambiguation offer for session ${ctx.sessionId} was answered with free text; ` +
          `clearing the chips and re-running retrieval on the next turn`,
      );
      return {
        patch: { needsDisambiguation: false, disambiguationOffer: [] },
        offer: null,
        pinned: null,
      };
    }

    // The escape. `jobDomainId: null` is the only chip that carries no occupation, so this is
    // structural rather than a label comparison against "Kuch aur".
    if (tapped.jobDomainId === null) {
      await this.emitUnresolved(ctx, "ambiguous", null, null);
      return {
        patch: {
          needsDisambiguation: false,
          disambiguationOffer: [],
          // COUNTS AS AN EXHAUSTED ATTEMPT, not a fresh start. The worker has now seen our best
          // four guesses and rejected all of them; running the same ladder on the same
          // conversation would offer the same chips again.
          identifyAttempts: MAX_IDENTIFY_ATTEMPTS,
        },
        offer: null,
        pinned: null,
      };
    }

    const described = this.occupation.describeDomain(tapped.jobDomainId);
    if (described === null) {
      // The catalogue moved under a live conversation (a refresh deprecated the row). Fail to
      // the universal pack rather than pinning an id the pack resolver cannot describe.
      this.logger.error(
        `chip resolved to ${tapped.jobDomainId}, which the current snapshot does not describe; ` +
          `session ${ctx.sessionId} falls back to the universal pack`,
      );
      return {
        patch: { needsDisambiguation: false, disambiguationOffer: [], identifyAttempts: MAX_IDENTIFY_ATTEMPTS },
        offer: null,
        pinned: null,
      };
    }

    // THE HIGHEST-QUALITY SIGNAL IN THE SYSTEM, and it gets its own status. This is not our
    // inference about a worker's words; it is their explicit selection from a reviewed closed
    // set. Collapsing it into `matched_auto` would throw away the distinction that makes it
    // worth more than every other match in the table.
    const pin: OccupationPin = {
      job_domain_id: described.jobDomainId,
      label: described.label,
      isco_unit_code: described.iscoUnitCode,
      match_status: "matched_worker_confirmed",
      match_score: 1,
      match_layer: null,
      pack_id: null,
      pack_version: null,
      catalog_version: described.catalogVersion,
    };
    await this.emitIdentified(ctx, pin, tapped.familyId, envelope.disambiguationOffer.length);
    return {
      patch: {
        occupation: pin,
        needsDisambiguation: false,
        disambiguationOffer: [],
        catalogVersion: described.catalogVersion,
        phase: "occupation_specific",
      },
      offer: null,
      pinned: pin,
    };
  }

  /** The ladder cleared the auto floor by the family margin. Pin it and move on. */
  /**
   * The worker contradicted the trade we pinned — *"ab tempo chalata hun"* (risk #12).
   *
   * TWO CONDITIONS, BOTH REQUIRED, and together they are what makes this safe enough to enable
   * at all. Phase 8 shipped ZERO re-pins because "nothing distinguishes 'I changed trades' from
   * 'I mentioned a second machine'". These are that distinction:
   *
   *   1. `auto` — the ladder cleared AUTO_FLOOR *and* AUTO_MARGIN at FAMILY level. A worker
   *      naming a second machine inside their own trade does not produce a confident,
   *      well-separated match on a different family; it produces a weak one or nothing.
   *   2. A DIFFERENT family. Comparing job domains instead would fire on "Welder, Gas" versus
   *      "Welder, Electric" — a coin flip by construction — and swap the pack for the one the
   *      interview already had, discarding progress to arrive back where it started.
   *
   * ONE, then never again. The bound is not about the second re-pin being less trustworthy than
   * the first; it is that an interview which keeps changing packs never drains one, and a worker
   * who answers twelve questions across three trades has completed none of them.
   *
   * NEVER DISCARDS AN ANSWER. Only `unanswered` records are dropped, and only so the new pack's
   * questions arrive fresh rather than pre-marked as skipped. Every `answered`, `declined` and
   * `superseded` record survives verbatim — the plan's rule, and the reason a re-pin costs the
   * worker nothing they already said. `engineAsks` is deliberately NOT reset: it is the global
   * budget that guarantees termination, and refunding it would make a re-pin a way to run
   * forever.
   */
  private async maybeRepin(
    envelope: ProfilingEnvelope,
    text: string,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    if (envelope.occupationRepins >= MAX_OCCUPATION_REPINS) return NO_OP;

    const result = await this.occupation.resolve(text);
    if (result.status !== "auto") return NO_OP;

    const top = result.pinned;
    const family = top?.familyId ?? null;
    // A re-pin with no family to compare against cannot satisfy condition 2, so it is refused
    // rather than guessed at — an unfamilied candidate is exactly the shape whose pack cannot
    // be resolved either.
    if (top === null || family === null || family === envelope.occupationFamilyId) return NO_OP;

    const repinned = await this.pin(result, "matched_lexical", ctx);
    if (repinned.pinned === null) return NO_OP;

    const kept = envelope.answerMap.filter((a) => a.status !== "unanswered");
    const dropped = envelope.answerMap.length - kept.length;
    // Clear the ask budget for the questions just dropped, so a key the NEW pack also owns is
    // askable again. Without this the new pack inherits the old pack's exhausted counters and
    // silently skips its own questions.
    const droppedKeys = new Set(
      envelope.answerMap.filter((a) => a.status === "unanswered").map((a) => a.question_key),
    );
    const askCounts = Object.fromEntries(
      Object.entries(envelope.askCounts).filter(([key]) => !droppedKeys.has(key)),
    );

    this.logger.log(
      `occupation re-pinned session=${ctx.sessionId} family=${envelope.occupationFamilyId ?? "-"}` +
        `→${family} repins=${envelope.occupationRepins + 1}/${MAX_OCCUPATION_REPINS}; ` +
        `kept ${kept.length} answer(s), dropped ${dropped} unanswered question(s)`,
    );

    return {
      ...repinned,
      patch: {
        ...repinned.patch,
        occupationRepins: envelope.occupationRepins + 1,
        answerMap: kept,
        askCounts,
      },
    };
  }

  private async pin(
    result: ResolveResult,
    status: "matched_lexical",
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    const top = result.pinned;
    // Defensive: `auto` without a pinned candidate is a contradiction the service cannot
    // produce today. Treated as "keep asking" rather than trusted, because the alternative is
    // dereferencing null on the chat hot path.
    if (top === null || result.catalogVersion === null) return NO_OP;

    const pin: OccupationPin = {
      job_domain_id: top.jobDomainId,
      label: top.label,
      isco_unit_code: top.iscoUnitCode,
      match_status: status,
      match_score: top.confidence,
      match_layer: LAYER_TO_CONTRACT[top.layer],
      pack_id: null,
      pack_version: null,
      catalog_version: result.catalogVersion,
    };
    await this.emitIdentified(ctx, pin, top.familyId, result.candidates.length);
    return {
      patch: {
        occupation: pin,
        // The re-pin comparison key (risk #12). Recorded HERE, at the one place a pin is
        // minted, so the chip path and the auto path cannot disagree about which family a
        // worker was placed in.
        occupationFamilyId: top.familyId ?? null,
        needsDisambiguation: false,
        disambiguationOffer: [],
        catalogVersion: result.catalogVersion,
        phase: "occupation_specific",
      },
      offer: null,
      pinned: pin,
    };
  }

  /**
   * Several families are plausible. Show the worker the choice rather than guessing.
   *
   * THE ESCAPE IS APPENDED HERE, not by the matcher, because it is a CONVERSATIONAL affordance
   * and not a retrieval result — it resolves to no occupation at all, which is a shape
   * `ResolvedCandidate` has no way to express.
   */
  private async offer(
    result: ResolveResult,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    const chips: OfferedChip[] = result.disambiguationOptions.map((option) => ({
      label: option.label,
      jobDomainId: option.jobDomainId,
      familyId: option.familyId,
    }));

    // An offer of one is not a choice, and an offer of none is a blank screen. Either means the
    // matcher found ambiguity it could not render — give up cleanly instead of asking a question
    // with nothing to answer it with.
    if (chips.filter((chip) => chip.jobDomainId !== null).length < 2) {
      this.logger.warn(
        `disambiguate status for session ${ctx.sessionId} produced fewer than two real chips; ` +
          `treating it as unresolved`,
      );
      await this.emitUnresolved(ctx, "ambiguous", result.catalogVersion, result.candidates[0] ?? null);
      return { patch: { identifyAttempts: MAX_IDENTIFY_ATTEMPTS }, offer: null, pinned: null };
    }

    if (!chips.some((chip) => chip.jobDomainId === null)) {
      chips.push({ label: DISAMBIGUATION_ESCAPE_LABEL, jobDomainId: null, familyId: null });
    }

    return {
      patch: {
        needsDisambiguation: true,
        disambiguationOffer: chips,
        phase: "disambiguate",
        catalogVersion: result.catalogVersion ?? null,
      },
      offer: {
        prompt: DISAMBIGUATION_PROMPT,
        chips,
        options: chips.map((chip, index) => toPackOption(chip, index)),
      },
      pinned: null,
    };
  }

  /**
   * Nothing cleared the floor, or retrieval itself is down.
   *
   * THE TWO ARE RECORDED DIFFERENTLY AND THAT IS THE POINT. A below-floor miss is a CATALOGUE
   * GAP — the phrase goes to the growth queue, ops promotes it to an alias, and the next worker
   * who says it hits L0 for free. A degraded seam is an INCIDENT, and feeding it into the growth
   * queue would fill an ops backlog with phrases that were never actually missing.
   */
  private async giveUp(
    envelope: ProfilingEnvelope,
    result: ResolveResult,
    text: string,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    const attempts = envelope.identifyAttempts + 1;
    const exhausted = attempts >= MAX_IDENTIFY_ATTEMPTS;
    const degraded = result.status === "degraded";

    // RECORDED ONLY ON THE LAST ATTEMPT. The first miss is frequently a greeting; queueing it
    // would fill the growth queue with "namaste" and bury the phrases that are genuinely
    // missing trades. One record per interview, at the point we actually gave up.
    if (exhausted && !degraded) await this.recordPhrase(text, ctx);
    if (exhausted) {
      await this.emitUnresolved(
        ctx,
        degraded ? "degraded" : "below_floor",
        result.catalogVersion,
        result.candidates[0] ?? null,
      );
    }

    return {
      patch: { identifyAttempts: attempts, needsDisambiguation: false, disambiguationOffer: [] },
      offer: null,
      pinned: null,
    };
  }

  /**
   * Send the phrase to the growth queue — PSEUDONYMIZED FIRST, always.
   *
   * THE HOP IS NOT AVOIDABLE AND IS NOT REGRETTED. `unresolved_phrase`'s contract is
   * pseudonymized text only (SG-1), the pseudonymizer lives in the ai-service, and this is the
   * one place in the deterministic turn loop where worker text would otherwise leave memory. It
   * is also the ONLY outbound call the entire interview makes, it happens at most once per
   * interview, and it is on the miss path — so the plan's "zero LLM calls between session start
   * and completion" is untouched: this is a regex pass, not a model.
   *
   * BEST EFFORT, ALWAYS. A pseudonymizer that is down or that BLOCKS the text costs us a growth
   * queue entry. Letting that fail a worker's turn would trade a real interview for an ops
   * nicety, so every failure path here logs and returns.
   */
  private async recordPhrase(
    text: string,
    ctx: { readonly sessionId: string } & RequestContext,
  ): Promise<void> {
    try {
      const safe = await this.ai.pseudonymize(text);
      if (safe === null || safe.blocked) {
        this.logger.warn(
          `not queueing an unresolved occupation phrase for session ${ctx.sessionId}: ` +
            `pseudonymizer ${safe === null ? "unreachable" : "blocked the text"}`,
        );
        return;
      }
      await this.occupation.recordUnresolved(safe.pseudonymized_text, "hi");
    } catch (err) {
      this.logger.warn(
        `unresolved-phrase recording failed for session ${ctx.sessionId} (the interview is ` +
          `unaffected): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async emitIdentified(
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
    pin: OccupationPin,
    familyId: string | null,
    candidateCount: number,
  ): Promise<void> {
    await this.events.emit({
      event_name: "profile.occupation_identified",
      actor: { actor_type: "worker", actor_id: ctx.workerId },
      subject: { subject_type: "chat_session", subject_id: ctx.sessionId },
      payload: {
        worker_id: ctx.workerId,
        session_id: ctx.sessionId,
        job_domain_id: pin.job_domain_id,
        family_id: familyId,
        pack_id: pin.pack_id,
        pack_version: pin.pack_version,
        // Narrowed from the seven-value column vocabulary to the three an IDENTIFICATION can
        // actually produce. The payload enum rejects the rest, so a future caller cannot emit
        // an "identified" event about a worker nobody identified.
        match_status: pin.match_status as "matched_auto" | "matched_lexical" | "matched_worker_confirmed",
        match_layer: pin.match_layer,
        match_score: pin.match_score,
        // The pin's `catalog_version` is nullable in the contract (an `rvm` row minted outside
        // a release has none); the payload's is not, because the Phase 9 sweep groups by it and
        // a null bucket is a hole in the histogram rather than a category. `unknown` is a
        // SENTINEL and reads as one — inventing a plausible version string would be worse.
        //
        // PROJECTED, not passed through: the catalogue version is a six-field cache signature
        // carrying two ISO timestamps, and the payload caps this at 64 characters. See
        // `catalogVersionForEvent`.
        catalog_version: catalogVersionForEvent(pin.catalog_version),
        candidate_count: candidateCount,
      },
      // ONE PER SESSION, because the engine pins exactly once. A retry of the same turn after a
      // lost CAS must not double-count a placement in the layer histogram.
      idempotencyKey: `profile.occupation_identified:${ctx.sessionId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  private async emitUnresolved(
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
    reason: "below_floor" | "ambiguous" | "declined" | "degraded",
    catalogVersion: string | null,
    best: { readonly confidence: number; readonly layer: keyof typeof LAYER_TO_CONTRACT } | null,
  ): Promise<void> {
    await this.events.emit({
      event_name: "profile.occupation_unresolved",
      actor: { actor_type: "worker", actor_id: ctx.workerId },
      subject: { subject_type: "chat_session", subject_id: ctx.sessionId },
      payload: {
        worker_id: ctx.workerId,
        session_id: ctx.sessionId,
        reason,
        best_score: best?.confidence ?? null,
        deepest_layer: best ? LAYER_TO_CONTRACT[best.layer] : null,
        // A miss with no snapshot has no catalogue version to name. The literal is a sentinel,
        // not a version: the payload requires a non-empty string, and inventing a plausible
        // version number would make a degraded seam indistinguishable from a real release in
        // the Phase 9 sweep.
        //
        // PROJECTED, not passed through — and this is the line that 500'd every unresolved
        // turn on a real catalogue. See `catalogVersionForEvent`.
        catalog_version: catalogVersionForEvent(catalogVersion),
      },
      idempotencyKey: `profile.occupation_unresolved:${ctx.sessionId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}

/** Retrieval's internal layer names → the contract's. Two vocabularies, one crosswalk. */
const LAYER_TO_CONTRACT = {
  L0: "l0_exact",
  L1: "l1_skeleton",
  L2: "l2_trigram",
  L3: "l3_vector",
} as const;

/**
 * The synthesised chip key, as a slug `QuestionPackOptionSchema` will actually accept.
 *
 * `occ_${index}` WAS NOT ONE. `option_key` is `slugKey` — `/^[a-z_]+$/`, no digits — so every
 * catalogue chip failed that parse, and nothing caught it because {@link toPackOption} is TYPED
 * as a `QuestionPackOption` rather than parsed into one. The cost was not cosmetic: `narrowLastTurn`
 * validates cached chips with `z.array(QuestionPackOptionSchema).safeParse`, which is all-or-nothing,
 * so one `occ_0` emptied the whole offer on the way out of Redis while `kind: "disambiguate"`
 * survived — a single-select with no options, on a replay, for a worker who cannot type.
 *
 * Bijective base-26, so it stays a slug at any offer size: 0→`occ_a`, 25→`occ_z`, 26→`occ_aa`.
 */
function occKey(index: number): string {
  let n = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `occ_${suffix}`;
}

/**
 * A chip as the client already knows how to render it.
 *
 * REUSING `QuestionPackOption` RATHER THAN MINTING A SECOND CHIP SHAPE is what keeps the
 * Flutter client unchanged through the cutover: `suggested_followups` has always been a list of
 * option labels, and a disambiguation chip is an option like any other as far as the wire is
 * concerned. `option_key` is synthesised because these chips come from the catalogue, not from
 * a pack row — and it is never read back, since the tap is resolved through the stored offer.
 * Never read back is exactly why the shape of the key was free to be wrong for as long as it was.
 */
export function toPackOption(chip: OfferedChip, index: number): QuestionPackOption {
  return {
    option_key: chip.jobDomainId === null ? DISAMBIGUATION_ESCAPE_KEY : occKey(index),
    label_text: chip.label,
    // The label IS the value: a disambiguation chip's answer of record is the words the worker
    // tapped, and the occupation it resolves to is carried by the stored offer, not by this.
    value: chip.label,
    implies_skill_id: null,
    is_none_of_above: chip.jobDomainId === null,
  };
}
