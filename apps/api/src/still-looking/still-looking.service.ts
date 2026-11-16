import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database, StillLookingAnswer } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";

import { DevicesRepository } from "../auth/devices.repository";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { availabilityAnswersV2Enabled } from "../profiles/availability-answers.flag";
import { resolveAvailabilityState } from "../profiles/worker-field-precedence";
import { toAvailabilityV2 } from "../profiles/worker-preferences.vocabulary";
import { PushEnqueuer } from "../push/push-enqueuer.service";
import { searchExitEnabled } from "../search-exit/search-exit.flag";
import { SearchExitService } from "../search-exit/search-exit.service";
import { istDayOf } from "../worker-activity/worker-activity";
import { WorkerActivityService } from "../worker-activity/worker-activity.service";
import type { StillLookingResponse } from "./still-looking.dto";
import {
  stillLookingCheckEnabled,
  stillLookingEveryDays,
  stillLookingPushEnabled,
} from "./still-looking.flag";
import {
  StillLookingRepository,
  type LatestCheck,
  type OpenedCheck,
} from "./still-looking.repository";

/** Postgres `undefined_table`: here, migration 0173 not applied yet. */
const PG_UNDEFINED_TABLE = "42P01";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The event the sweep emits, and the template the Alerts entry and the push copy come from. */
export const STILL_LOOKING_PROMPTED_EVENT = "worker.still_looking_prompted";

/** Workers per sweep transaction: one short insert plus one event row each. */
export const STILL_LOOKING_SWEEP_BATCH = 200;
/** Batches per tick (40,000 workers a day). What is left waits for tomorrow's tick. */
export const STILL_LOOKING_SWEEP_MAX_BATCHES = 200;

/** What one sweep tick did — counts only, no ids (BullMQ job-inspection surface). */
export interface StillLookingSweepResult {
  readonly armed: boolean;
  readonly opened: number;
  readonly pushed: number;
}

/** What an answer did beyond storing it, for the log line (closed values only). */
type SearchEffect = "shown" | "hidden" | "unchanged" | "switch_off" | "none";

/**
 * Whether the card should ask availability again: his stored answer is empty (or a key nobody
 * knows), or — only while the brief's four answers are switched on — one of the OLD keys, so the
 * card re-asks with the four. With the four off, an old key is the answer the app still offers, so
 * asking again would loop. Part A's own map decides what "old" is: a key of the four maps to
 * itself, an old key to a different one, an unknown one to nothing.
 */
export function availabilityNeedsAnswer(status: string | null, fourAnswersOn: boolean): boolean {
  const mapped = toAvailabilityV2(status);
  if (mapped === null) return true;
  return fourAnswersOn && mapped !== status;
}

let missingTableWarned = false;

/**
 * THE MONTHLY "STILL LOOKING?" CHECK (#2753 item 5).
 *
 *  - {@link sweep}: the daily tick. Opens one check per due worker and emits
 *    `worker.still_looking_prompted` in the same transaction (the in-app card is the open check;
 *    the Alerts entry is that event, through the static template). With
 *    `STILL_LOOKING_PUSH_ENABLED` on as well, each opened check is also pushed.
 *  - {@link status}: `GET /workers/me/still-looking`.
 *  - {@link answer}: `POST /workers/me/still-looking`, ONE TRANSACTION.
 *
 * THE SWITCH FIRST, ALWAYS. With `STILL_LOOKING_CHECK_ENABLED` off every route method is a 404 and
 * the sweep returns at once, and NOTHING reads or writes `still_looking_checks`. That is what
 * makes migration 0173 apply-before-the-switch. On before 0173, the routes answer 503 (nothing
 * written) and the sweep logs one warning per process and opens nothing.
 *
 * WHAT AN ANSWER DOES, each effect behind its OWN switch (off → the effect is skipped, the answer
 * is still stored):
 *  - `yes`: back into company search (SEARCH_EXIT_ENABLED; removes a `monthly_check` exit and a
 *    `worker` one too, because "yes" means looking);
 *  - `not_now`: out of company search with via `monthly_check` (SEARCH_EXIT_ENABLED);
 *  - `hired`: STORED AND REPORTED ONLY. A hire record (`hires`, part H) is keyed by a company and a
 *    posting, both NOT NULL, and the worker's answer names neither — so `HiresService` is not
 *    called whatever HIRE_RECORDS_ENABLED says; the worker desk links the answer to a hire later
 *    (owner question 2 default: his own `hired` is reported, confirmed only when the company or the
 *    desk agrees). The `worker.still_looking_answered` event is the report.
 * Every answer moves his last active day to today, through part B's service, AFTER the commit
 * (fire-and-forget by design; a no-op while WORKER_ACTIVITY_ENABLED is off).
 *
 * LOGS IDS AND CLOSED CODES ONLY.
 */
@Injectable()
export class StillLookingService {
  private readonly logger = new Logger(StillLookingService.name);

  constructor(
    private readonly repo: StillLookingRepository,
    private readonly events: EventsService,
    private readonly searchExit: SearchExitService,
    private readonly activity: WorkerActivityService,
    private readonly devices: DevicesRepository,
    private readonly push: PushEnqueuer,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** `STILL_LOOKING_CHECK_ENABLED`, read per call through the one reader. */
  get enabled(): boolean {
    return stillLookingCheckEnabled(this.config);
  }

  /**
   * `GET /workers/me/still-looking` — is a check due, does availability need asking again, and his
   * last active day and mark (the company rows' one definition). A read: no event.
   */
  async status(workerId: string, now: Date = new Date()): Promise<StillLookingResponse> {
    this.assertOn();
    return this.read(workerId, now, false);
  }

  /**
   * `POST /workers/me/still-looking` — store his answer and apply what it means, in ONE
   * transaction: answer the open check, or (none open: an answer from Settings) open and answer
   * one; emit `worker.still_looking_answered`; move him in or out of company search. Then, after
   * the commit, touch his activity day. Answers the GET shape.
   *
   * THE REPEAT IS A NO-OP. With no check open and his latest check already holding this answer,
   * given inside the window (STILL_LOOKING_EVERY_DAYS), no row is written and no answer event is
   * emitted. The search effect is re-applied, and it is itself a no-op unless something else moved
   * him since (his own search switch), in which case "yes" still means looking. A retried tap
   * therefore writes nothing and answers the same body. The same answer given again AFTER the
   * window is a new answer (a new row), so it restarts the month like any other.
   *
   * Two taps racing are serialised on a per-worker advisory lock, so they cannot both see "none
   * open" and both insert.
   */
  async answer(
    workerId: string,
    answer: StillLookingAnswer,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<StillLookingResponse> {
    this.assertOn();
    let outcome: { checkId: string; stored: boolean; search: SearchEffect };
    try {
      outcome = await this.repo.withTransaction(async (tx) => {
        await this.repo.lockWorker(workerId, tx);
        const open = await this.repo.findOpen(workerId, tx, { forUpdate: true });
        let checkId: string;
        let stored = true;
        if (open !== null && (await this.repo.answerOpen(open.id, answer, now, tx))) {
          checkId = open.id;
        } else {
          const latest = await this.repo.findLatest(workerId, tx);
          if (latest !== null && this.isRepeat(latest, answer, now)) {
            checkId = latest.id;
            stored = false;
          } else {
            checkId = await this.repo.insertAnswered(workerId, answer, now, tx);
          }
        }
        if (stored) await this.emitAnswered(workerId, checkId, answer, ctx, tx);
        const search = await this.applySearchEffect(workerId, answer, ctx, tx);
        return { checkId, stored, search };
      });
    } catch (err) {
      throw this.unavailableIfMissing(err, "write", workerId);
    }

    // AFTER THE COMMIT: he was active today. Fire-and-forget by design (B's contract: never awaited,
    // never throws, a no-op while WORKER_ACTIVITY_ENABLED is off). A failed transaction never
    // reaches this line.
    this.activity.touch(workerId, istDayOf(now));

    this.logger.log(
      `still-looking answered (worker=${workerId} check=${outcome.checkId} answer=${answer} ` +
        `stored=${outcome.stored} search=${outcome.search})`,
    );
    return this.read(workerId, now, true);
  }

  /**
   * The daily tick: open a check for every due worker, in batches of {@link
   * STILL_LOOKING_SWEEP_BATCH}, each batch one transaction with its events. Idempotent across
   * processes (the open-check unique index guards the insert; only rows actually inserted get an
   * event, and the event's idempotency key is the check id). Off: returns at once, no query.
   * `onlyWorkerIds` narrows the tick to those workers (the DB gate); the processor never passes it.
   */
  async sweep(
    now: Date = new Date(),
    onlyWorkerIds?: readonly string[],
  ): Promise<StillLookingSweepResult> {
    if (!this.enabled) return { armed: false, opened: 0, pushed: 0 };
    const cutoff = new Date(now.getTime() - stillLookingEveryDays(this.config) * DAY_MS);
    const pushOn = stillLookingPushEnabled(this.config);
    // One correlation per tick, so a tick's prompts read as one run on the spine.
    const correlationId = randomUUID();
    let opened = 0;
    let pushed = 0;
    for (let batch = 0; batch < STILL_LOOKING_SWEEP_MAX_BATCHES; batch += 1) {
      let rows: Array<OpenedCheck & { eventId: string }>;
      try {
        rows = await this.repo.withTransaction(async (tx) => {
          const inserted = await this.repo.openDue(
            now,
            cutoff,
            STILL_LOOKING_SWEEP_BATCH,
            tx,
            onlyWorkerIds,
          );
          const out: Array<OpenedCheck & { eventId: string }> = [];
          for (const row of inserted) {
            const event = await this.events.emit({
              event_name: STILL_LOOKING_PROMPTED_EVENT,
              actor: { actor_type: "system" },
              subject: { subject_type: "worker", subject_id: row.workerId },
              payload: {
                worker_id: row.workerId,
                check_id: row.checkId,
              } satisfies PayloadInputOf<"worker.still_looking_prompted">,
              correlationId,
              // One prompt per check, whatever retries a tick goes through.
              idempotencyKey: `${STILL_LOOKING_PROMPTED_EVENT}:${row.checkId}`,
              tx,
            });
            out.push({ ...row, eventId: event.event_id });
          }
          return out;
        });
      } catch (err) {
        if (sqlStateOf(err) !== PG_UNDEFINED_TABLE) throw err;
        warnTableMissingOnce(this.logger);
        return { armed: true, opened, pushed };
      }
      opened += rows.length;
      // After the batch commits: a push for a check that rolled back would point at nothing.
      if (pushOn) {
        for (const row of rows) if (await this.pushPrompt(row)) pushed += 1;
      }
      // A short batch is the end of the list (or another process holds the rest): stop here.
      if (rows.length < STILL_LOOKING_SWEEP_BATCH) break;
    }
    if (opened > 0 || pushed > 0) {
      this.logger.log(`still-looking sweep: opened=${opened} pushed=${pushed} push=${pushOn}`);
    }
    return { armed: true, opened, pushed };
  }

  /** His latest check already holds this answer, given inside the window: the tap is a repeat. */
  private isRepeat(latest: LatestCheck, answer: StillLookingAnswer, now: Date): boolean {
    if (latest.answer !== answer || latest.answeredAt === null) return false;
    const windowStart = now.getTime() - stillLookingEveryDays(this.config) * DAY_MS;
    return latest.answeredAt.getTime() >= windowStart;
  }

  /** The GET shape. `activeToday`: the caller just touched today (the POST), so today counts. */
  private async read(
    workerId: string,
    now: Date,
    activeToday: boolean,
  ): Promise<StillLookingResponse> {
    let open: Awaited<ReturnType<StillLookingRepository["findOpen"]>>;
    let availability: Record<string, unknown> | null;
    try {
      [open, availability] = await Promise.all([
        this.repo.findOpen(workerId),
        this.repo.availabilityAnswer(workerId),
      ]);
    } catch (err) {
      throw this.unavailableIfMissing(err, "read", workerId);
    }
    const status = resolveAvailabilityState({ workerAnswer: availability }).status;
    const activity = await this.activityFacts(workerId, now, activeToday);
    return {
      due: open !== null,
      check_id: open?.id ?? null,
      availability_needs_answer: availabilityNeedsAnswer(
        status,
        availabilityAnswersV2Enabled(this.config),
      ),
      ...activity,
    };
  }

  /**
   * His last active day and the "not recently active" mark, through part B's ONE read and ONE mark
   * helper (the same `NOT_RECENTLY_ACTIVE_DAYS`), so he and a company see one answer. While
   * WORKER_ACTIVITY_ENABLED is off: null / false and NO read.
   */
  private async activityFacts(
    workerId: string,
    now: Date,
    activeToday: boolean,
  ): Promise<Pick<StillLookingResponse, "last_active_on" | "not_recently_active">> {
    if (!this.activity.enabled) return { last_active_on: null, not_recently_active: false };
    const read = await this.activity.lastActiveDays([workerId], now);
    if (read === null) return { last_active_on: null, not_recently_active: false };
    const key = workerId.toLowerCase();
    const days = new Map(read);
    if (activeToday) {
      // The touch is fire-and-forget, so the read may not see it yet; today is a fact either way.
      const today = istDayOf(now);
      const stored = days.get(key);
      if (stored === undefined || stored < today) days.set(key, today);
    }
    return {
      last_active_on: days.get(key) ?? null,
      not_recently_active: this.activity.notRecentlyActive(days, workerId, now),
    };
  }

  /** "yes" → back into company search; "not_now" → out (via monthly_check); "hired" → nothing. */
  private async applySearchEffect(
    workerId: string,
    answer: StillLookingAnswer,
    ctx: RequestContext,
    tx: Database,
  ): Promise<SearchEffect> {
    if (answer === "hired") return "none";
    // SEARCH_EXIT_ENABLED off: the effect is skipped (and `worker_search_exits` never named); the
    // answer itself is still stored. setVisibilityInTransaction checks the same switch again.
    if (!searchExitEnabled(this.config)) return "switch_off";
    const visible = answer === "yes";
    const result = await this.searchExit.setVisibilityInTransaction(
      workerId,
      visible,
      "monthly_check",
      ctx,
      tx,
    );
    if (result === null) return "switch_off";
    if (!result.changed) return "unchanged";
    return visible ? "shown" : "hidden";
  }

  private async emitAnswered(
    workerId: string,
    checkId: string,
    answer: StillLookingAnswer,
    ctx: RequestContext,
    tx: Database,
  ): Promise<void> {
    await this.events.emit({
      event_name: "worker.still_looking_answered",
      // His own answer, on his own record.
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        worker_id: workerId,
        check_id: checkId,
        answer,
      } satisfies PayloadInputOf<"worker.still_looking_answered">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      // A check is answered once (the row lock and `answered_at IS NULL`), so its id is the key.
      idempotencyKey: `worker.still_looking_answered:${checkId}`,
      tx,
    });
  }

  /**
   * Queue the prompt's push to his devices. Best-effort: a failed device read loses this one push
   * (the card and the Alerts entry still show). The copy is the static template; only refs ride.
   */
  private async pushPrompt(row: OpenedCheck & { eventId: string }): Promise<boolean> {
    try {
      const targets = await this.devices.listPushTargets(row.workerId);
      if (targets.length === 0) return false;
      await this.push.enqueue({
        workerId: row.workerId,
        sourceEventId: row.eventId,
        eventName: STILL_LOOKING_PROMPTED_EVENT,
        deviceIds: targets.map((t) => t.id),
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `still-looking push not queued (worker=${row.workerId}, ` +
          `reason=${err instanceof Error ? err.name : "unknown"})`,
      );
      return false;
    }
  }

  private assertOn(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  /** A 503 (logged once: the table and the code) for 42P01; any other error unchanged. */
  private unavailableIfMissing(err: unknown, op: "read" | "write", workerId: string): unknown {
    if (sqlStateOf(err) !== PG_UNDEFINED_TABLE) return err;
    warnTableMissingOnce(this.logger);
    this.logger.warn(`still-looking ${op} unavailable (worker=${workerId} sqlstate=42P01)`);
    return new ServiceUnavailableException();
  }
}

/**
 * The switch is on but `still_looking_checks` (or a table an answer writes) is missing: say so
 * ONCE per process, naming the migration and the code, however many requests and ticks meet it.
 */
function warnTableMissingOnce(logger: Logger): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  logger.warn(
    `still_looking_checks is missing (sqlstate=${PG_UNDEFINED_TABLE}): STILL_LOOKING_CHECK_ENABLED ` +
      "is on but migration 0173_still_looking_checks is not applied. The routes answer 503 and " +
      "the sweep opens nothing until it is.",
  );
}

/** For tests: forget that the missing-table warning was given. */
export function resetStillLookingMissingTableWarningForTests(): void {
  missingTableWarned = false;
}
