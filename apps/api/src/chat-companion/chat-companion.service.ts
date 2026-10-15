import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import type { CompanionIntent, CompanionJobsScope, CompanionNudge } from "@badabhai/types";
import { looksLikePii } from "@badabhai/validators";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { JobsRepository } from "../jobs/jobs.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { ResumeService } from "../resume/resume.service";
import { ttsField } from "../profiling/question-tts-text";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { matchesDistress } from "../profiling/free-chat/free-chat.router";
import { toProfileSummary } from "../workers/profile-summary.mapper";
import { readProfileFormFacts, type ProfileFormFacts } from "../workers/profile-form-facts";
import type { ResumeMenuChoice } from "../chat/resume-menu";
import {
  companionBrainOn,
  companionRoutePrecedenceOn,
  editAsksGetSectionMenu,
} from "./companion-brain-switch";
import { isBareGreeting } from "./companion-greeting";
import {
  formCreateAck,
  isFormCreateChoice,
  withFormCreateOption,
} from "./companion-resume-menu";
import { ChatCompanionPolicy } from "./chat-companion.policy";
import { ChatCompanionRepository } from "./chat-companion.repository";
import {
  CompanionOpenResponseSchema,
  CompanionTurnSchema,
  type CompanionMessageDto,
  type CompanionOpenResponse,
  type CompanionTurn,
  type ConfirmEditDto,
} from "./chat-companion.dto";
import { CompanionEditService } from "./v2/companion-edit.service";
import { CompanionV2Orchestrator } from "./v2/companion-v2.orchestrator";
import {
  isCompanionChipTap,
  isWeakCompanionAlias,
  mentionsStatusWord,
  resolveCompanionText,
} from "./companion-intents";
import { isGenericEditRequest, looksLikeEditRequest } from "./v2/edit-precheck";
import { resolveCompanionTaskChip } from "./v2/companion-task-chips";
import { editSectionMenu } from "./v2/companion-v2-compose";
import {
  composeFor,
  replyText,
  replyTts,
  type ComposedTurn,
  JOBS_REPLY_CHIPS_MAX,
} from "./companion-compose";
import {
  currentResumeFacts,
  resumeStateOf,
  type CompanionFacts,
  type CompanionJob,
  type CompanionJobsFacts,
} from "./companion-facts";
import { FALLBACK, MISSING_FIELD_LABELS } from "./companion-replies";
import { COMPANION_RESUME_KEY, COMPANION_RESUME_LABEL } from "./companion-keys";

/** The result of a message: a turn, or "this worker is not in companion mode" (the route's 409). */
export type CompanionMessageResult =
  | { readonly mode: "interview" }
  | { readonly mode: "companion"; readonly turn: CompanionTurn };

/** `POST /chat/companion/edits/:id/confirm` — mapped to HTTP by the controller. */
export type CompanionEditConfirmResult =
  | { readonly mode: "interview" }
  | { readonly mode: "not_found" }
  /** The 409 carries the reviewed V2_EDIT_STALE turn, so the app can show (and say) that line. */
  | { readonly mode: "stale"; readonly turn: CompanionTurn }
  | { readonly mode: "companion"; readonly turn: CompanionTurn };

/** `POST /chat/companion/edits/:id/cancel` — mapped to HTTP by the controller. */
export type CompanionEditCancelResult =
  | { readonly mode: "interview" }
  | { readonly mode: "not_found" }
  | { readonly mode: "companion"; readonly turn: CompanionTurn };

const DAY_MS = 86_400_000;

/**
 * A short, stable hash of EVERYTHING a turn states — its lines and its chip keys — which the app
 * compares on a tab refocus to decide whether anything worth saying changed. Hashing the composed
 * output rather than a hand-picked list of facts means a new line can never be left out of it.
 * Never displayed.
 */
export function digestKey(composed: ComposedTurn): string {
  const basis = JSON.stringify([replyText(composed), composed.options.map((o) => o.option_key)]);
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/**
 * THE POST-COMPLETION BADA BHAI COMPANION (ADR-0044).
 *
 * Once a worker's profile is confirmed, the chat tab stops being a silent transcript: it opens on
 * "ab tak kya hua" — how the résumé was made and what it says, how many jobs they applied to, the
 * new jobs that match their skills — plus one nudge, and it answers a few plain questions.
 *
 * WHAT IT NEVER DOES, BY CONSTRUCTION:
 *   - write `chat_sessions` or `chat_messages` (it has no access to either writer: those rows are
 *     the extraction transcript and the résumé's quote source);
 *   - call a model (reviewed copy, closed intents, deterministic rules);
 *   - read the `workers` row (no name, no phone, no ciphertext ever enters this class);
 *   - call the services that record impressions or searches (`MatchFeedService.getFeed`,
 *     `ApplicationsService.getFeed`, `JobsService.searchJobs`) — it reads repositories;
 *   - rank anything: jobs come in the search box's own order (`published_at DESC, id`).
 *
 * DEGRADES, NEVER FAILS. Each fact is read on its own and a failed read drops only that section;
 * an outbound shape failure serves the fallback line; a failed event emit is logged and the turn
 * is still served. A companion hiccup must never cost the worker their chat tab.
 */
@Injectable()
export class ChatCompanionService {
  private readonly logger = new Logger(ChatCompanionService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly policy: ChatCompanionPolicy,
    private readonly repo: ChatCompanionRepository,
    private readonly resumes: ResumeService,
    private readonly skills: WorkerSkillsRepository,
    private readonly jobs: JobsRepository,
    private readonly events: EventsService,
    // ADR-0046 T7/T8 — the edit path's propose/confirm/cancel. Inert while the v2 flags are off.
    private readonly edits: CompanionEditService,
    // ADR-0046 T6 — the v2 turn pipeline, touched ONLY while `CHAT_COMPANION_V2_ENABLED` is on:
    // from `message` for an open task-chip tap, a cooled-down free-text message and a v1 miss,
    // and from `open` for the cool-down read. A v1 resolver hit never touches it.
    private readonly v2: CompanionV2Orchestrator,
    // #2201 — the worker's form answers, so the gap nudge never asks for a fact the Profile card
    // already counts. Optional so hand-built constructions keep the row-only gap.
    @Optional() private readonly attributes?: WorkerAttributesRepository,
  ) {}

  /**
   * `GET /chat/companion` — the mode, and in companion mode the recap.
   *
   * A RUNNING FALTU COOL-DOWN RIDES THE RECAP (P2) as `cooldown_until`, so an app that restarted
   * mid-cool-down locks its composer again on open instead of learning it from the next refused
   * message. Read only while v2 and its faltu phase are on — otherwise the open is byte-for-byte
   * what it was — and the read fails open (no field) like every cool-down read, including when
   * Redis never answers: `FaltuStore.cooldownUntil` runs under `withinRedisDeadline`, because a
   * command on the shared connection against a downed Redis never rejects.
   */
  async open(workerId: string, ctx: RequestContext, now: Date = new Date()): Promise<CompanionOpenResponse> {
    const mode = await this.policy.resolve(workerId);
    if (mode.mode === "interview") return { mode: "interview" };

    const [facts, cooling] = await Promise.all([
      this.readFacts(workerId, mode.profile, now),
      this.faltuOn() ? this.v2.cooldownUntil(workerId, now) : Promise.resolve(null),
    ]);
    const composed = composeFor("digest", facts);
    const turn: CompanionTurn = {
      ...this.toTurn(composed),
      ...(cooling === null ? {} : { cooldown_until: cooling }),
    };
    await this.record(workerId, ctx, now, "open", "digest", composed, facts, null);

    const checked = CompanionOpenResponseSchema.safeParse(turn);
    return checked.success ? checked.data : this.fallbackTurn(checked.error.issues, workerId);
  }

  /** The faltu phase is live: v2 AND its own flag (the cool-down exists only then). */
  private faltuOn(): boolean {
    return this.config.CHAT_COMPANION_V2_ENABLED && this.config.CHAT_COMPANION_V2_FALTU_ENABLED;
  }

  /** `POST /chat/companion/message` — one answer, or `interview` when this worker is not a companion worker. */
  async message(
    workerId: string,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionMessageResult> {
    const mode = await this.policy.resolve(workerId);
    if (mode.mode === "interview") return { mode: "interview" };

    const v2On = this.config.CHAT_COMPANION_V2_ENABLED;
    // ADR-0055 — THE FREE-CHAT BRAIN (v2 on, the kill switch `CHAT_FREE_CHAT_DISABLED` off). Every
    // step it adds below is gated on it, so with it off the flow is today's, byte for byte.
    const brainOn = companionBrainOn(this.config);
    // P2 (ADR-0046): the phase-2 order is chip keys → cool-down → v1 text resolver → lexicon →
    // classifier. A task-chip tap is recognised FIRST and routed deterministically — v1 would
    // otherwise answer these labels itself (see `companion-task-chips.ts`). Only while v2 is on
    // AND that chip's own phase flag is on: a chip that cannot be shown is typed text, and
    // typed text goes to v1 first exactly as it did before the chip existed.
    const taskChip = v2On ? resolveCompanionTaskChip(dto.text, this.config) : null;
    // ADR-0055 — the redo submenu's form road ("Form se resume banayein") is an EXACT chip like v1's
    // own: answered by its ack, and never gated by the cool-down. Recognised only while the brain
    // is on, the one time the chip is shown; typed by hand with it off, it is v1's text as before.
    const formChip = brainOn && taskChip === null && isFormCreateChoice(dto.text);
    const chipTap = isCompanionChipTap(dto.text) || formChip;
    // ADR-0055 — THE DISTRESS WORD LIST (the free chat's own, `matchesDistress`), BEFORE the
    // cool-down and the v1 resolver: "job nahi mili, marna chahta hoon" carries a strong jobs word
    // v1 would answer with job chips, and a worker blocked from typing is still given the helpline,
    // never the cool-down line. No chip's label can match a distress phrase, so no tap is lost.
    const distress = brainOn && taskChip === null && !chipTap && matchesDistress(dto.text);
    // #2287 (owner ruling 2026-10-15) — a BARE greeting ("hello", "Namaste ji", "🙏 namaste") gets
    // the fixed V3_GREETING line on the brain, with no model call. After the chips, distress and
    // the cool-down; anything with content beside the greeting still reaches the brain.
    const greeting =
      brainOn && taskChip === null && !chipTap && !distress && isBareGreeting(dto.text);
    // The cool-down gate sits BEFORE the v1 resolver and blocks FREE TEXT only: exact chip taps
    // (v1's own and the open task chips') are never gated, so a cooled-down worker can still
    // reach the résumé and jobs. Read only while the faltu phase is on; a Redis failure reads
    // null and the worker is served normally (the store fails open, by design).
    const cooling =
      this.faltuOn() && taskChip === null && !chipTap && !distress
        ? await this.v2.cooldownUntil(workerId, now)
        : null;
    // #2295 (owner ruling 2026-10-15) — ON THE BRAIN, EVERY RÉSUMÉ-EDIT ASK GETS THE EDIT SECTION
    // MENU, never the AI edit card (`editAsksGetSectionMenu`). The DETERMINISTIC edit routes are
    // recognised here, so they make no model call at all and record v1's `resume_menu` event, as a
    // tap on "Apna resume edit karein" does: the edit task chip, a typed edit ask (the edit pattern,
    // either shape, or a generic ask — after the chips, distress, a greeting and the cool-down) and,
    // below, a pending edit intent. An ask only the classifier recognises reaches the same menu
    // through the handler registry. The kill switch leaves every route as it is.
    const menuForEdits = editAsksGetSectionMenu(this.config);
    const editChipTap = menuForEdits && taskChip === "edit_resume";
    const typedEditAsk =
      menuForEdits &&
      taskChip === null &&
      !chipTap &&
      !distress &&
      !greeting &&
      cooling === null &&
      (isGenericEditRequest(dto.text) || looksLikeEditRequest(dto.text));

    // WP6 (TD146) — ROUTE PRECEDENCE, behind its own default-off flag AND, since ADR-0055 R1 (owner
    // ruling 2026-10-15, "brain first"), whenever the free-chat brain is on. Off — the kill switch
    // on and the flag off — none of the helpers below run and the flow is byte-for-byte today's.
    // On: a pending intent left by a chip tap routes the next free-text message straight to its
    // handler, a narrow reviewed edit pattern routes edit phrasings to the edit handler — both
    // BEFORE v1 and with no classifier call — and a WEAK v1 alias (a résumé word, a menu alias or
    // section word, a greeting, the bare "kaam") goes to the classifier instead of v1's recap or
    // menu. Exact chip taps and every NAMED v1 intent keep their zero-model answers.
    const precedenceOn = companionRoutePrecedenceOn(this.config);
    // Another chip clears a stale pending intent (the edit/career task chips set their own in
    // `handleTaskChip`), and so does an edit ask answered with the menu, as the menu's edit chip is
    // (#2295). Best-effort: the answer is served either way.
    if (precedenceOn && ((chipTap && taskChip === null) || editChipTap || typedEditAsk)) {
      await this.v2.clearPendingIntent(workerId);
    }
    const resolution = resolveCompanionText(dto.text);
    // A distress message never consumes the one-shot pending intent: the helpline answers it. Nor
    // does a bare greeting (#2287): it carries no task, so the intent waits for the next message.
    const pending =
      precedenceOn &&
      taskChip === null &&
      cooling === null &&
      !chipTap &&
      !distress &&
      !greeting &&
      !typedEditAsk
        ? await this.v2.takePendingIntent(workerId)
        : null;
    const editMenu = editChipTap || typedEditAsk || (menuForEdits && pending === "edit_resume");
    // The edit pattern straight to the edit handler — the kill-switch route (on the brain, the menu).
    const editPrecheck =
      !menuForEdits &&
      precedenceOn &&
      pending === null &&
      taskChip === null &&
      cooling === null &&
      !chipTap &&
      this.config.CHAT_COMPANION_V2_EDIT_ENABLED &&
      looksLikeEditRequest(dto.text);
    let turn: CompanionTurn;
    if (editMenu) {
      // #2295 — the edit section menu, served and recorded as v1's menu serves it.
      turn = this.menuTurn(editSectionMenu());
      await this.record(
        workerId,
        ctx,
        now,
        "message",
        "resume_menu",
        null,
        null,
        dto.submission_id ?? null,
      );
    } else if (taskChip !== null) {
      turn = await this.v2.handleTaskChip(workerId, mode.profile, dto, taskChip, ctx, now);
    } else if (distress) {
      // ADR-0055 — the helpline, alone. The orchestrator records the v4 event (`lexicon`).
      turn = await this.v2.handleDistress(workerId, dto, ctx, now);
    } else if (formChip) {
      // ADR-0055 — the form road's ack, served like the menu's own upload and chat acks.
      turn = this.menuTurn(formCreateAck());
      await this.record(workerId, ctx, now, "message", "resume_menu", null, null, dto.submission_id ?? null);
    } else if (cooling !== null) {
      turn = await this.v2.handleCooldown(workerId, dto, ctx, now, cooling);
    } else if (greeting) {
      // #2287 — the fixed greeting line and the task chips; the orchestrator records the v4 event.
      turn = await this.v2.handleGreeting(workerId, dto, ctx, now);
    } else if (pending !== null) {
      // A deterministic v1-bypass route: no v1 resolver, no classifier (WP6).
      turn = await this.v2.handleDirectIntent(workerId, mode.profile, dto, pending, ctx, now);
    } else if (editPrecheck) {
      turn = await this.v2.handleDirectIntent(workerId, mode.profile, dto, "edit_resume", ctx, now);
    } else if (
      precedenceOn &&
      !chipTap &&
      !(brainOn && mentionsStatusWord(dto.text)) &&
      isWeakCompanionAlias(dto.text)
    ) {
      // A v1 WEAK ALIAS is not a named intent: under route precedence it goes to the classifier,
      // which is how a career phrasing v1 would have swallowed ("welding ka kaam seekhna hai…")
      // reaches the career handler. Exact chips, jobs/applications/guarantee/status and the
      // other named answers never arrive here (`isWeakCompanionAlias`). #2287: on the brain, the
      // word "status" is a status question too — v1's recap answers it, not the classifier.
      turn = await this.v2.handleMessage(workerId, mode.profile, dto, ctx, now);
    } else if (
      brainOn &&
      !chipTap &&
      resolution.kind === "intent" &&
      resolution.intent === "jobs"
    ) {
      // ADR-0055 R2 (owner ruling 2026-10-15) — a TYPED message v1 would answer with its jobs list
      // (a strong jobs word; never the job / jobs-tab chips, which are exact taps) is classified
      // FIRST: "job nahi mili, marna hai" is distress, "Tata mein welder ki job milti hai?" is a
      // career question. The brain answers what it is sure of; `null` — jobs, unclear, below the
      // floor, an unavailable classifier — is TODAY's jobs answer and v1's own event, unchanged.
      const brainTurn = await this.v2.handleJobsMessage(workerId, mode.profile, dto, ctx, now);
      turn = brainTurn ?? (await this.v1Turn(workerId, mode.profile, "jobs", dto, ctx, now));
    } else if (resolution.kind === "resume_menu") {
      // ADR-0055 — on the brain, the redo submenu offers the form road too (no other menu changes).
      turn = this.menuTurn(brainOn ? withFormCreateOption(resolution.menu) : resolution.menu);
      await this.record(workerId, ctx, now, "message", "resume_menu", null, null, dto.submission_id ?? null);
    } else if (v2On && resolution.intent === "fallback") {
      // ADR-0046 T6 — THE V1 MISS GOES TO THE ROUTER, and v1's `fallback` intent IS the miss:
      // the resolver understood nothing else about the text. Every NAMED v1 intent (digest,
      // jobs, applied, guarantee) is still served by the branch below, byte-for-byte and with
      // zero model calls. The orchestrator owns the v2 event.
      turn = await this.v2.handleMessage(workerId, mode.profile, dto, ctx, now);
    } else {
      turn = await this.v1Turn(workerId, mode.profile, resolution.intent, dto, ctx, now);
    }

    const checked = CompanionTurnSchema.safeParse(turn);
    return {
      mode: "companion",
      turn: checked.success ? checked.data : this.fallbackTurn(checked.error.issues, workerId),
    };
  }

  /**
   * ONE NAMED v1 ANSWER, composed from the facts and recorded on v1's own event — the deterministic
   * zero-model turn. Also what a jobs-word message the brain hands back is answered with (R2), so
   * the deferred turn is today's turn, byte for byte.
   */
  private async v1Turn(
    workerId: string,
    profile: WorkerProfile,
    intent: Exclude<CompanionIntent, "resume_menu">,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<CompanionTurn> {
    const facts = await this.readFacts(workerId, profile, now);
    const composed = composeFor(intent, facts);
    const turn = this.toTurn(composed);
    await this.record(workerId, ctx, now, "message", intent, composed, facts, dto.submission_id ?? null);
    return turn;
  }

  /**
   * `POST /chat/companion/edits/:proposalId/confirm` (ADR-0046 O4/O6) — Haan.
   *
   * THE FLAGS GATE FIRST, and they answer 404 rather than applying: with v2 (or its edit handler)
   * off, no card can be issued, and a proposal left in Redis from a flag that was since turned
   * off must NOT be applied. The proposal id is looked up under THIS worker's key only, so
   * another worker's id is indistinguishable from an expired one (the controller's 404).
   */
  async confirmEdit(
    workerId: string,
    proposalId: string,
    dto: ConfirmEditDto,
    ctx: RequestContext,
  ): Promise<CompanionEditConfirmResult> {
    if (!this.config.CHAT_COMPANION_V2_ENABLED || !this.config.CHAT_COMPANION_V2_EDIT_ENABLED) {
      return { mode: "not_found" };
    }
    const mode = await this.policy.resolve(workerId);
    if (mode.mode === "interview") return { mode: "interview" };

    const result = await this.edits.confirm(workerId, mode.profile, proposalId, dto.row_ids, ctx);
    if (result.kind === "not_found") return { mode: "not_found" };
    if (result.kind === "stale") return { mode: "stale", turn: this.checkedTurn(result.turn, workerId) };
    return { mode: "companion", turn: this.checkedTurn(result.turn, workerId) };
  }

  /** `POST /chat/companion/edits/:proposalId/cancel` (ADR-0046 O4) — Nahi. Nothing is written. */
  async cancelEdit(
    workerId: string,
    proposalId: string,
    ctx: RequestContext,
  ): Promise<CompanionEditCancelResult> {
    if (!this.config.CHAT_COMPANION_V2_ENABLED || !this.config.CHAT_COMPANION_V2_EDIT_ENABLED) {
      return { mode: "not_found" };
    }
    const mode = await this.policy.resolve(workerId);
    if (mode.mode === "interview") return { mode: "interview" };

    const result = await this.edits.cancel(workerId, proposalId, ctx);
    if (result.kind === "not_found") return { mode: "not_found" };
    return { mode: "companion", turn: this.checkedTurn(result.turn, workerId) };
  }

  /** FAIL CLOSED ON SHAPE for the v2 edit turns, exactly as `message` does for v1's. */
  private checkedTurn(turn: CompanionTurn, workerId: string): CompanionTurn {
    const checked = CompanionTurnSchema.safeParse(turn);
    return checked.success ? checked.data : this.fallbackTurn(checked.error.issues, workerId);
  }

  // ── facts ────────────────────────────────────────────────────────────────────────────────

  private async readFacts(workerId: string, profile: WorkerProfile, now: Date): Promise<CompanionFacts> {
    const attributes = this.attributes;
    const [history, applied, wanted, formFacts] = await Promise.all([
      this.settle("resume history", workerId, () => this.resumes.history(workerId, now)),
      this.settle("applied count", workerId, () => this.repo.countApplied(workerId)),
      this.settle("wanted skills", workerId, () => this.skills.listWantedSkillIds(workerId)),
      attributes === undefined
        ? undefined
        : this.settle("form answers", workerId, async () =>
            readProfileFormFacts(await attributes.loadTradeSheet(workerId)),
          ),
    ]);

    const resume = currentResumeFacts(history?.items[0]);
    return {
      resume,
      resumeState: resumeStateOf({
        resume,
        unavailable: history === undefined,
        confirmedAt: profile.confirmedAt,
        now,
        // The same bound ADR-0043 puts on "your résumé is being updated": past it, a claim that
        // the résumé is on its way is no longer one the platform can stand behind.
        graceMs: this.config.RESUME_UPDATE_PENDING_TIMEOUT_SECONDS * 1_000,
      }),
      pendingUpdate: history?.pending_update?.status ?? null,
      appliedCount: applied ?? null,
      jobs: await this.readJobs(workerId, wanted, now),
      missingField: this.firstFillableGap(profile, formFacts ?? null),
    };
  }

  /**
   * "New jobs for your profile" — the Jobs tab's own membership rule (#1240: `reach_skill_ids`
   * overlap with the worker's wanted skills, applied/skipped excluded, `published_at DESC, id`),
   * narrowed to postings published inside the window. A worker with no wanted skills gets NO
   * claim at all: #1240's "every open posting" fallback is a search-box ruling, and calling those
   * "aapke kaam ke" would be false.
   */
  private async readJobs(
    workerId: string,
    wanted: readonly string[] | undefined,
    now: Date,
  ): Promise<CompanionJobsFacts> {
    const windowDays = this.config.CHAT_COMPANION_NEW_JOBS_WINDOW_DAYS;
    const empty = (scope: CompanionJobsScope): CompanionJobsFacts => ({
      scope,
      count: null,
      capped: false,
      jobs: [],
      windowDays,
    });
    if (wanted === undefined) return empty("unavailable");
    if (wanted.length === 0) return empty("no_skills");

    const found = await this.settle("new jobs", workerId, () =>
      this.jobs.searchOpenPostings({
        workerId,
        q: null,
        profileSkillIds: wanted,
        city: null,
        state: null,
        limit: this.config.CHAT_COMPANION_NEW_JOBS_COUNT_CAP,
        offset: 0,
        publishedAfter: new Date(now.getTime() - windowDays * DAY_MS),
      }),
    );
    if (found === undefined) return empty("unavailable");

    const chipAllowance = Math.min(this.config.CHAT_COMPANION_JOB_CHIPS, JOBS_REPLY_CHIPS_MAX);
    const jobs: CompanionJob[] = [];
    for (const row of found.rows) {
      if (jobs.length >= chipAllowance) break;
      // Payer-typed text: never on a chip if the title is blank once whitespace is collapsed, or
      // if the title or the city looks like a phone number or an email. Screened AS SHOWN (the
      // collapsed title, the trimmed city), not as stored. The posting still counts — it is a
      // real posting — it just is not named here.
      const title = row.title?.replace(/\s+/g, " ").trim() ?? "";
      const city = row.city?.trim() || null;
      if (title.length === 0 || looksLikePii(title) || (city !== null && looksLikePii(city))) continue;
      jobs.push({ jobPostingId: row.id, title, city });
    }
    return { scope: "profile", count: found.rows.length, capped: found.hasMore, jobs, windowDays };
  }

  /**
   * The first profile gap a worker can fill, in the summary's own order. The summary is computed
   * from the profile row plus the worker's form answers (#2201) — the same inputs the Profile card
   * scores, so the nudge never asks for a fact the card already counts. `hasPhoto: true` because
   * the companion never reads the workers row (and never nudges for a photo), `workerCity: null`
   * because no city is shown from here. A failed form read (`null`) falls back to the row alone.
   */
  private firstFillableGap(
    profile: WorkerProfile,
    formFacts: ProfileFormFacts | null,
  ): string | null {
    try {
      const summary = toProfileSummary({
        ...profile,
        hasPhoto: true,
        workerCity: null,
        formFacts,
      });
      return summary.missing_fields.find((f) => MISSING_FIELD_LABELS[f] !== undefined) ?? null;
    } catch {
      return null;
    }
  }

  /** Run one read; a throw becomes `undefined` and a PII-free warn, never an exception. */
  private async settle<T>(what: string, workerId: string, read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (err) {
      this.logger.warn(
        `companion ${what} unreadable for worker ${workerId}; section omitted (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return undefined;
    }
  }

  // ── wire ─────────────────────────────────────────────────────────────────────────────────

  private toTurn(composed: ComposedTurn): CompanionTurn {
    const options = composed.options.map((o) => ({ ...o }));
    const tts = replyTts(composed);
    return {
      mode: "companion",
      digest_key: digestKey(composed),
      ...this.baseTurn(),
      reply: replyText(composed),
      ...(tts === undefined ? {} : { tts_text: tts }),
      suggested_followups: options.map((o) => o.label_text),
      suggested_options: options,
      question_kind: options.length > 0 ? "disambiguate" : "close",
    };
  }

  /** The résumé menu, exactly as the ended-session path serves it (`ChatService.terminalResponse`). */
  private menuTurn(menu: ResumeMenuChoice): CompanionTurn {
    return {
      mode: "companion",
      ...this.baseTurn(),
      reply: menu.reply,
      ...ttsField(menu.reply),
      suggested_followups: [...menu.followups],
      suggested_options: menu.options.map((o) => ({ ...o })),
      question_kind: menu.followups.length > 0 ? "disambiguate" : "close",
    };
  }

  /** Every field a companion turn fixes, so each builder spells out only what differs. */
  private baseTurn(): Omit<CompanionTurn, "mode" | "reply" | "suggested_followups" | "suggested_options" | "question_kind"> {
    return {
      blocked: false,
      is_mock: false,
      asked_question_id: null,
      extraction_ready: false,
      unanswered_essentials: [],
      session_ended: false,
      input_mode: "text",
      answer_type: null,
      progress: null,
      occupation_label: null,
      lookahead: null,
      form_offer: null,
      resume_update: null,
    };
  }

  /**
   * FAIL CLOSED ON SHAPE. The turn did not match the strict outbound schema, so nothing composed
   * from facts is sent: the fallback line and the one chip that reaches the existing résumé menu.
   * Logs the failing PATHS only — never a value.
   */
  private fallbackTurn(issues: readonly { path: readonly PropertyKey[] }[], workerId: string): CompanionTurn {
    this.logger.error(
      `companion turn failed its outbound schema for worker ${workerId}; serving fallback paths=[${issues
        .map((i) => i.path.map(String).join("."))
        .join(",")}]`,
    );
    const option = { option_key: COMPANION_RESUME_KEY, label_text: COMPANION_RESUME_LABEL, is_none_of_above: false };
    return {
      mode: "companion",
      ...this.baseTurn(),
      reply: FALLBACK.latin,
      tts_text: FALLBACK.dev,
      suggested_followups: [option.label_text],
      suggested_options: [option],
      question_kind: "disambiguate",
    };
  }

  // ── event ────────────────────────────────────────────────────────────────────────────────

  /**
   * `chat.companion_turn_served` — counts and closed sets only. The tab-open record is deduped
   * per worker per UTC day (a worker who opens the tab ten times is one daily visit); a message
   * is deduped by its `submission_id` when the app sends one, so a retried send is one row.
   *
   * BEST-EFFORT: the worker still gets their answer if the spine write fails, and the failure is
   * logged at error level with ids only. Nothing here is a state change another component waits on.
   */
  private async record(
    workerId: string,
    ctx: RequestContext,
    now: Date,
    trigger: "open" | "message",
    intent: CompanionIntent,
    composed: ComposedTurn | null,
    facts: CompanionFacts | null,
    submissionId: string | null,
  ): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    const nudge: CompanionNudge | null = composed?.nudge ?? null;
    const idempotencyKey =
      trigger === "open"
        ? `chat.companion_turn_served:open:${workerId}:${day}`
        : submissionId
          ? `chat.companion_turn_served:message:${workerId}:${submissionId}`
          : undefined;
    try {
      await this.events.emit({
        event_name: "chat.companion_turn_served",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          trigger,
          intent,
          applied_count: facts?.appliedCount ?? null,
          new_jobs_count: facts && facts.jobs.scope === "profile" ? facts.jobs.count : null,
          jobs_scope: facts?.jobs.scope ?? null,
          job_chips_count: composed?.jobChipsCount ?? 0,
          resume_source: facts?.resume?.source ?? null,
          nudge,
          day,
        },
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.error(
        `chat.companion_turn_served not recorded for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
