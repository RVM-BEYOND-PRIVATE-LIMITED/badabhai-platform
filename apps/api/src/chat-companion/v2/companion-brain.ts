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
  /** False for a message the classifier called trash: never stored (the v2 rule — abuse is not context). */
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
    remember: served.remember ?? true,
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

/** The worker's own name is not known on this surface — see {@link callContextOf}. */
const NO_KNOWN_NAME = async (): Promise<string | null> => null;

/**
 * A free-chat model call made for the Bada Bhai chat: no chat session (the companion never reads or
 * writes one), and the `companion` surface on every AI input.
 *
 * NO OWN-NAME REDACTION HERE, DELIBERATELY. The companion module never reads the workers row
 * (ADR-0044), so it does not know the worker's name; ADR-0047 lifts the ban on raw PII in a prompt,
 * the orchestrator's gateway hop still masks the message while `AI_RAW_PII_ENABLED` is off, and the
 * G1 output floor (`screenFreeChatAnswer`'s hard-identifier wall) runs on every model line before a
 * worker reads it.
 */
function callContextOf(input: BrainInput): FreeChatCallContext {
  return {
    workerId: input.workerId,
    sessionId: null,
    correlationId: input.ctx.correlationId,
    requestId: input.ctx.requestId,
    knownName: NO_KNOWN_NAME,
    surface: "companion",
  };
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
 *   trash                           → the existing FaltuHandler (strike / cool-down), never stored
 *   off_limits                      → the free chat's OFF_LIMITS line
 *   career / casual                 → the free chat's REPLY through its gate (₹ ranges and company
 *                                     names allowed, R11), model-written so never read aloud; a
 *                                     refusal → its reviewed line, `news` → the live-news request
 *   jobs                            → V3_JOBS + "Sabhi jobs dekhein"
 *   resume + edit / new             → the existing edit / new-résumé handlers (their phase flags)
 *   resume + download               → V3_DOWNLOAD_READY + the download chip, or the honest line
 *   resume + no action              → the résumé root menu (+ the download chip when ready)
 *
 * AI NEVER DECIDES: the model names a category (and an action); every rule above is code. Every
 * model failure is a fixed line, never a partial turn. No employer-name backstop runs on the reply
 * (the owner allows company names here — the career handler's index check is not this path's).
 */
@Injectable()
export class CompanionBrain {
  private readonly logger = new Logger(CompanionBrain.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly calls: FreeChatModelCalls,
    private readonly registry: CompanionHandlerRegistry,
    private readonly resumes: CompanionResumeStatus,
  ) {}

  async route(input: BrainInput): Promise<BrainTurn> {
    const { verdict, resumeAction } = await this.calls.classifyWithAction(
      {
        text: input.promptText,
        mode: "free",
        pendingQuestion: null,
        messages: contextLinesOf(input.recentTurns),
      },
      callContextOf(input),
    );
    if (verdict.kind === "unavailable")
      return brainTurn(UNAVAILABLE, await this.unclear(input, null));
    const verdicted: Verdicted = {
      intentSource: "llm",
      confidenceBucket: confidenceBucketOf(verdict.confidence),
      freeCategory: verdict.category,
      resumeAction,
    };
    return brainTurn(verdicted, await this.dispatch(input, verdict, resumeAction));
  }

  /** A REAL verdict to its answer — the table in the class header. */
  private async dispatch(
    input: BrainInput,
    verdict: Extract<FreeChatVerdict, { kind: "verdict" }>,
    resumeAction: FreeChatResumeAction | null,
  ): Promise<Served> {
    // DISTRESS BYPASSES THE FLOOR (ADR-0051 R10): a helpline offered to a worker who did not need
    // it costs one line; a clarify served to one who did is the failure R10 exists to prevent.
    if (verdict.category === "distress") {
      return { turn: distressTurn(), v2Intent: "distress", outcome: "served" };
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
        // The existing strike path; a message the classifier called trash is never stored.
        return { ...(await this.handle("faltu", input)), v2Intent: intent, remember: false };
      case "resume":
        return this.resume(input, resumeAction, intent);
      case "unclear":
        return this.unclear(input, intent);
    }
  }

  /** The existing clarify handler; `v2Intent` is what the classifier said, null when it said nothing. */
  private async unclear(input: BrainInput, v2Intent: CompanionV3Intent | null): Promise<Served> {
    return { ...(await this.handle("unclear", input)), v2Intent };
  }

  /** A `resume` message, by what it wants. Edit and new go to the existing handlers, flags and all. */
  private async resume(
    input: BrainInput,
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
   * The profiling chat's rolling summary is NOT read: it lives on a chat session row, which this
   * module never reads (ADR-0044). The companion's own memory (the last six turns) is the context.
   */
  private async reply(
    input: BrainInput,
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
        summary: null,
        replyLanguage: asked.replyLanguage,
      },
      callContextOf(input),
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
    const { lines, followup_chips } = screened.answer;
    return { ...asked, turn: v2CareerAnswerTurn(lines, followup_chips), outcome: "answered" };
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
    input: BrainInput,
    asked: { readonly v2Intent: CompanionV3Intent; readonly replyLanguage: FreeChatReplyLanguage },
  ): Promise<Served> {
    const resolution: FreeChatNewsResolution = await this.calls.requestNews(
      {
        text: input.promptText,
        messages: contextLinesOf(input.recentTurns),
        workerContext: workerContextOf(input.profile),
        replyLanguage: asked.replyLanguage,
      },
      callContextOf(input),
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
    };
  }

  /** One registered handler, by intent — the registry reads the phase flags, as on the v2 path. */
  private handle(intent: CompanionV2Intent, input: BrainInput): Promise<HandlerResult> {
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
