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
import { hasFirstPersonClaim, type UtteranceClass } from "@badabhai/profiling-lexicon";

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
 * How many CONSECUTIVE non-answer turns a disambiguation offer or the type-your-trade prompt may
 * be re-served for before the interview gives up on it (#1506 HIGH-1).
 *
 * TWO, matching `MAX_CONSECUTIVE_HARDSHIP` — one re-serve, then the offer is abandoned. Both
 * `settleOffer` and `settleTypedTrade` share {@link ProfilingEnvelope.identifyStalledTurns} as the
 * SAME counter: a worker who says "pata nahi" under the chips and then "pata nahi" again after
 * being asked to type is still not answering either way, and two separate budgets would double how
 * long this can hold the interview open.
 *
 * WITHOUT THIS BOUND, repeating "pata nahi" under a live offer re-serves the same chips forever:
 * `identifyAttempts` is not touched by a non-answer under an offer, so `MAX_IDENTIFY_ATTEMPTS`
 * never fires, and the re-serve returns straight to the worker without ever reaching
 * `nextQuestion` — the one place `abuse_cap`, `ask_budget` and `turn_cap` are decided. See the
 * class docblock on `NOT_A_TRADE_STATEMENT`.
 *
 * NOT FOR AN ABUSIVE TURN. An abusive message under an offer or the prompt never re-serves and
 * never spends this counter — `identify` only sees the `abusive` class at all once
 * `ProfilingOrchestrator`'s own abusive-turn branch has already let it fall through, which happens
 * exactly when `abusiveTurns` has reached `MAX_ABUSIVE_TURNS`; see {@link IdentifyService.settleOffer}.
 */
export const MAX_IDENTIFY_STALLED_TURNS = 2;

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

/**
 * Served when a worker taps "Kuch aur" on a disambiguation offer (#1506).
 *
 * AN INSTRUCTION, NOT A QUESTION, and it names what to type. The worker has just told us none of
 * our four guesses is their trade; the one useful next move is their own words, and the answer is
 * resolved once on the next turn and never turned back into chips. Aap-form, no question mark, no
 * exclamation — the same persona rules every engine line is held to in `persona-copy.test.ts`.
 */
export const IDENTIFY_TYPE_PROMPT = "Apna kaam apne shabdon mein likhiye.";

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
  /**
   * A chipless engine line the orchestrator must serve INSTEAD of consulting the engine — today
   * only {@link IDENTIFY_TYPE_PROMPT}. Never set together with `offer`.
   */
  readonly prompt: string | null;
  /**
   * The worker's OWN statement of their trade — words they typed over the chips, words they typed
   * after "Kuch aur", or the label of the chip they tapped. The orchestrator settles the trade
   * question from it verbatim, superseding whatever that question held.
   *
   * RAW TEXT, NEVER AN ID (owner ruling 2026-09-15). A canonical occupation comes only from the
   * deterministic ladder, through `pinned`; this is the worker's answer of record, kept out of
   * matching until ops maps it.
   */
  readonly tradeText: string | null;
}

const NO_OP: IdentifyResult = { patch: {}, offer: null, pinned: null, prompt: null, tradeText: null };

/**
 * Turn classes that carry no statement of a trade.
 *
 * WHY THIS GUARD EXISTS (#1506). Typed text over the chips is now resolved on the SAME turn and
 * settles the trade question. Silence, "." and a hardship line reach `identify` too — the capture
 * step no longer re-serves a stale pack question while an offer is on screen — and resolving them
 * would spend an identify attempt and write "." as a worker's trade. `dont_know` is here for the
 * same reason: "pata nahi" answers no question about which trade they do, and settling it as one
 * would print it on a résumé.
 */
const NOT_A_TRADE_STATEMENT: ReadonlySet<UtteranceClass> = new Set<UtteranceClass>([
  "empty",
  "hardship",
  "question_back",
  "abusive",
  "dont_know",
]);

/**
 * The shape of a chip key THIS FILE synthesizes — never a worker's own words (#1506 MEDIUM-2).
 *
 * `occ_${slug}` is {@link occKey} (a disambiguation chip's position) and `llm_${slug}` is
 * `toLlmOption`'s (a model chip's), both minted by {@link slugIndexKey}: a prefix, an underscore,
 * and ONE OR MORE LOWERCASE LETTERS — never digits, matching the bijective base-26 counter that
 * mints them (`occ_a`, `occ_b`, … `occ_z`, `occ_aa`, …). No other caller in this codebase mints an
 * `option_key` through `slugIndexKey`, so this pattern names exactly the two prefixes that exist.
 *
 * WHY THIS MUST BE CHECKED ON THE RAW TEXT. `normalizeOccupationText("occ_a")` is `"occ a"` — the
 * SAME shape a worker's own two-word answer would normalize to — so the tell (a literal
 * underscore, no space) is only visible before that pass runs.
 */
const SYNTHESIZED_OPTION_KEY = /^(?:occ|llm)_[a-z]+$/i;

/**
 * Could this text be a worker's own statement of their trade? (#1506 HIGH-1 / MEDIUM-2)
 *
 * THE OPTION-KEY VETO (MEDIUM-2). The wire contract for a chip tap is its `option_key`, not its
 * label — {@link IdentifyService.settleOffer} matches both — but a key that matches NEITHER the
 * offer on screen NOR any label is not a trade a worker typed; it is a synthesized chip key that
 * arrived stale (a race between two offers) or malformed, and treating it as an answer used to
 * write it verbatim to `primary_trade` and, on a below-floor miss, queue it to the growth corpus
 * — literal ASCII slugs like "occ_a" polluting a Hindi/Hinglish phrase list built for ops to read.
 */
function statesATrade(text: string, turnClass: UtteranceClass): boolean {
  const trimmed = text.trim();
  if (SYNTHESIZED_OPTION_KEY.test(trimmed)) return false;
  return normalizeOccupationText(text).length > 0 && !NOT_A_TRADE_STATEMENT.has(turnClass);
}

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
    /**
     * How the lexicon classified this message. REQUIRED, because the two branches that settle a
     * worker's own words must not run on a silence or a hardship line — see
     * {@link NOT_A_TRADE_STATEMENT}. Optional would let a new caller skip the guard silently.
     */
    turnClass: UtteranceClass,
  ): Promise<IdentifyResult> {
    // Already pinned. One re-pin is allowed (risk #12) — see {@link maybeRepin} for the two
    // conditions that make it safe.
    if (envelope.occupation !== null) return this.maybeRepin(envelope, text, ctx);

    // The worker was asked to type their trade after "Kuch aur". This message is that answer, and
    // it is resolved ONCE — never turned back into chips, which is what makes the escape terminate.
    if (envelope.identifyTypeRequested) return this.settleTypedTrade(envelope, text, turnClass, ctx);

    // An outstanding offer OWNS this turn's message: it is a chip tap or a rejection of the
    // chips, never a fresh phrase to run the ladder on.
    if (envelope.needsDisambiguation && envelope.disambiguationOffer.length > 0) {
      return this.settleOffer(envelope, text, turnClass, ctx);
    }

    if (envelope.identifyAttempts >= MAX_IDENTIFY_ATTEMPTS) return NO_OP;

    // THE BUDGET RULE, stated once (#1506), because two readings of it cannot both hold at
    // MAX_IDENTIFY_ATTEMPTS = 2 (owner ruling 2026-09-15: it stays 2):
    //
    //   - an OFFER spends one attempt, in {@link offer};
    //   - the resolve that PRODUCED that offer spends nothing extra;
    //   - a resolve that ends UNRESOLVED spends one, in {@link giveUp};
    //   - a PIN spends nothing.
    //
    // Charging the producing resolve as well would make a first-message disambiguation cost two
    // and exhaust the budget before the worker's typed answer over the chips could ever be
    // resolved — the fix would then be unreachable on its most common path.
    const result = await this.occupation.resolve(text);
    switch (result.status) {
      case "auto":
        return this.pin(result, "matched_lexical", ctx);
      case "disambiguate":
        return this.offer(envelope, result, ctx);
      default:
        return this.giveUp(envelope, result, text, ctx);
    }
  }

  /**
   * Abandon the offer or the type-your-trade prompt currently on screen: no re-serve, and the
   * fields that would otherwise leave `nextQuestion` looking at a question no longer displayed are
   * cleared (#1506 HIGH-1).
   *
   * `identifyStalledTurns` IS ALWAYS PART OF THE RESET, not left to each caller, because every
   * path that reaches here — the stall bound, or an abusive turn — is the SAME kind of ending: the
   * episode that was counting non-answers is over, one way or another.
   *
   * EMITS `profile.occupation_unresolved` for the stall case ONLY (`emit` defaults `true`, and the
   * abusive caller below passes `false`): a worker who is asked twice and never states a trade has
   * produced the platform's "nothing can follow" signal, the same one the escape branch emits when
   * its budget is spent. An abusive turn is a different thing — a safety-valve close, not a
   * catalogue gap — and reporting it as one would tell ops their trade list is missing a phrase
   * that was never actually offered a fair chance to answer.
   */
  private async giveUpOnStall(
    patch: Partial<ProfilingEnvelope>,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
    emit = true,
  ): Promise<IdentifyResult> {
    if (emit) await this.emitUnresolved(ctx, "ambiguous", null, null);
    return { ...NO_OP, patch: { identifyStalledTurns: 0, ...patch } };
  }

  /**
   * The answer to {@link IDENTIFY_TYPE_PROMPT} — the worker's trade, in their own words.
   *
   * THE FLAG IS CLEARED ONLY BY AN ANSWER. A silence or a hardship line leaves the prompt on
   * screen, exactly as it leaves an offer on screen, rather than spending the one resolve on
   * nothing and settling "." as a trade — but only up to {@link MAX_IDENTIFY_STALLED_TURNS}
   * (#1506 HIGH-1): past that, and for an abusive turn immediately, the prompt is abandoned rather
   * than re-served forever. See {@link IdentifyService.settleOffer}, which bounds the same way for
   * the same reason and shares the counter.
   */
  private async settleTypedTrade(
    envelope: ProfilingEnvelope,
    text: string,
    turnClass: UtteranceClass,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    // NEVER RE-SERVED. `identify` only sees `abusive` here once `abusiveTurns` has already
    // reached `MAX_ABUSIVE_TURNS` in the orchestrator — see the constant's docblock — so falling
    // through immediately is always safe: `nextQuestion` closes with `abuse_cap` on the very next
    // call, checked before it ever looks at `needsDisambiguation` or this flag.
    if (turnClass === "abusive") {
      return this.giveUpOnStall({ identifyTypeRequested: false }, ctx, false);
    }
    if (!statesATrade(text, turnClass)) {
      const stalled = envelope.identifyStalledTurns + 1;
      if (stalled >= MAX_IDENTIFY_STALLED_TURNS) {
        return this.giveUpOnStall({ identifyTypeRequested: false }, ctx);
      }
      return { ...NO_OP, patch: { identifyStalledTurns: stalled }, prompt: IDENTIFY_TYPE_PROMPT };
    }
    // `false`: when the budget was already spent, the unresolved signal was emitted at the tap
    // (see `settleOffer`), so there is no second outcome to report here.
    const settled = await this.resolveOwnWords(envelope, text, ctx, false);
    return { ...settled, patch: { ...settled.patch, identifyTypeRequested: false } };
  }

  /**
   * Resolve the worker's own statement of their trade on THIS turn, inside the attempt budget.
   *
   * THE DEFECT THIS REPLACES (#1506.3 / #1505.3). Free text over the chips used to clear the offer
   * and defer retrieval to the NEXT message — which answers a different question — so a worker
   * who typed "main electrician hoon" over four wrong guesses was simply asked something else.
   *
   * EVERY OUTCOME RETURNS `tradeText`, a pin included: the worker's words are their answer of
   * record whether or not the ladder recognises them, and a pin that left the trade question
   * holding an earlier ambiguous phrase would print that phrase on the résumé instead.
   *
   * NEVER A SECOND OFFER. A same-turn `disambiguate` is treated as unresolved: the worker has
   * already rejected one list, and a second is how this became a loop.
   */
  private async resolveOwnWords(
    envelope: ProfilingEnvelope,
    text: string,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
    emitWhenSpent: boolean,
  ): Promise<IdentifyResult> {
    const tradeText = text.trim();
    if (envelope.identifyAttempts >= MAX_IDENTIFY_ATTEMPTS) {
      // Budget already spent: no retrieval, but still the worker's own words — and, when no
      // earlier step reported it, the one unresolved signal this interview will produce.
      if (emitWhenSpent) await this.emitUnresolved(ctx, "ambiguous", null, null);
      return {
        ...NO_OP,
        patch: { needsDisambiguation: false, disambiguationOffer: [], identifyStalledTurns: 0 },
        tradeText,
      };
    }

    const result = await this.occupation.resolve(text);
    if (result.status === "auto") {
      const pinned = await this.pin(result, "matched_lexical", ctx);
      if (pinned.pinned !== null) return { ...pinned, tradeText };
    }
    const reason =
      result.status === "degraded"
        ? "degraded"
        : result.status === "unresolved"
          ? "below_floor"
          : "ambiguous";
    const gaveUp = await this.giveUp(envelope, result, text, ctx, reason);
    return { ...gaveUp, tradeText };
  }

  /**
   * A worker tapped a chip — or told us none of them fit.
   *
   * RESOLVED THROUGH THE STORED MAP, NEVER BY RE-MATCHING THE TEXT. The label OR the key the
   * client sends back is what we rendered, so an exact (normalized) comparison against the offer
   * is both sufficient and the only thing that cannot drift: re-running retrieval on "welder"
   * would re-enter the very ambiguity the chips were built to settle, and could land on a
   * different occupation than the chip the worker actually looked at.
   *
   * MATCHED ON EITHER THE LABEL OR THE `option_key` (#1506 MEDIUM-2). The wire contract for a tap
   * is the key, not the label; matching only the label meant a client sending it correctly (as
   * the schema says to) could tap the ESCAPE without matching anything here, because "kuch_aur"
   * happened to normalize the same as "Kuch aur" only by coincidence — the underscore folds to a
   * space the same way a real two-word label's own space does — and any OTHER chip's key
   * (`occ_a`, `occ_b`, …) never matched a label at all and fell through to be treated as the
   * worker's own typed trade. The key is matched on the RAW text, never normalized: normalizing
   * "occ_a" to "occ a" is indistinguishable from a genuine two-word answer.
   */
  private async settleOffer(
    envelope: ProfilingEnvelope,
    text: string,
    turnClass: UtteranceClass,
    ctx: { readonly sessionId: string; readonly workerId: string } & RequestContext,
  ): Promise<IdentifyResult> {
    const typed = normalizeOccupationText(text);
    const rawTyped = text.trim().toLowerCase();
    const tapped = envelope.disambiguationOffer.find((chip, index) => {
      if (normalizeOccupationText(chip.label) === typed) return true;
      return toPackOption(chip, index).option_key.toLowerCase() === rawTyped;
    });

    if (tapped === undefined) {
      // ABUSIVE UNDER AN OFFER NEVER RE-SERVES (#1506 HIGH-1). `identify` only sees this class at
      // all once `ProfilingOrchestrator`'s own abusive-turn branch has already let it fall through
      // — which happens exactly when `abusiveTurns` has reached `MAX_ABUSIVE_TURNS`, since that
      // branch returns early for every turn below the cap. Re-serving the chips here used to
      // bypass `nextQuestion` entirely and loop forever, `abusiveTurns` climbing with no effect;
      // clearing the offer instead lets the very next call reach `nextQuestion`, where the
      // abuse-cap check runs BEFORE the disambiguate check and closes the interview.
      if (turnClass === "abusive") {
        return this.giveUpOnStall(
          { needsDisambiguation: false, disambiguationOffer: [] },
          ctx,
          false,
        );
      }
      // NOT AN ANSWER — silence, ".", a hardship line, "pata nahi", "kyun?". The chips STAY ON
      // SCREEN: re-served as they were, with nothing spent and nothing settled — but only up to
      // {@link MAX_IDENTIFY_STALLED_TURNS} (#1506 HIGH-1): past that the offer is abandoned rather
      // than re-served forever, because none of `hardshipTurns`/`silentTurns`/`clarifyCount` reach
      // this point to bound it themselves — see {@link ProfilingEnvelope.identifyStalledTurns}.
      // Clearing the chips WITHOUT also clearing `needsDisambiguation` used to hand the turn to an
      // engine whose next decision, with that flag still set, is a blank offer; `giveUpOnStall`
      // clears both together.
      if (!statesATrade(text, turnClass)) {
        const stalled = envelope.identifyStalledTurns + 1;
        if (stalled >= MAX_IDENTIFY_STALLED_TURNS) {
          return this.giveUpOnStall(
            { needsDisambiguation: false, disambiguationOffer: [] },
            ctx,
          );
        }
        return {
          ...NO_OP,
          patch: { identifyStalledTurns: stalled },
          offer: {
            prompt: DISAMBIGUATION_PROMPT,
            chips: envelope.disambiguationOffer,
            options: envelope.disambiguationOffer.map((chip, index) => toPackOption(chip, index)),
          },
        };
      }
      // The worker typed their trade instead of tapping — an ANSWER, not a failure. Resolved on
      // THIS turn; see {@link resolveOwnWords} for why the next turn was the wrong place.
      this.logger.log(
        `disambiguation offer for session ${ctx.sessionId} was answered with free text; ` +
          `resolving it on this turn (attempts=${envelope.identifyAttempts}/${MAX_IDENTIFY_ATTEMPTS})`,
      );
      return this.resolveOwnWords(envelope, text, ctx, true);
    }

    // The escape. `jobDomainId: null` is the only chip that carries no occupation, so this is
    // structural rather than a label comparison against "Kuch aur".
    //
    // ASK FOR THE WORKER'S OWN WORDS, NOT GIVE UP (#1506.4). This used to jump `identifyAttempts`
    // to MAX, after which retrieval never ran again and nothing asked the worker what they DO do —
    // a dead end for exactly the worker whose trade our four guesses missed. Now the prompt is
    // served, the next answer is resolved once, and no attempt is charged for the tap itself: the
    // offer that put the escape on screen already paid for it.
    if (tapped.jobDomainId === null) {
      // EMITTED AT THE TAP ONLY WHEN NOTHING CAN FOLLOW. With budget left, the unresolved event
      // waits for the typed answer so it carries the real reason — the event is idempotent per
      // session, and an early `ambiguous` silently swallowed the later `below_floor`. With the
      // budget spent there is no later resolve, and a worker who abandons here must still leave
      // a signal.
      if (envelope.identifyAttempts >= MAX_IDENTIFY_ATTEMPTS) {
        await this.emitUnresolved(ctx, "ambiguous", null, null);
      } else {
        // KNOWN GAP, NOT SILENTLY ACCEPTED (#1506 review, MEDIUM-1). With budget left this waits
        // for the typed answer — but {@link MAX_IDENTIFY_STALLED_TURNS} is what makes that answer
        // arrive at all; a worker who taps here and then sends nothing further still leaves no
        // `profile.occupation_unresolved`, which is this platform's funnel signal for "the
        // catalogue has a gap". The fix on the table is emitting here UNCONDITIONALLY, keyed
        // `profile.occupation_unresolved:${sessionId}:${reason}` so it cannot swallow a later,
        // more specific reason — but that changes the per-session idempotency contract the test
        // directly above this one pins as deliberate ("an early `ambiguous` would win... and hide
        // it"), so it is an event-contract call for the architect, not this diff. A log line
        // — counted, not a business event, nothing added to `events` — is the cheap placeholder
        // until that call is made.
        this.logger.log(
          `disambiguation escape tapped with identify budget left for session ${ctx.sessionId}; ` +
            `no profile.occupation_unresolved emitted yet (see #1506 MEDIUM-1)`,
        );
      }
      return {
        ...NO_OP,
        patch: {
          needsDisambiguation: false,
          disambiguationOffer: [],
          identifyTypeRequested: true,
          // A TAP IS AN ANSWER: this offer episode ended cleanly, not by exhaustion. The
          // type-prompt episode that follows, in {@link IdentifyService.settleTypedTrade}, starts
          // its own count at zero rather than inheriting whatever this offer had accumulated.
          identifyStalledTurns: 0,
        },
        prompt: IDENTIFY_TYPE_PROMPT,
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
        ...NO_OP,
        patch: {
          needsDisambiguation: false,
          disambiguationOffer: [],
          identifyAttempts: MAX_IDENTIFY_ATTEMPTS,
          identifyStalledTurns: 0,
        },
        // The worker still TAPPED this label, so it is still their answer of record.
        tradeText: tapped.label,
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
        // THE SAME KEY THE AUTO PATH RECORDS, and it was missing here. `pin()` says the family is
        // written "at the one place a pin is minted, so the chip path and the auto path cannot
        // disagree about which family a worker was placed in" — but there are TWO places that
        // mint a pin and only that one set it, so a worker who TAPPED their occupation ended the
        // turn with a null family. That is the highest-quality signal in the system, per the
        // comment above, arriving with less state than a lexical guess.
        occupationFamilyId: tapped.familyId ?? null,
        needsDisambiguation: false,
        disambiguationOffer: [],
        catalogVersion: described.catalogVersion,
        phase: "occupation_specific",
      },
      offer: null,
      pinned: pin,
      prompt: null,
      // THE LABEL THEY TAPPED IS THEIR ANSWER OF RECORD (#1506). It used to reach the trade
      // question only by accident, through a stale `servedQuestionKey` capture that no longer runs
      // under an offer; settling it explicitly keeps the résumé's trade line as the worker chose it.
      tradeText: tapped.label,
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

    // CONDITION 0, AND THE ONE THAT MAKES THE OTHER TWO REACHABLE SAFELY: the worker must be
    // CLAIMING a trade, not answering the question on screen.
    //
    // Without this the ladder ran over every message once pinned, and a pack answer is exactly the
    // shape that fools it — a CNC worker who taps the "Koi aur machine" chip on the machine-type
    // question was re-pinned to Milker on turn three, and because the budget is one, stayed there
    // for the rest of the interview. The occupation is not a per-turn opinion; it is a claim, and
    // `identify` already says so eight lines up: "re-running retrieval on turn nine, when the
    // worker is describing their machines, not their trade, is how a welder becomes a machine
    // operator halfway through their own interview".
    //
    // First-person claim is the right shape for it because it is what SEPARATES the two cases:
    // "ab tempo chalata hun" carries a first-person verb and "koi aur machine" carries nothing.
    // It is the same predicate the plan names for this, and it costs a regex instead of the four
    // retrieval layers this used to run on every single turn. Its `claimBlockers` half is a bonus
    // that matters here: "bhai welder hai" cannot re-pin a worker onto their brother's trade.
    //
    // KNOWN LIMIT, stated rather than discovered later: `firstPersonClaim` is Latin-Hinglish only,
    // so a re-pin typed in Devanagari does not fire and the worker keeps their original pin. That
    // is the failure this file already chooses everywhere else -- "a less specific interview and
    // never a lost one" -- and it is strictly better than the ungated behaviour it replaces, which
    // mis-pinned Devanagari and Latin answers alike. Widening the predicate is a lexicon change
    // shared with the skill-claim consumers (TD98/TD101), so it belongs in its own reviewed diff
    // against the dual-language fixture, not here.
    if (!hasFirstPersonClaim(text)) return NO_OP;

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
        // A PIN SETTLES ANY OFFER IN PROGRESS (#1506): whichever episode was counting
        // non-answers, chips or a typed prompt, is over now that there is an occupation.
        identifyStalledTurns: 0,
      },
      offer: null,
      pinned: pin,
      prompt: null,
      tradeText: null,
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
    envelope: ProfilingEnvelope,
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
      await this.emitUnresolved(
        ctx,
        "ambiguous",
        result.catalogVersion,
        result.candidates[0] ?? null,
      );
      return { ...NO_OP, patch: { identifyAttempts: MAX_IDENTIFY_ATTEMPTS } };
    }

    if (!chips.some((chip) => chip.jobDomainId === null)) {
      chips.push({ label: DISAMBIGUATION_ESCAPE_LABEL, jobDomainId: null, familyId: null });
    }

    return {
      ...NO_OP,
      patch: {
        needsDisambiguation: true,
        disambiguationOffer: chips,
        phase: "disambiguate",
        catalogVersion: result.catalogVersion ?? null,
        // AN OFFER SPENDS AN ATTEMPT (#1506) — see the budget rule in {@link identify}. Measured
        // before this: ten alternating turns (an ambiguous phrase, then free text) produced five
        // offers with `identifyAttempts` still 0, so the chips could come back without bound.
        identifyAttempts: envelope.identifyAttempts + 1,
        // A FRESH OFFER, A FRESH COUNT (#1506 HIGH-1). `envelope.identifyStalledTurns` can be
        // non-zero here only if an earlier offer was abandoned by the stall bound and a later
        // message re-entered retrieval; that earlier episode's count must not carry over and cut
        // this new offer's budget short before it has re-served even once.
        identifyStalledTurns: 0,
      },
      offer: {
        prompt: DISAMBIGUATION_PROMPT,
        chips,
        options: chips.map((chip, index) => toPackOption(chip, index)),
      },
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
    /**
     * Why it ended unresolved. Defaults from the status; the worker's own words over an offer pass
     * `ambiguous` when the ladder could only offer another list (#1506), which is not a catalogue
     * gap and must not be reported as one.
     */
    reason: "below_floor" | "ambiguous" | "degraded" = result.status === "degraded"
      ? "degraded"
      : "below_floor",
  ): Promise<IdentifyResult> {
    const attempts = envelope.identifyAttempts + 1;
    const exhausted = attempts >= MAX_IDENTIFY_ATTEMPTS;

    // RECORDED ONLY ON THE LAST ATTEMPT. The first miss is frequently a greeting; queueing it
    // would fill the growth queue with "namaste" and bury the phrases that are genuinely
    // missing trades. One record per interview, at the point we actually gave up.
    //
    // ONLY FOR A BELOW-FLOOR MISS. A degraded seam is an incident, and an ambiguous phrase is one
    // the catalogue already has several answers for — neither is a gap for ops to promote.
    if (exhausted && reason === "below_floor") await this.recordPhrase(text, ctx);
    if (exhausted) {
      await this.emitUnresolved(ctx, reason, result.catalogVersion, result.candidates[0] ?? null);
    }

    return {
      ...NO_OP,
      patch: {
        identifyAttempts: attempts,
        needsDisambiguation: false,
        disambiguationOffer: [],
        // Whatever offer this text was resolved against (if any) is settled, one way or another.
        identifyStalledTurns: 0,
      },
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
      // BL-19: the turn's own ids, so the gateway hop joins the request that triggered it.
      const safe = await this.ai.pseudonymize(text, {
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
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
        match_status: pin.match_status as
          | "matched_auto"
          | "matched_lexical"
          | "matched_worker_confirmed",
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
 * A synthesised chip key, as a slug `QuestionPackOptionSchema` will actually accept.
 *
 * `occ_${index}` WAS NOT ONE. `option_key` is `slugKey` — `/^[a-z_]+$/`, no digits — so every
 * catalogue chip failed that parse, and nothing caught it because {@link toPackOption} is TYPED
 * as a `QuestionPackOption` rather than parsed into one. The cost was not cosmetic: `narrowLastTurn`
 * validates cached chips with `z.array(QuestionPackOptionSchema).safeParse`, which is all-or-nothing,
 * so one `occ_0` emptied the whole offer on the way out of Redis while `kind: "disambiguate"`
 * survived — a single-select with no options, on a replay, for a worker who cannot type.
 *
 * Bijective base-26, so it stays a slug at any offer size: 0→`_a`, 25→`_z`, 26→`_aa`.
 *
 * EXPORTED because the LLM-led stretch mints chips the same way and for the same reason — its
 * options come from a model rather than from a pack row. One implementation, so a second caller
 * cannot rediscover the digit bug on its own.
 */
export function slugIndexKey(prefix: string, index: number): string {
  let n = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${prefix}_${suffix}`;
}

function occKey(index: number): string {
  return slugIndexKey("occ", index);
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
