import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  AGENCY_TWIN_ORG_LABEL,
  AGENCY_TWIN_SYSTEM_ACTOR_ID,
  isAgencyTwinSyncEnabled,
  isMatchV1Enabled,
  type ServerConfig,
} from "@badabhai/config";
import {
  agencyTwinConstantsProblems,
  type AgencyTwinContext,
  type AgencyTwinDisarmed,
  type AgencyTwinSyncOutcome,
  type AgencyTwinWrite,
  type Database,
} from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { MatchConfigService } from "../match/match-config.service";
import { AgencyTwinRepository } from "./agency-twin.repository";

/** Agency jobs per sweep page, and the page cap per tick (≤ 10,000 jobs a tick). */
export const AGENCY_TWIN_SWEEP_PAGE = 200;
export const AGENCY_TWIN_SWEEP_MAX_PAGES = 50;
/** Twins the kill switch moves per tick (one bounded statement). */
export const AGENCY_TWIN_DISARM_BATCH = 500;
/**
 * How far back the event poll reads the spine. Several poll intervals wide, so a slow or skipped
 * tick still sees every event; re-reading is free because the sync writes nothing on no change.
 */
export const AGENCY_TWIN_EVENT_LOOKBACK_MS = 10 * 60_000;
/** Distinct job ids one poll may take; anything beyond is converged by the sweep. */
export const AGENCY_TWIN_EVENT_POLL_LIMIT = 500;

/**
 * THE ONE MAPPING from a sync write to the `job_posting.twin_synced` v1 payload — used by the api
 * service and by the `sync-agency-twins` CLI, so the two cannot emit different shapes.
 */
export function twinSyncedPayload(w: AgencyTwinWrite): PayloadInputOf<"job_posting.twin_synced"> {
  return {
    job_posting_id: w.jobPostingId,
    source_job_id: w.sourceJobId,
    operation: w.operation,
    status: w.status,
    changed_fields: w.changedFields,
    refused_reason: w.refusedReason,
  };
}

/** The payload for one twin the kill switch paused (ADR-0050 §7). */
export function killSwitchPayload(
  m: AgencyTwinDisarmed,
): PayloadInputOf<"job_posting.twin_synced"> {
  return {
    job_posting_id: m.jobPostingId,
    source_job_id: m.sourceJobId,
    operation: "refused",
    status: "paused",
    changed_fields: ["status"],
    refused_reason: "kill_switch",
  };
}

/** What one tick did — counts only (ids never leave the spine). */
export interface AgencyTwinTickSummary {
  armed: boolean;
  jobs: number;
  written: number;
  unchanged: number;
  blocked: number;
  failed: number;
  disarmed: number;
}

const emptySummary = (armed: boolean): AgencyTwinTickSummary => ({
  armed,
  jobs: 0,
  written: 0,
  unchanged: 0,
  blocked: 0,
  failed: 0,
  disarmed: 0,
});

/**
 * ADR-0050 — the agency-job V1 twin sync, as the api runs it (#1957).
 *
 * C3: the agency service writes `jobs` exactly as before and never writes `job_postings`; this
 * service DERIVES the twin from the committed row, outside any agency transaction, so a failed or
 * slow sync can never fail, delay or roll back an agency write. Two triggers, one unit:
 *
 *   - the EVENT POLL ({@link pollRecentEvents}) re-syncs every agency job named by a recent
 *     `job.created` / `job.updated` / `job.closed` — the agency service is not changed to call it;
 *   - the SWEEP ({@link sweep}) walks every agency job: the convergence guarantee, which also
 *     catches the ADR-0037 suspension cascade and any write that emits no event.
 *
 * THE KILL SWITCH (§7). Read only through `isAgencyTwinSyncEnabled`. Disarmed, the sweep does ONE
 * thing — drive every non-closed twin to `paused` — and the poll does nothing; no field is copied.
 *
 * Every write emits exactly one validated `job_posting.twin_synced` v1 (actor `system`) on the
 * write's own transaction. Ids and enums only, in the payload and in the logs.
 */
@Injectable()
export class AgencyTwinService implements OnModuleInit {
  private readonly logger = new Logger(AgencyTwinService.name);

  constructor(
    private readonly repo: AgencyTwinRepository,
    private readonly events: EventsService,
    private readonly matchConfig: MatchConfigService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * ADR-0050 Q3 — the fixed system actor and the neutral org label are checked AT BOOT. A bad
   * edit to `@badabhai/config` stops the api here, before any twin could carry it (fail closed).
   */
  onModuleInit(): void {
    const problems = agencyTwinConstantsProblems(
      AGENCY_TWIN_SYSTEM_ACTOR_ID,
      AGENCY_TWIN_ORG_LABEL,
    );
    if (problems.length > 0) {
      throw new Error(`ADR-0050 agency-twin constants are invalid: ${problems.join("; ")}`);
    }
    this.logger.log(`agency twin sync armed=${isAgencyTwinSyncEnabled(this.config)}`);
  }

  /** Armed? (the kill switch). */
  isArmed(): boolean {
    return isAgencyTwinSyncEnabled(this.config);
  }

  /** The per-run context: the V1 deploy state, the posting form's breadth, the Q3 constants. */
  private async context(): Promise<AgencyTwinContext> {
    const cfg = await this.matchConfig.get();
    return {
      matchV1Enabled: isMatchV1Enabled(this.config),
      relatedSkillsDefault: cfg.relatedSkillsDefault,
      systemActorId: AGENCY_TWIN_SYSTEM_ACTOR_ID,
      orgLabel: AGENCY_TWIN_ORG_LABEL,
    };
  }

  /**
   * Sync ONE agency job (armed only — a disarmed call writes nothing and returns null). Errors
   * propagate to the caller, which logs and moves on; the next sweep retries the job.
   */
  async syncJob(jobId: string): Promise<AgencyTwinSyncOutcome | null> {
    if (!this.isArmed()) return null;
    return this.repo.sync(jobId, await this.context(), (tx, write) => this.emitWrite(tx, write));
  }

  /** The event poll tick. No-op while disarmed (the sweep owns the disarm). */
  async pollRecentEvents(now: Date = new Date()): Promise<AgencyTwinTickSummary> {
    if (!this.isArmed()) return emptySummary(false);
    const since = new Date(now.getTime() - AGENCY_TWIN_EVENT_LOOKBACK_MS);
    const ids = await this.repo.recentAgencyJobIds(since, AGENCY_TWIN_EVENT_POLL_LIMIT);
    return this.syncAll(ids, await this.context());
  }

  /**
   * The sweep tick. ARMED: converge every agency job, page by page. DISARMED: the kill switch's
   * one bounded statement, and nothing else.
   */
  async sweep(): Promise<AgencyTwinTickSummary> {
    if (!this.isArmed()) {
      const moved = await this.repo.disarm(AGENCY_TWIN_DISARM_BATCH, (tx, m) =>
        this.emitDisarmed(tx, m),
      );
      return { ...emptySummary(false), disarmed: moved.length };
    }
    const ctx = await this.context();
    const total = emptySummary(true);
    let afterId: string | null = null;
    for (let page = 0; page < AGENCY_TWIN_SWEEP_MAX_PAGES; page += 1) {
      const ids = await this.repo.listAgencyJobIds(afterId, AGENCY_TWIN_SWEEP_PAGE);
      const s = await this.syncAll(ids, ctx);
      total.jobs += s.jobs;
      total.written += s.written;
      total.unchanged += s.unchanged;
      total.blocked += s.blocked;
      total.failed += s.failed;
      if (ids.length < AGENCY_TWIN_SWEEP_PAGE) break;
      afterId = ids[ids.length - 1] ?? null;
    }
    return total;
  }

  /** One transaction per job; one job's failure never stops the others. */
  private async syncAll(
    ids: readonly string[],
    ctx: AgencyTwinContext,
  ): Promise<AgencyTwinTickSummary> {
    const s = emptySummary(true);
    for (const id of ids) {
      s.jobs += 1;
      try {
        const out = await this.repo.sync(id, ctx, (tx, write) => this.emitWrite(tx, write));
        if (out.kind === "written") s.written += 1;
        else if (out.kind === "unchanged") s.unchanged += 1;
        else if (out.kind === "blocked_by_conversion") {
          s.blocked += 1;
          this.logger.warn(
            `agency twin blocked: job=${id} is held by D4 posting=${out.jobPostingId}`,
          );
        }
      } catch (err) {
        s.failed += 1;
        this.logger.warn(
          `agency twin sync failed for job=${id} (retried by the next sweep): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return s;
  }

  /** `job_posting.twin_synced` for one write, on the write's transaction. */
  private async emitWrite(tx: Database, w: AgencyTwinWrite): Promise<void> {
    await this.emit(tx, twinSyncedPayload(w));
  }

  /** `job_posting.twin_synced` for one twin the kill switch paused. */
  private async emitDisarmed(tx: Database, m: AgencyTwinDisarmed): Promise<void> {
    await this.emit(tx, killSwitchPayload(m));
  }

  private async emit(
    tx: Database,
    payload: PayloadInputOf<"job_posting.twin_synced">,
  ): Promise<void> {
    await this.events.emit({
      event_name: "job_posting.twin_synced",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "job_posting", subject_id: payload.job_posting_id },
      payload,
      tx,
      correlationId: randomUUID(),
      requestId: "agency-twin-sync",
    });
  }
}
