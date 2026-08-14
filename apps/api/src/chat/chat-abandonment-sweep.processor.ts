import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  Inject,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { randomUUID } from "node:crypto";
import { SERVER_CONFIG } from "../config/config.module";
import {
  CHAT_ABANDONMENT_QUEUE,
  CHAT_ABANDONMENT_SWEEP_SCHEDULER_ID,
} from "../queue/queue.constants";
import { ChatRepository } from "./chat.repository";
import { ChatService } from "./chat.service";

/**
 * Per-run cap on idle rows — a pathological backlog drains across ticks, never one unbounded
 * run (the next tick picks up where this one stopped, oldest-first).
 *
 * A REAL BACKLOG IS EXPECTED ON FIRST DEPLOY, not hypothetical: every pre-fix app open called
 * `startSession`, which always inserts, so there is a long tail of empty `active` sessions
 * that have never been closed by anything. They carry no buffer and no messages, so each is a
 * single cheap UPDATE — but there may be many, and they drain at this rate.
 */
export const SWEEP_BATCH_LIMIT = 100;

/**
 * Bounded backoff between registration attempts (ms) — 1 immediate attempt at boot + these 4
 * retries ≈ 80s of cover. Sized for the realistic TRANSIENT cause (Redis not up yet / failing
 * over / a blip during a rolling deploy), NOT for an outage. Mirrors
 * `AccountDeletionSweepProcessor`'s ladder deliberately: two sweeps with different retry
 * behaviour is two things to reason about at 3am.
 */
const REGISTRATION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;

/**
 * Hourly sweep that closes chat sessions the worker stopped answering, PRESERVING whatever is
 * still recoverable.
 *
 * ── THE GAP THIS FILLS ─────────────────────────────────────────────────────────────────────
 *
 * An in-flight interview lives in Redis (`chat:transcript:<sessionId>`) and reaches Postgres
 * only when it COMPLETES — one transactional flush, by design, instead of ~150 per-turn rows.
 * A worker who walks away never triggers that flush, so:
 *
 *   - the transcript sits in Redis until the idle TTL reaps it, then is gone for good;
 *   - `chat_sessions` stays `active` forever, so nothing downstream ever looks at the row;
 *   - the periodic `conversation_state` checkpoint survives but nothing ever acts on it.
 *
 * The state was already being checkpointed. What was missing was anything that NOTICED. This
 * is that trigger, and the reason it is a sweep rather than request-path work: the defining
 * property of an abandoned interview is that no further request is coming.
 *
 * ── IT PRESERVES; IT DOES NOT MINT PROFILES ────────────────────────────────────────────────
 *
 * `ChatService.abandonInterview` emits no `profile.extraction_ready` and triggers no
 * extraction. A partial interview is banked so the worker can resume onto it and so their
 * words are not destroyed — it never reaches the ranking surface. See that method's header for
 * the CLAUDE.md §2 argument.
 *
 * ── WHY THE TIMING IS THE WHOLE DESIGN ─────────────────────────────────────────────────────
 *
 * CHAT_ABANDON_AFTER_SECONDS (6h) sits far below CHAT_TRANSCRIPT_TTL_SECONDS (24h) so this
 * sweep reaches a dead session while its buffer is STILL ALIVE — the difference between saving
 * the verbatim transcript and saving only the checkpoint. ~18h of cover means the sweep has to
 * be broken for the better part of a day before anything is actually lost, and when it is lost
 * the event says so (`transcript_recovered: false`) rather than reporting a clean success.
 *
 * ── FAILURE POSTURE ────────────────────────────────────────────────────────────────────────
 *
 * The DB predicate is AUTHORITATIVE and the repeatable job is only a clock tick, so a lost or
 * duplicated Redis job is harmless: the next tick re-evaluates the same predicate. Per session
 * the close is a CONDITIONAL update (`... AND status = 'active'`), which is what makes a
 * worker who returns mid-sweep and finishes their interview win the race — the sweep then
 * writes nothing at all. A per-session failure logs the opaque id and CONTINUES; one bad row
 * never blocks the backlog. NEVER logs message text or a phone/name — opaque ids only.
 *
 * REGISTRATION is the one part not self-healed by the predicate: a lost *job* is caught by the
 * next tick, but a failed *scheduler registration* means there is no next tick, and sessions
 * would silently stop being swept while their buffers expired. It is therefore retried with a
 * bounded backoff and goes LOUD on exhaustion.
 */
@Processor(CHAT_ABANDONMENT_QUEUE)
export class ChatAbandonmentSweepProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ChatAbandonmentSweepProcessor.name);

  /** Resolves once registration has SUCCEEDED or exhausted its bounded retries. Never
   * rejects (a dead sweep is reported, not thrown). Awaited by tests; also the seam that
   * keeps the background retry chain referenced. */
  private registration: Promise<void> = Promise.resolve();

  /** Set by onModuleDestroy so an in-flight backoff aborts instead of firing against a
   * closing queue during shutdown. */
  private stopped = false;
  private cancelDelay?: () => void;

  constructor(
    private readonly chat: ChatRepository,
    private readonly chatService: ChatService,
    @InjectQueue(CHAT_ABANDONMENT_QUEUE) private readonly queue: Queue,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  /**
   * Register the repeatable sweep at boot. `upsertJobScheduler` is idempotent by scheduler
   * id: every boot re-asserts the SAME scheduler (updating the cadence if config changed)
   * instead of stacking duplicates.
   *
   * The FIRST attempt is awaited (one round trip); retries run in the BACKGROUND and are
   * deliberately NOT awaited, because `onApplicationBootstrap` gates `app.listen()` —
   * blocking here through a Redis outage would keep the whole API from serving. A
   * registration failure NEVER throws out of boot.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (await this.tryRegister(1)) return;
    this.registration = this.retryRegistration();
  }

  /** Abort a pending backoff at shutdown (no retries against a closing queue). */
  onModuleDestroy(): void {
    this.stopped = true;
    this.cancelDelay?.();
  }

  /**
   * Test/ops seam: resolves once registration has settled (succeeded or exhausted its
   * retries). Never rejects — see `registration`.
   */
  async whenRegistrationSettled(): Promise<void> {
    await this.registration;
  }

  /** One registration attempt. Returns true on success; logs + returns false on failure. */
  private async tryRegister(attempt: number): Promise<boolean> {
    const every = this.config.CHAT_ABANDON_SWEEP_INTERVAL_HOURS * 3_600_000;
    try {
      await this.queue.upsertJobScheduler(CHAT_ABANDONMENT_SWEEP_SCHEDULER_ID, { every });
      if (attempt > 1) this.logger.log(`sweep scheduler registered on attempt ${attempt}`);
      return true;
    } catch (err) {
      this.logger.warn(
        `sweep scheduler registration attempt ${attempt}/${
          REGISTRATION_RETRY_DELAYS_MS.length + 1
        } failed (reason: ${err instanceof Error ? err.message : String(err)})`,
      );
      return false;
    }
  }

  /**
   * Bounded-backoff retry of the boot registration. On exhaustion it goes LOUD and stops:
   * from then on the sweep is dead in this process, and idle sessions accumulate while their
   * Redis buffers expire — which is silent, permanent data loss, hence the error log.
   */
  private async retryRegistration(): Promise<void> {
    for (const [i, delayMs] of REGISTRATION_RETRY_DELAYS_MS.entries()) {
      // Checked before AND after the sleep: before, so a destroy during the previous attempt
      // never arms another timer; after, so a destroy during the sleep stops here.
      if (this.stopped) return;
      await this.delay(delayMs);
      if (this.stopped) return;
      if (await this.tryRegister(i + 2)) return;
    }
    this.logger.error(
      `sweep scheduler registration FAILED after ${
        REGISTRATION_RETRY_DELAYS_MS.length + 1
      } attempts — the chat abandonment sweep is NOT running in this process. Idle interviews ` +
        `will stay 'active' and their transcripts will expire from Redis unrecovered.`,
    );
  }

  /** Backoff sleep that aborts cleanly on shutdown. */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.cancelDelay = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** One sweep tick: close every session idle past the threshold (bounded batch). */
  async process(): Promise<{
    idle: number;
    closed: number;
    transcriptsRecovered: number;
    transcriptsLost: number;
  }> {
    const now = new Date();
    const idleSince = new Date(now.getTime() - this.config.CHAT_ABANDON_AFTER_SECONDS * 1_000);
    const idle = await this.chat.findIdleActiveSessions(idleSince, SWEEP_BATCH_LIMIT);

    let closed = 0;
    let transcriptsRecovered = 0;
    let transcriptsLost = 0;

    // SEQUENTIAL on purpose: each close is a transaction plus a Redis read, and one at a time
    // keeps the sweep gentle on shared infra and the logs attributable.
    for (const session of idle) {
      const idPrefix = session.id.slice(0, 8);
      try {
        // A fresh correlation id per session, so one worker's abandonment is traceable through
        // events without tying together every session this tick happened to touch.
        const correlationId = randomUUID();
        const lastActivity = session.lastMessageAt ?? session.startedAt;
        const idleMinutes = Math.max(
          0,
          Math.floor((now.getTime() - lastActivity.getTime()) / 60_000),
        );

        const outcome = await this.chatService.abandonInterview(
          {
            id: session.id,
            workerId: session.workerId,
            conversationState: session.conversationState,
          },
          idleMinutes,
          { requestId: correlationId, correlationId },
        );

        if (!outcome.closed) continue;
        closed += 1;
        if (outcome.transcriptRecovered) transcriptsRecovered += 1;
        else transcriptsLost += 1;
      } catch (err) {
        // Opaque session id prefix and the reason class only — a chat transcript is raw PII
        // and none of it may reach a log line (§2).
        this.logger.warn(
          `abandonment sweep failed for session=${idPrefix}; continuing with the rest of the ` +
            `batch (reason: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    if (idle.length > 0) {
      this.logger.log(
        `abandonment sweep tick: idle=${idle.length} closed=${closed} ` +
          `transcripts_recovered=${transcriptsRecovered} transcripts_lost=${transcriptsLost}`,
      );
    }
    // A FULL BATCH MEANS THERE IS MORE. Said out loud rather than left to inference, because a
    // silently truncated sweep reads as "everything is swept" while a backlog grows behind it.
    if (idle.length === SWEEP_BATCH_LIMIT) {
      this.logger.log(
        `abandonment sweep hit the ${SWEEP_BATCH_LIMIT}-row batch limit; a backlog remains and ` +
          `drains oldest-first on subsequent ticks`,
      );
    }

    return { idle: idle.length, closed, transcriptsRecovered, transcriptsLost };
  }
}
