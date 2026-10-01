import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import type { CompanionIntent, CompanionJobsScope, CompanionNudge, ResumeSource } from "@badabhai/types";
import { looksLikePii } from "@badabhai/validators";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { JobsRepository } from "../jobs/jobs.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { ResumeService } from "../resume/resume.service";
import { ttsField } from "../profiling/question-tts-text";
import { toProfileSummary } from "../workers/profile-summary.mapper";
import type { ResumeMenuChoice } from "../chat/resume-menu";
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
import { isCompanionChipTap, resolveCompanionText } from "./companion-intents";
import { resolveCompanionTaskChip } from "./v2/companion-task-chips";
import {
  composeFor,
  replyText,
  replyTts,
  type ComposedTurn,
  JOBS_REPLY_CHIPS_MAX,
} from "./companion-compose";
import { resumeStateOf, type CompanionFacts, type CompanionJob, type CompanionJobsFacts } from "./companion-facts";
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

/** An ISO instant from the wire DTO, or null when it does not parse. */
function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

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
    // P2 (ADR-0046): the phase-2 order is chip keys → cool-down → v1 text resolver → lexicon →
    // classifier. A task-chip tap is recognised FIRST and routed deterministically — v1 would
    // otherwise answer these labels itself (see `companion-task-chips.ts`). Only while v2 is on
    // AND that chip's own phase flag is on: a chip that cannot be shown is typed text, and
    // typed text goes to v1 first exactly as it did before the chip existed.
    const taskChip = v2On ? resolveCompanionTaskChip(dto.text, this.config) : null;
    // The cool-down gate sits BEFORE the v1 resolver and blocks FREE TEXT only: exact chip taps
    // (v1's own and the open task chips') are never gated, so a cooled-down worker can still
    // reach the résumé and jobs. Read only while the faltu phase is on; a Redis failure reads
    // null and the worker is served normally (the store fails open, by design).
    const cooling =
      this.faltuOn() && taskChip === null && !isCompanionChipTap(dto.text)
        ? await this.v2.cooldownUntil(workerId, now)
        : null;

    const resolution = resolveCompanionText(dto.text);
    let turn: CompanionTurn;
    if (taskChip !== null) {
      turn = await this.v2.handleTaskChip(workerId, mode.profile, dto, taskChip, ctx, now);
    } else if (cooling !== null) {
      turn = await this.v2.handleCooldown(workerId, dto, ctx, now, cooling);
    } else if (resolution.kind === "resume_menu") {
      turn = this.menuTurn(resolution.menu);
      await this.record(workerId, ctx, now, "message", "resume_menu", null, null, dto.submission_id ?? null);
    } else if (v2On && resolution.intent === "fallback") {
      // ADR-0046 T6 — THE V1 MISS GOES TO THE ROUTER, and v1's `fallback` intent IS the miss:
      // the resolver understood nothing else about the text. Every NAMED v1 intent (digest,
      // jobs, applied, guarantee) is still served by the branch below, byte-for-byte and with
      // zero model calls. The orchestrator owns the v2 event.
      turn = await this.v2.handleMessage(workerId, mode.profile, dto, ctx, now);
    } else {
      const facts = await this.readFacts(workerId, mode.profile, now);
      const composed = composeFor(resolution.intent, facts);
      turn = this.toTurn(composed);
      await this.record(workerId, ctx, now, "message", resolution.intent, composed, facts, dto.submission_id ?? null);
    }

    const checked = CompanionTurnSchema.safeParse(turn);
    return {
      mode: "companion",
      turn: checked.success ? checked.data : this.fallbackTurn(checked.error.issues, workerId),
    };
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
    const [history, applied, wanted] = await Promise.all([
      this.settle("resume history", workerId, () => this.resumes.history(workerId, now)),
      this.settle("applied count", workerId, () => this.repo.countApplied(workerId)),
      this.settle("wanted skills", workerId, () => this.skills.listWantedSkillIds(workerId)),
    ]);

    const current = history?.items[0];
    const resume = current
      ? {
          resumeId: current.resume_id,
          source: (current.source ?? null) as ResumeSource | null,
          renderStatus: current.render_status,
          generatedAt: parseInstant(current.generated_at),
          tradeLabel: current.trade_label,
          experienceYears: current.experience_years,
          machines: current.machines ?? [],
          city: current.city,
        }
      : null;
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
      missingField: this.firstFillableGap(profile),
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
   * from the profile row alone — `hasPhoto: true` because the companion never reads the workers
   * row (and never nudges for a photo), `workerCity: null` because no city is shown from here.
   */
  private firstFillableGap(profile: WorkerProfile): string | null {
    try {
      const summary = toProfileSummary({ ...profile, hasPhoto: true, workerCity: null });
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
