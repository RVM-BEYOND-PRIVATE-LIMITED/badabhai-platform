import { Inject, Injectable, Logger } from "@nestjs/common";
import { AI_TASK_TYPES, type AiCostTaskType } from "@badabhai/event-schema";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { EmailNotificationService } from "../notifications/email-notification.service";
import { AiAlertsRepository, type AiTaskFallbackRow } from "./ai-alerts.repository";

/** One task's fallback posture inside the stated window. Wire shape (snake_case). */
export interface AiTaskAlertStatus {
  task_type: string;
  window_hours: number;
  total_calls: number;
  real_calls: number;
  fallback_calls: number;
  /** `fallback_calls / total_calls`, 0 when nothing was recorded (never null — see below). */
  fallback_share: number;
  /** Recorded enough calls AND the share reaches the threshold. */
  breaching: boolean;
  /** The latest raised/cleared verdict in the window, if any — the durable alert state. */
  last_alert: "raised" | "cleared" | null;
  /** The alert condition RIGHT NOW. `active` without a raise, or a raise without `active`,
   *  are both meaningful: the first is a verdict not yet recorded, the second a recovery
   *  not yet recorded — evaluation closes whichever gap it finds. */
  active: boolean;
}

/** Spend-cap trips inside the stated window. Wire shape (snake_case). No separate verdict
 *  events: the `ai.spend_cap_exceeded` rows already ARE the raise record, and an empty
 *  window IS the cleared state. */
export interface AiSpendCapStatus {
  window_hours: number;
  breach_count: number;
  active: boolean;
}

/** One row of the recent-alerts feed. Wire shape (snake_case). */
export interface AiRecentAlert {
  id: string;
  event_name: string;
  occurred_at: Date;
  task_type: string | null;
  reason: string | null;
}

/** The admin/health read model: per-task posture + spend caps + thresholds + recent feed.
 *  Wire shape (snake_case) — the admin DTO re-exports these as the endpoint contract. */
export interface AiAlertsStatus {
  generated_at: Date;
  window_hours: number;
  thresholds: {
    min_calls: number;
    fallback_share: number;
  };
  tasks: AiTaskAlertStatus[];
  spend_cap: AiSpendCapStatus;
  recent_alerts: AiRecentAlert[];
}

/** What one `evaluate()` run did — the test seam for the acceptance criteria. */
export interface AiAlertEvaluation {
  evaluated: boolean;
  window_hours: number;
  raised: string[];
  cleared: string[];
  spend_cap_active: boolean;
  emailed: string[];
}

/**
 * B13 (#2567) — the LOUD AI alert: fallback share per task + spend-cap trips, evaluated
 * off the `ai.cost_recorded` / `ai.spend_cap_exceeded` spine and recorded back onto it
 * as `ai.fallback_alert_raised` / `ai.fallback_alert_cleared`.
 *
 * ── WHY THE EVALUATION LIVES HERE (AiModule) AND NOT IN THE ADMIN MODULE ─────────────
 * The trigger is `AiCostRecorder.record()` — every recorded cost re-checks its task's
 * window — and the recorder is `AiModule`'s. The admin endpoint (`GET /admin/ai-alerts`)
 * and `GET /health` only READ through `status()`/`taskPosture()`, so no write path runs
 * on a GET and the "admin write needs a written reason" rule has nothing to apply to:
 * these emits carry the `system` actor, never an admin one.
 *
 * ── NO NEW TABLE, AND THAT IS DELIBERATE ─────────────────────────────────────────────
 * The "alert record" the issue asks for IS the verdict event row. Active/cleared state
 * is DERIVED (latest verdict per task in the window + the current breach computation),
 * so there is no migration, no apply-before-deploy ordering, and no second source of
 * truth to drift from the spine.
 *
 * ── NEVER THROWS ────────────────────────────────────────────────────────────────────
 * Alerting must not be able to fail the work it observes — the same contract
 * `AiCostRecorder.record()` keeps. Every failure path logs a secret-free WARN and the
 * caller proceeds. An alert that takes down extraction is worse than no alert.
 *
 * ── EMAIL IS BEST-EFFORT AND DEDUPED ────────────────────────────────────────────────
 * Behind `AI_ALERT_EMAIL_ENABLED` (default off) to `AI_ALERT_EMAIL_TO`. A fallback raise
 * emails once per (task, UTC day): the emit's day-scoped idempotency key reports
 * `written`, and only a written raise sends. A spend-cap trip emails once per NEW
 * breach id (in-memory watermark, seeded silently on first sight so a deploy during an
 * active cap does not backfill-email the past). Multi-replica double-sends are possible
 * in the race; the spine verdicts stay exactly-once regardless — email is the
 * notification, the event is the record.
 */
@Injectable()
export class AiAlertsService {
  private readonly logger = new Logger(AiAlertsService.name);

  /**
   * Minimum gap between production evaluations (the `AiCostRecorder` path). One trailing
   * window aggregate is ~3 small indexed queries; without the debounce every recorded AI
   * call would pay for one. Tests bypass it with `{ force: true }`.
   */
  private static readonly EVALUATE_DEBOUNCE_MS = 5 * 60 * 1000;

  private lastEvaluatedAt = 0;
  /** Latest spend-cap breach id already emailed about (null until the first sighting). */
  private lastEmailedSpendCapId: string | null | undefined;

  constructor(
    private readonly repo: AiAlertsRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly email: EmailNotificationService,
  ) {}

  /**
   * The health read: per-task posture over the configured window. Read-only, bounded,
   * PII-free (labels + counts + shares). Never throws — on any failure it returns the
   * empty set, and /health reports the gap as "no recorded calls" rather than failing.
   */
  async taskPosture(windowHours?: number): Promise<AiTaskAlertStatus[]> {
    try {
      const hours = windowHours ?? this.config.AI_FALLBACK_ALERT_WINDOW_HOURS;
      const since = new Date(Date.now() - hours * 3_600_000);
      const [split, states] = await Promise.all([
        this.repo.taskFallbackSplit(since),
        this.repo.latestFallbackAlertPerTask(since),
      ]);
      return this.toStatuses(split, states, hours);
    } catch (err) {
      this.logger.warn(
        `ai task posture unreadable (non-fatal): ${AiAlertsService.safeReason(err)}`,
      );
      return [];
    }
  }

  /**
   * The admin read: posture + spend caps + thresholds + the recent-alerts feed.
   * Read-only — evaluation (the write path) never runs here.
   */
  async status(windowHours?: number): Promise<AiAlertsStatus> {
    const hours = windowHours ?? this.config.AI_FALLBACK_ALERT_WINDOW_HOURS;
    const since = new Date(Date.now() - hours * 3_600_000);
    const [split, states, spend, recent] = await Promise.all([
      this.repo.taskFallbackSplit(since),
      this.repo.latestFallbackAlertPerTask(since),
      this.repo.spendCapStats(since),
      this.repo.recentAlerts(since, 100),
    ]);
    return {
      generated_at: new Date(),
      window_hours: hours,
      thresholds: {
        min_calls: this.config.AI_FALLBACK_ALERT_MIN_CALLS,
        fallback_share: this.config.AI_FALLBACK_ALERT_SHARE,
      },
      tasks: this.toStatuses(split, states, hours),
      spend_cap: {
        window_hours: hours,
        breach_count: spend.count,
        active: spend.count > 0,
      },
      recent_alerts: recent.map((r) => ({
        id: r.id,
        event_name: r.eventName,
        occurred_at: r.occurredAt,
        task_type: r.taskType,
        reason: r.reason,
      })),
    };
  }

  /**
   * Evaluate every task's window and close the record gap in both directions:
   * breaching-without-raise → raise; raised-without-breach → clear.
   *
   * Idempotent by spine state (a raise exists → no second raise), with a day-scoped
   * idempotency key as the backstop so two replicas racing the same breach dedupe on the
   * insert instead of doubling the record. An ongoing breach re-raises (and re-emails)
   * once per UTC day — a daily reminder, not a per-call flood. Known edge: a breach that
   * clears AND re-breaches inside one UTC day reuses the day's raise key, so the second
   * raise dedupes until the next day — the endpoint still reports the task as breaching
   * throughout (that computation never reads the verdict keys), only the reminder waits.
   */
  async evaluate(opts?: { force?: boolean }): Promise<AiAlertEvaluation> {
    const empty: AiAlertEvaluation = {
      evaluated: false,
      window_hours: this.config.AI_FALLBACK_ALERT_WINDOW_HOURS,
      raised: [],
      cleared: [],
      spend_cap_active: false,
      emailed: [],
    };
    try {
      const now = Date.now();
      if (!opts?.force && now - this.lastEvaluatedAt < AiAlertsService.EVALUATE_DEBOUNCE_MS) {
        return empty;
      }
      const hours = this.config.AI_FALLBACK_ALERT_WINDOW_HOURS;
      const since = new Date(now - hours * 3_600_000);
      const [split, states, spend] = await Promise.all([
        this.repo.taskFallbackSplit(since),
        this.repo.latestFallbackAlertPerTask(since),
        this.repo.spendCapStats(since),
      ]);
      this.lastEvaluatedAt = now;
      const statuses = this.toStatuses(split, states, hours);
      const raised: string[] = [];
      const cleared: string[] = [];
      const emailed: string[] = [];
      for (const s of statuses) {
        // A stored task label outside the vocabulary (see AI_TASK_TYPES) is corrupt data
        // for verdict purposes: the raise/clear schemas close over the same enum, so an
        // emit would throw. It stays VISIBLE (status() keeps the row) but never emits —
        // and it must not block its neighbours, so the skip is per-task, inside the loop.
        if (!AI_TASK_TYPES.includes(s.task_type)) {
          this.logger.warn(
            `ai alert evaluation SKIPPED unclassifiable task (no verdict emitted): task_type=${s.task_type}`,
          );
          continue;
        }
        if (s.breaching && s.last_alert !== "raised") {
          const { written } = await this.events.emitOnce({
            event_name: "ai.fallback_alert_raised",
            actor: { actor_type: "system" },
            subject: { subject_type: "ai_job", subject_id: null },
            payload: this.verdictPayload(s),
            idempotencyKey: AiAlertsService.raiseKey(s.task_type, new Date(now)),
          });
          raised.push(s.task_type);
          // The key dedupes the RECORD; `written` dedupes the EMAIL. A racing replica
          // that lost the insert does not re-notify.
          if (written) {
            await this.emailFallbackRaise(s, emailed);
          }
        } else if (!s.breaching && s.last_alert === "raised") {
          await this.events.emitOnce({
            event_name: "ai.fallback_alert_cleared",
            actor: { actor_type: "system" },
            subject: { subject_type: "ai_job", subject_id: null },
            payload: this.verdictPayload(s),
            idempotencyKey: AiAlertsService.clearKey(s.task_type, new Date(now)),
          });
          cleared.push(s.task_type);
        }
      }
      const spendActive = spend.count > 0;
      if (spendActive) {
        await this.emailSpendCap(spend.latestId, spend.count, hours, emailed);
      }
      return {
        evaluated: true,
        window_hours: hours,
        raised,
        cleared,
        spend_cap_active: spendActive,
        emailed,
      };
    } catch (err) {
      this.logger.warn(
        `ai alert evaluation failed (non-fatal): ${AiAlertsService.safeReason(err)}`,
      );
      return empty;
    }
  }

  /**
   * The `AiCostRecorder` trigger: debounced, awaited, never throws. Awaited (not
   * fire-and-forget) so a test that records N fallback costs and then forces an
   * evaluation sees a settled spine — while in production the debounce keeps the
   * steady-state cost at ~zero (an in-memory timestamp check per call).
   */
  async evaluateSoon(): Promise<void> {
    try {
      await this.evaluate();
    } catch (err) {
      this.logger.warn(
        `ai alert background evaluation failed (non-fatal): ${AiAlertsService.safeReason(err)}`,
      );
    }
  }

  // --- internals ------------------------------------------------------------

  private toStatuses(
    split: AiTaskFallbackRow[],
    states: { taskType: string; eventName: string }[],
    hours: number,
  ): AiTaskAlertStatus[] {
    const minCalls = this.config.AI_FALLBACK_ALERT_MIN_CALLS;
    const threshold = this.config.AI_FALLBACK_ALERT_SHARE;
    const lastByTask = new Map<string, "raised" | "cleared">();
    for (const s of states) {
      lastByTask.set(s.taskType, s.eventName === "ai.fallback_alert_raised" ? "raised" : "cleared");
    }
    return split.map((row) => {
      const share = row.totalCalls === 0 ? 0 : row.fallbackCalls / row.totalCalls;
      const breaching = row.totalCalls >= minCalls && share >= threshold;
      const last = lastByTask.get(row.taskType) ?? null;
      return {
        task_type: row.taskType,
        window_hours: hours,
        total_calls: row.totalCalls,
        real_calls: row.realCalls,
        fallback_calls: row.fallbackCalls,
        fallback_share: share,
        breaching,
        last_alert: last,
        active: breaching,
      };
    });
  }

  private verdictPayload(s: AiTaskAlertStatus): {
    task_type: AiCostTaskType;
    window_hours: number;
    total_calls: number;
    fallback_calls: number;
    fallback_share: number;
    threshold_share: number;
    min_calls: number;
  } {
    return {
      // Evaluated tasks are filtered to AI_TASK_TYPES before any emit (see evaluate()),
      // so this cast cannot meet a label the verdict schema rejects — and the emit is
      // still validated by createEvent, so a drift fails loudly here instead of silently.
      task_type: s.task_type as AiCostTaskType,
      window_hours: s.window_hours,
      total_calls: s.total_calls,
      fallback_calls: s.fallback_calls,
      fallback_share: s.fallback_share,
      // The thresholds that were applied are part of the record: a future threshold
      // change must not rewrite what "breach" meant on the day it was recorded.
      threshold_share: this.config.AI_FALLBACK_ALERT_SHARE,
      min_calls: this.config.AI_FALLBACK_ALERT_MIN_CALLS,
    };
  }

  private static dayStamp(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  private static raiseKey(taskType: string, now: Date): string {
    return `ai.fallback_alert_raised:${taskType}:${AiAlertsService.dayStamp(now)}`;
  }

  private static clearKey(taskType: string, now: Date): string {
    return `ai.fallback_alert_cleared:${taskType}:${AiAlertsService.dayStamp(now)}`;
  }

  /** Secret-free failure tag (mirrors HealthService.safeReason): code/name only, never a message. */
  private static safeReason(err: unknown): string {
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
      return err.name;
    }
    return "unknown";
  }

  private static recipients(raw: string): string[] {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));
  }

  private async emailFallbackRaise(s: AiTaskAlertStatus, emailed: string[]): Promise<void> {
    if (!this.config.AI_ALERT_EMAIL_ENABLED) return;
    const to = AiAlertsService.recipients(this.config.AI_ALERT_EMAIL_TO);
    if (to.length === 0) {
      this.logger.warn(
        "ai fallback alert email SKIPPED: AI_ALERT_EMAIL_ENABLED is on but AI_ALERT_EMAIL_TO names no recipient",
      );
      return;
    }
    const pct = (s.fallback_share * 100).toFixed(1);
    const subject = `BadaBhai AI alert: ${s.task_type} ran ${pct}% fallback over ${s.window_hours}h`;
    const text =
      `${s.task_type}: ${s.fallback_calls}/${s.total_calls} recorded calls fell back ` +
      `(share ${pct}%, threshold ${(this.config.AI_FALLBACK_ALERT_SHARE * 100).toFixed(0)}%, ` +
      `min ${this.config.AI_FALLBACK_ALERT_MIN_CALLS} calls, window ${s.window_hours}h). ` +
      `Recorded as ai.fallback_alert_raised; see GET /admin/ai-alerts.`;
    try {
      for (const recipient of to) {
        await this.email.send({
          to: recipient,
          subject,
          html: `<p>${text}</p>`,
          text,
          principal: "admin",
          purpose: "ai_alert",
        });
      }
      emailed.push(`fallback:${s.task_type}`);
    } catch (err) {
      // Opaque by pipeline contract; the record (the event) already committed above.
      this.logger.warn(
        `ai fallback alert email failed for ${s.task_type} (record kept, non-fatal): ${AiAlertsService.safeReason(err)}`,
      );
    }
  }

  private async emailSpendCap(
    latestId: string | null,
    count: number,
    hours: number,
    emailed: string[],
  ): Promise<void> {
    if (!this.config.AI_ALERT_EMAIL_ENABLED) return;
    // Seed silently: a deploy during an active cap must not backfill-email the past.
    if (this.lastEmailedSpendCapId === undefined) {
      this.lastEmailedSpendCapId = latestId;
      if (latestId === null) return;
      return;
    }
    if (latestId === null || latestId === this.lastEmailedSpendCapId) return;
    this.lastEmailedSpendCapId = latestId;
    const to = AiAlertsService.recipients(this.config.AI_ALERT_EMAIL_TO);
    if (to.length === 0) {
      this.logger.warn(
        "ai spend-cap alert email SKIPPED: AI_ALERT_EMAIL_ENABLED is on but AI_ALERT_EMAIL_TO names no recipient",
      );
      return;
    }
    const subject = `BadaBhai AI alert: spend cap tripped (${count} breach(es) over ${hours}h)`;
    const text =
      `The AI gateway refused ${count} real call(s) on spend/circuit-breaker grounds in the ` +
      `last ${hours}h (ai.spend_cap_exceeded). See GET /admin/ai-alerts.`;
    try {
      for (const recipient of to) {
        await this.email.send({
          to: recipient,
          subject,
          html: `<p>${text}</p>`,
          text,
          principal: "admin",
          purpose: "ai_alert",
        });
      }
      emailed.push("spend_cap");
    } catch (err) {
      this.logger.warn(
        `ai spend-cap alert email failed (record kept, non-fatal): ${AiAlertsService.safeReason(err)}`,
      );
    }
  }
}
