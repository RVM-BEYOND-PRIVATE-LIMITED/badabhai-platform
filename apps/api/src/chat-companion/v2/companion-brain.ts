import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import type { CompanionRecentTurn } from "@badabhai/ai-contracts";
import type {
  CompanionV2ConfidenceBucket,
  CompanionV2Intent,
  CompanionV2IntentSourceV3,
  CompanionV3Intent,
  CompanionV3Outcome,
  FreeChatCategory,
  FreeChatNewsOutcome,
  FreeChatRefusalTopic,
  FreeChatReplyCategory,
  FreeChatReplyLanguage,
  FreeChatResumeAction,
} from "@badabhai/types";
import { resolveResumeMenu } from "../../chat/resume-menu";
import type { KnownNameSource } from "../../common/redact-known-name";
import type { RequestContext } from "../../common/request-context";
import { SERVER_CONFIG } from "../../config/config.module";
// VALUE imports: constructor parameters, resolved by Nest from the emitted `design:paramtypes`.
import {
  contextLinesOf,
  FreeChatModelCalls,
  type FreeChatCallContext,
} from "../../profiling/free-chat/free-chat-model-calls";
import {
  messageLanguage,
  parseLanguageRequest,
} from "../../profiling/free-chat/free-chat-language";
import { toWireNewsLinks } from "../../profiling/free-chat/free-chat-news-links";
import type { FreeChatNewsResolution } from "../../profiling/free-chat/free-chat-news";
import { screenFreeChatAnswer } from "../../profiling/free-chat/free-chat-output.validator";
import {
  confidenceBucketOf,
  FREE_CHAT_MIN_CONFIDENCE,
  type FreeChatVerdict,
} from "../../profiling/free-chat/free-chat.router";
import { FREE_CHAT_COPY, FREE_CHAT_REFUSAL_LINES } from "../../profiling/free-chat/free-chat.copy";
import { WorkerNameReader, type WorkerNameSources } from "../../workers/worker-name-sources";
import type { CompanionTurn } from "../chat-companion.dto";
import type { CompanionResumeDownload } from "../companion-facts";
import {
  RESUME_RENDER_FAILED,
  V3_DOWNLOAD_PENDING,
  V3_DOWNLOAD_READY,
  V3_JOBS,
  V3_NEWS_CAP,
  type CopyPair,
} from "../companion-replies";
import { downloadOption, withDownloadOption } from "../companion-resume-menu";
import { CompanionResumeStatus } from "../companion-resume-status";
import {
  jobsTabChip,
  taskChips,
  v2CareerAnswerTurn,
  v2CopyTurn,
  v2MenuTurn,
  v3NewsAnswerTurn,
  type V2Option,
} from "./companion-v2-compose";
import type { HandlerResult } from "./handlers/handler";
import { workerContextOf } from "./handlers/career-talk.handler";
import { isResumeOfferChip } from "./companion-resume-offer-chip";
import { CompanionSummaryService } from "./companion-summary.service";
import { CompanionHandlerRegistry } from "./handlers/registry";

/** One v1-miss message, as the orchestrator hands it to the brain after the gateway and memory. */
export interface BrainInput {
  readonly workerId: string;
  readonly profile: WorkerProfile;
  /**
   * The message AS TYPED — read LOCALLY only, by the deterministic language readers
   * (`parseLanguageRequest`, `messageLanguage`). Never sent anywhere, logged or stored.
   */
  readonly rawText: string;
  /** The ONE copy model calls and handlers see — the orchestrator's `promptTextOf`. */
  readonly promptText: string;
  /** The companion memory, oldest first (`CompanionMemoryStore.read`). */
  readonly recentTurns: readonly CompanionRecentTurn[];
  readonly ctx: RequestContext;
  readonly now: Date;
  readonly submissionId: string | null;
}

/**
 * One brain turn's input plus the worker's own name for REDACTION — the request's two views of one
 * lazy read (`WorkerNameReader`), shared by every model call the turn makes.
 */
interface NamedInput extends BrainInput {
  readonly names: WorkerNameSources;
}

/** What the brain decided, for `chat.companion_turn_served_v4` — closed enums and a count only. */
export interface BrainFacts {
  readonly freeCategory: FreeChatCategory | null;
  readonly resumeAction: FreeChatResumeAction | null;
  readonly refusalTopic: FreeChatRefusalTopic | null;
  readonly replyLanguage: FreeChatReplyLanguage | null;
  readonly newsOutcome: FreeChatNewsOutcome | null;
  readonly newsSourceCount: number;
}

/** The brain's answer: the turn, and the facts the orchestrator's memory and event need. */
export interface BrainTurn {
  readonly turn: CompanionTurn;
  readonly intentSource: CompanionV2IntentSourceV3;
  readonly v2Intent: CompanionV3Intent | null;
  readonly confidenceBucket: CompanionV2ConfidenceBucket | null;
  readonly outcome: CompanionV3Outcome;
  /**
   * False for a message the classifier called trash (the v2 rule — abuse is not context, at any
   * confidence) and for one answered with the distress line: neither is replayed to a later model.
   */
  readonly remember: boolean;
  readonly facts: BrainFacts;
}

/** What the classifier contributed — `intent_source`, the bucket, the category and the action. */
interface Verdicted {
  readonly intentSource: CompanionV2IntentSourceV3;
  readonly confidenceBucket: CompanionV2ConfidenceBucket | null;
  readonly freeCategory: FreeChatCategory | null;
  readonly resumeAction: FreeChatResumeAction | null;
}

/** An unavailable classifier: the fail-closed source, and no classifier fact at all. */
const UNAVAILABLE: Verdicted = {
  intentSource: "fallback",
  confidenceBucket: null,
  freeCategory: null,
  resumeAction: null,
};

/** One branch's own product, before the classifier's facts are added. */
interface Served {
  readonly turn: CompanionTurn;
  readonly v2Intent: CompanionV3Intent | null;
  readonly outcome: CompanionV3Outcome;
  readonly remember?: boolean;
  readonly refusalTopic?: FreeChatRefusalTopic | null;
  readonly replyLanguage?: FreeChatReplyLanguage | null;
  readonly news?: { readonly outcome: FreeChatNewsOutcome; readonly sourceCount: number };
}

/** The intent a non-résumé category is routed on. */
const CATEGORY_INTENTS: Readonly<Record<Exclude<FreeChatCategory, "resume">, CompanionV3Intent>> = {
  career: "career_talk",
  casual: "casual",
  jobs: "jobs_talk",
  trash: "faltu",
  off_limits: "off_limits",
  distress: "distress",
  unclear: "unclear",
};

/** The intent a `resume` category is routed on, by what the message wants. */
const RESUME_ACTION_INTENTS: Readonly<Record<FreeChatResumeAction, CompanionV3Intent>> = {
  edit: "edit_resume",
  new: "new_resume",
  download: "download_resume",
};

/** The line a download request is answered with, by what can honestly be handed over. */
const DOWNLOAD_LINES: Readonly<Record<CompanionResumeDownload, CopyPair>> = {
  ready: V3_DOWNLOAD_READY,
  building: V3_DOWNLOAD_PENDING,
  unavailable: RESUME_RENDER_FAILED,
};

/**
 * How a news request that served a FIXED line is recorded — the free chat's own table
 * (`NEWS_TURN_OUTCOMES`) in the companion's vocabulary: a reviewed line is `served`, a refusal
 * `refused`, an answer the gate threw away `fallback`. An answered request is `answered`.
 */
const NEWS_FIXED_OUTCOMES: Readonly<
  Record<Exclude<FreeChatNewsOutcome, "answered">, CompanionV3Outcome>
> = {
  no_results: "served",
  refused: "refused",
  rejected: "fallback",
  unavailable: "served",
  capped: "served",
};

/** A REAL verdict, as the dispatch reads it. */
type RealVerdict = Extract<FreeChatVerdict, { kind: "verdict" }>;

/**
 * ADR-0055 R2 (owner ruling 2026-10-15) — does a TYPED JOBS-WORD message go back to v1's jobs
 * answer? Yes when the brain has nothing better to say than v1 already would: a `jobs` or
 * `unclear` verdict, or any verdict below the floor — except distress, which bypasses the floor
 * (R10). (An unavailable classifier defers too; the caller checks it first.) Fail safe: every
 * doubt is TODAY's job chips.
 */
function defersToV1Jobs(verdict: RealVerdict): boolean {
  if (verdict.category === "distress") return false;
  return (
    verdict.category === "jobs" ||
    verdict.category === "unclear" ||
    verdict.confidence < FREE_CHAT_MIN_CONFIDENCE
  );
}

/** The classifier's facts for a real verdict — the v4 event's `llm` source, bucket and category. */
function verdictedOf(verdict: RealVerdict, resumeAction: FreeChatResumeAction | null): Verdicted {
  return {
    intentSource: "llm",
    confidenceBucket: confidenceBucketOf(verdict.confidence),
    freeCategory: verdict.category,
    resumeAction,
  };
}

/** The intent a real verdict is routed on — recorded even below the floor, as v2's is. */
function intentOf(
  category: FreeChatCategory,
  action: FreeChatResumeAction | null,
): CompanionV3Intent {
  if (category !== "resume") return CATEGORY_INTENTS[category];
  return action === null ? "resume_menu" : RESUME_ACTION_INTENTS[action];
}

/** One branch's product with the classifier's facts — the brain's answer. */
function brainTurn(verdicted: Verdicted, served: Served): BrainTurn {
  return {
    turn: served.turn,
    intentSource: verdicted.intentSource,
    v2Intent: served.v2Intent,
    confidenceBucket: verdicted.confidenceBucket,
    outcome: served.outcome,
    remember: served.remember ?? verdicted.freeCategory !== "trash",
    facts: {
      freeCategory: verdicted.freeCategory,
      resumeAction: verdicted.resumeAction,
      refusalTopic: served.refusalTopic ?? null,
      replyLanguage: served.replyLanguage ?? null,
      newsOutcome: served.news?.outcome ?? null,
      newsSourceCount: served.news?.sourceCount ?? 0,
    },
  };
}

/**
 * A free-chat model call made for the Bada Bhai chat: no chat session (the companion never reads or
 * writes one), the `companion` surface on every AI input, and the worker's OWN NAME to redact.
 *
 * OWN-NAME REDACTION, EXACTLY AS THE PROFILING CHAT (ADR-0051 privacy invariant; ADR-0054 §4, §8
 * M1). The free-chat model calls replace the worker's name with `[NAME]` in the message, every
 * recent turn and the trade label, whatever `AI_RAW_PII_ENABLED` says — and with that flag on in
 * production the message reaches them raw, so this is the only thing keeping the name out. `name`
 * is the request's `knownName` view for classify and reply (an undecryptable name reads as none, so
 * they still run) and its `ownName` view for news, which then makes no search and serves its
 * unavailable line (fail closed). The plaintext is only ever REMOVED from text: never shown, logged,
 * evented or stored (ADR-0055 narrows ADR-0044 R8 to exactly this read).
 */
function callContextOf(input: NamedInput, name: KnownNameSource): FreeChatCallContext {
  return {
    workerId: input.workerId,
    sessionId: null,
    correlationId: input.ctx.correlationId,
    requestId: input.ctx.requestId,
    knownName: name,
    surface: "companion",
  };
}

/** A turn that served the distress line keeps nothing of the message (F4): `{ remember: false }`. */
function forgetIfDistress(topic: FreeChatRefusalTopic | null): { remember?: false } {
  return topic === "distress" ? { remember: false } : {};
}

/**
 * The language ONE model reply is written in (ADR-0051 §11, reused): an explicit request in this
 * message ("marathi mein jawab do") for THIS reply only — the companion keeps no language, so no
 * ask follows — else the message's own (the classifier's label where code is not certain, R42).
 */
function replyLanguageOf(rawText: string, verdict: FreeChatVerdict): FreeChatReplyLanguage {
  return parseLanguageRequest(rawText)?.language ?? messageLanguage(rawText, verdict);
}

/** The distress line (R10): the Tele-MANAS helpline, alone — no chips, no question. */
export function distressTurn(): CompanionTurn {
  return v2CopyTurn(FREE_CHAT_COPY.DISTRESS);
}

/**
 * THE BADA BHAI CHAT'S FREE-CHAT BRAIN (ADR-0055, #2275) — a v1 MISS, after the gateway and memory,
 * classified ONCE by the profiling free chat's classifier on the `companion` surface and answered per
 * category. Reached only while `companionBrainOn` (the kill switch `CHAT_FREE_CHAT_DISABLED` off);
 * with it on, the orchestrator runs today's v2 classifier instead, byte for byte.
 *
 *   distress (any confidence, R10)  → the DISTRESS line, no chips
 *   unavailable / unclear / < 0.6   → the existing UnclearHandler (clarify + task chips)
 *   trash                           → the existing FaltuHandler (strike / cool-down), never model
 *                                     context (kept only in the worker's 7-day history, ADR-0056)
 *   off_limits                      → the free chat's OFF_LIMITS line
 *   career / casual                 → the free chat's REPLY through its gate (₹ ranges and company
 *                                     names allowed, R11), model-written so never read aloud; a
 *                                     refusal → its reviewed line, `news` → the live-news request
 *   jobs                            → V3_JOBS + "Sabhi jobs dekhein"
 *   resume + edit                   → the résumé's EDIT SECTION MENU (#2295; the registry, never the
 *                                     AI edit card on the brain)
 *   resume + new                    → the existing new-résumé handler (its phase flag)
 *   resume + download               → V3_DOWNLOAD_READY + the download chip, or the honest line
 *   resume + no action              → the résumé root menu (+ the download chip when ready)
 *
 * AI NEVER DECIDES: the model names a category (and an action); every rule above is code. Every
 * model failure is a fixed line, never a partial turn. No employer-name backstop runs on the reply
 * (the owner allows company names here — the career handler's index check is not this path's).
 *
 * THE WORKER'S OWN NAME is read once per turn (`WorkerNameReader`) and used for ONE thing: to be
 * removed from every classify, reply and news input (see {@link callContextOf}).
 *
 * TWO ENTRIES, ONE CLASSIFY (owner rulings 2026-10-15). `route` answers a v1 miss and every weak
 * alias (R1, R3). `routeJobsWord` answers a TYPED message v1 would give its jobs list (R2): the same
 * table, except that `jobs`, `unclear`, a verdict below the floor and an unavailable classifier
 * hand the message back to v1's jobs answer instead of the lines above.
 */
@Injectable()
export class CompanionBrain {
  private readonly logger = new Logger(CompanionBrain.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly calls: FreeChatModelCalls,
    private readonly registry: CompanionHandlerRegistry,
    private readonly resumes: CompanionResumeStatus,
    // ADR-0055 — the worker's own name, read ONLY to redact it from the model calls below.
    private readonly names: WorkerNameReader,
    // #2297 — the rolling summary the reply alone reads: this chat's own while its conversation is
    // alive, else the profiling chat's (ADR-0055 R4).
    private readonly summaries: CompanionSummaryService,
  ) {}

  /** A v1 miss (or a weak alias, R1): classified once and answered per category. */
  async route(brainInput: BrainInput): Promise<BrainTurn> {
    const { input, verdict, resumeAction } = await this.classify(brainInput);
    if (verdict.kind === "unavailable")
      return brainTurn(UNAVAILABLE, await this.unclear(input, null));
    return brainTurn(
      verdictedOf(verdict, resumeAction),
      await this.dispatch(input, verdict, resumeAction),
    );
  }

  /**
   * ADR-0055 R2 (owner ruling 2026-10-15) — a TYPED message v1 would answer with its jobs list,
   * classified FIRST: the same ONE classify call, and the same dispatch for every verdict the brain
   * can answer better (distress, trash, off_limits, career/casual, a résumé ask). Null when it
   * cannot ({@link defersToV1Jobs}): the caller serves TODAY's v1 jobs answer and its event, and
   * this classify call is already on the ledger (`FreeChatModelCalls` records it).
   */
  async routeJobsWord(brainInput: BrainInput): Promise<BrainTurn | null> {
    const { input, verdict, resumeAction } = await this.classify(brainInput);
    if (verdict.kind === "unavailable" || defersToV1Jobs(verdict)) return null;
    return brainTurn(
      verdictedOf(verdict, resumeAction),
      await this.dispatch(input, verdict, resumeAction),
    );
  }

  /** The turn's ONE classifier call, with the worker's own name to redact (read lazily, once). */
  private async classify(brainInput: BrainInput): Promise<{
    readonly input: NamedInput;
    readonly verdict: FreeChatVerdict;
    readonly resumeAction: FreeChatResumeAction | null;
  }> {
    const input: NamedInput = { ...brainInput, names: this.names.sourcesFor(brainInput.workerId) };
    const { verdict, resumeAction } = await this.calls.classifyWithAction(
      {
        text: input.promptText,
        mode: "free",
        pendingQuestion: null,
        messages: contextLinesOf(input.recentTurns),
      },
      callContextOf(input, input.names.knownName),
    );
    return { input, verdict, resumeAction };
  }

  /** A REAL verdict to its answer — the table in the class header. */
  private async dispatch(
    input: NamedInput,
    verdict: RealVerdict,
    resumeAction: FreeChatResumeAction | null,
  ): Promise<Served> {
    // DISTRESS BYPASSES THE FLOOR (ADR-0051 R10): a helpline offered to a worker who did not need
    // it costs one line; a clarify served to one who did is the failure R10 exists to prevent.
    // A distress message is never model context either: it is not replayed to a later model call.
    // It is stored only for the worker's own 7-day history (ADR-0056).
    if (verdict.category === "distress") {
      return { turn: distressTurn(), v2Intent: "distress", outcome: "served", remember: false };
    }
    const intent = intentOf(verdict.category, resumeAction);
    if (verdict.confidence < FREE_CHAT_MIN_CONFIDENCE) return this.unclear(input, intent);
    switch (verdict.category) {
      case "career":
      case "casual":
        return this.reply(input, verdict.category, verdict);
      case "jobs":
        return { turn: v2CopyTurn(V3_JOBS, [jobsTabChip()]), v2Intent: intent, outcome: "served" };
      case "off_limits":
        return {
          turn: this.fixedLine(FREE_CHAT_COPY.OFF_LIMITS),
          v2Intent: intent,
          outcome: "served",
        };
      case "trash":
        // The existing strike path; a message the classifier called trash is never model context
        // (stored only for the worker's own 7-day history, ADR-0056).
        return { ...(await this.handle("faltu", input)), v2Intent: intent, remember: false };
      case "resume":
        return this.resume(input, resumeAction, intent);
      case "unclear":
        return this.unclear(input, intent);
    }
  }

  /** The existing clarify handler; `v2Intent` is what the classifier said, null when it said nothing. */
  private async unclear(input: NamedInput, v2Intent: CompanionV3Intent | null): Promise<Served> {
    return { ...(await this.handle("unclear", input)), v2Intent };
  }

  /**
   * A `resume` message, by what it wants. Edit and new go through the handler registry: new to the
   * existing handler, flags and all; edit to the résumé's edit section menu (#2295,
   * `editAsksGetSectionMenu`), so a classified edit ask makes no edit-parse call.
   */
  private async resume(
    input: NamedInput,
    action: FreeChatResumeAction | null,
    intent: CompanionV3Intent,
  ): Promise<Served> {
    switch (action) {
      case "edit":
        return { ...(await this.handle("edit_resume", input)), v2Intent: intent };
      case "new":
        return { ...(await this.handle("new_resume", input)), v2Intent: intent };
      case "download": {
        const download = await this.resumes.downloadOf(input.workerId, input.profile, input.now);
        const chips: V2Option[] = download === "ready" ? [downloadOption()] : [];
        return {
          turn: v2CopyTurn(DOWNLOAD_LINES[download], chips),
          v2Intent: intent,
          outcome: "served",
        };
      }
      case null: {
        // The classifier could not tell what the résumé message wants: the résumé menu asks, and
        // the download chip rides it when there is a rendered résumé to hand over.
        const download = await this.resumes.downloadOf(input.workerId, input.profile, input.now);
        const root = resolveResumeMenu("");
        const menu = download === "ready" ? withDownloadOption(root) : root;
        return { turn: v2MenuTurn(menu), v2Intent: intent, outcome: "served" };
      }
    }
  }

  /**
   * A CASUAL OR CAREER REPLY — the free chat's reply call and gate, on the companion surface.
   *
   * ADR-0055 R4, #2297 — the context is the companion's recent turns (the last six stored lines a
   * model may read, Redis as the fallback) AND a rolling summary: the Bada Bhai chat's own while its
   * notes are live (their newest line still in the window), else the profiling chat's, read-only
   * (`CompanionSummaryService`). Both
   * fail soft. The reply alone reads it: the classifier never does (ADR-0051 R24), nor does news.
   * The model calls redact the worker's own name out of it again (`summaryForModel`). The
   * profiling chat's summary is never written or folded here.
   */
  private async reply(
    input: NamedInput,
    category: FreeChatReplyCategory,
    verdict: FreeChatVerdict,
  ): Promise<Served> {
    const asked = {
      v2Intent: CATEGORY_INTENTS[category],
      replyLanguage: replyLanguageOf(input.rawText, verdict),
    };
    const out = await this.calls.reply(
      {
        category,
        text: input.promptText,
        messages: contextLinesOf(input.recentTurns),
        workerContext: workerContextOf(input.profile),
        summary: await this.summaries.latestText(input.workerId),
        replyLanguage: asked.replyLanguage,
      },
      callContextOf(input, input.names.knownName),
    );
    if (out === null) {
      return { ...asked, turn: this.fixedLine(FREE_CHAT_COPY.REPLY_FALLBACK), outcome: "fallback" };
    }
    if (out.status === "refuse") {
      // ADR-0054 — the reply's `news` refusal hands the question to the live-news request.
      if (out.topic === "news") return this.news(input, asked);
      return {
        ...asked,
        turn: v2CopyTurn(FREE_CHAT_REFUSAL_LINES[out.topic], this.chipsAfter(out.topic)),
        outcome: "refused",
        refusalTopic: out.topic,
        ...forgetIfDistress(out.topic),
      };
    }
    const screened = screenFreeChatAnswer(out);
    if (screened.kind === "reject") {
      // The CLOSED reason only — never a line of the answer, which is model text.
      this.logger.warn(
        `companion brain reply rejected for worker ${input.workerId} category=${category} ` +
          `(${screened.failure}); the fallback line is served`,
      );
      return { ...asked, turn: this.fixedLine(FREE_CHAT_COPY.REPLY_FALLBACK), outcome: "fallback" };
    }
    if (screened.droppedChips > 0) {
      // The COUNT only — never the chip, which is model text.
      this.logger.log(
        `companion brain reply served for worker ${input.workerId} with ` +
          `${screened.droppedChips} follow-up chip(s) dropped`,
      );
    }
    // #2287 (owner ruling 2026-10-15) — the worker already HAS a résumé here, so a model chip that
    // offers to make one is dropped; the lines and every other chip are served. The profiling chat's
    // own "Resume banayein" chip is untouched: this runs on the companion surface only.
    const { lines, followup_chips } = screened.answer;
    const chips = followup_chips.filter((chip) => !isResumeOfferChip(chip));
    if (chips.length < followup_chips.length) {
      // The COUNT only — never the chip, which is model text.
      this.logger.log(
        `companion brain reply served for worker ${input.workerId} with ` +
          `${followup_chips.length - chips.length} résumé-offer chip(s) dropped`,
      );
    }
    return { ...asked, turn: v2CareerAnswerTurn(lines, chips), outcome: "answered" };
  }

  /**
   * A LIVE-NEWS TURN (ADR-0054) on the companion: the free chat's request (own-name, identifier,
   * daily cap shared with the profiling chat, the call, `judgeNews`, the slot), deduped on the
   * worker and the submission. Answered → the gate's lines with their tiles; every other ending →
   * its reviewed line, the cap being the companion's own V3_NEWS_CAP (the profiling one offers a
   * résumé). `chat.free_chat_news_served` needs a session and is NOT emitted here: the news facts
   * ride the companion's own turn event.
   */
  private async news(
    input: NamedInput,
    asked: { readonly v2Intent: CompanionV3Intent; readonly replyLanguage: FreeChatReplyLanguage },
  ): Promise<Served> {
    const resolution: FreeChatNewsResolution = await this.calls.requestNews(
      {
        text: input.promptText,
        messages: contextLinesOf(input.recentTurns),
        workerContext: workerContextOf(input.profile),
        replyLanguage: asked.replyLanguage,
      },
      // The OWN-NAME view (ADR-0054 §8 M1): a name that cannot be decrypted rejects, and the news
      // request then makes no search and serves its unavailable line.
      callContextOf(input, input.names.ownName),
      input.now,
      input.submissionId,
    );
    if (resolution.outcome === "answered") {
      return {
        ...asked,
        turn: v3NewsAnswerTurn(resolution.lines, toWireNewsLinks(resolution.links)),
        outcome: "answered",
        news: { outcome: "answered", sourceCount: resolution.links.length },
      };
    }
    const line = resolution.outcome === "capped" ? V3_NEWS_CAP : resolution.line;
    return {
      ...asked,
      turn: v2CopyTurn(line, this.chipsAfter(resolution.refusalTopic)),
      outcome: NEWS_FIXED_OUTCOMES[resolution.outcome],
      refusalTopic: resolution.refusalTopic,
      news: { outcome: resolution.outcome, sourceCount: 0 },
      ...forgetIfDistress(resolution.refusalTopic),
    };
  }

  /** One registered handler, by intent — the registry reads the phase flags, as on the v2 path. */
  private handle(intent: CompanionV2Intent, input: NamedInput): Promise<HandlerResult> {
    return this.registry.resolve(intent).handle({
      workerId: input.workerId,
      profile: input.profile,
      text: input.promptText,
      recentTurns: input.recentTurns,
      ctx: input.ctx,
      now: input.now,
      submissionId: input.submissionId,
    });
  }

  /** A fixed line with the open task chips — a worker is never left without a next step. */
  private fixedLine(pair: CopyPair): CompanionTurn {
    return v2CopyTurn(pair, taskChips(this.config));
  }

  /** The chips after a refusal: none after the helpline (R10), the open task chips otherwise. */
  private chipsAfter(topic: FreeChatRefusalTopic | null): V2Option[] {
    return topic === "distress" ? [] : taskChips(this.config);
  }
}
