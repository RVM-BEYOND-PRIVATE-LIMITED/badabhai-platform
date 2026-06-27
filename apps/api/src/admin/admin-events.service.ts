import { Injectable, NotFoundException } from "@nestjs/common";
import type { EventRow } from "@badabhai/db";
import { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";
import {
  AdminEventsRepository,
  type CountBucket,
  type DayBucket,
  type EventFilter,
} from "./admin-events.repository";
import { decodeCursor, encodeCursor } from "./admin-events.cursor";
import {
  ADMIN_TRACE_MAX,
  type AdminEventDetail,
  type AdminEventListItem,
  type AdminEventsQueryDto,
  type AdminExportQueryDto,
  type AdminMetricsQueryDto,
  type AdminTimelineQueryDto,
} from "./admin-events.dto";

/** A keyset page: the (PII-free) rows + an opaque next-cursor (null when exhausted). */
export interface AdminEventsPage {
  events: AdminEventListItem[];
  nextCursor: string | null;
}

/** A funnel stage: the event name, its count, and the k-anon-floored emit. */
export interface FunnelStage {
  event_name: string;
  count: number;
  /** Distinct subjects behind the count — floored to 0 when below the k-anon floor. */
  distinct_subjects: number;
  /** True when the stage's distinct-subject count was suppressed (below the floor). */
  suppressed: boolean;
}

export interface AdminEventMetrics {
  window_days: number;
  by_event_name: CountBucket[];
  by_day: DayBucket[];
  by_actor_type: CountBucket[];
  funnel: FunnelStage[];
  breaches: CountBucket[];
  k_anon_floor: number;
}

/** The export result handed to the controller for serialization (PII-free rows). */
export interface AdminEventsExport {
  format: "csv" | "json";
  rows: AdminEventListItem[];
  count: number;
}

/**
 * Read-only event-spine query service for the Admin Ops Portal (ADR-0025 ADMIN-2).
 *
 * The ONLY admin path that touches `events`, and it is SELECT-ONLY (via
 * {@link AdminEventsRepository}). The single WRITE it performs is emitting the audited
 * `admin.action_performed` for an export — through {@link EventsService.emit}, never a raw
 * events writer (so the spine stays append-only, must-fix #3).
 *
 * FACELESS PROJECTIONS: list/timeline/trace responses are ids + enums + timestamps + the
 * already-PII-free payload. The metrics aggregates apply a k-anon floor so a single-worker
 * count can never single out one worker (mirrors the agency k-anon `< floor` rule).
 */
@Injectable()
export class AdminEventsService {
  /**
   * k-anonymity floor for funnel aggregates (ADR-0025; mirrors the agency MIN_BUCKET=5 rule,
   * ADR-0022 C.1 #2). A funnel stage whose DISTINCT-subject count is strictly below this is
   * suppressed (reported as 0, `suppressed=true`) so the dashboard can never reveal that ONE
   * specific worker reached a stage. The raw row count is NOT a worker oracle on its own (many
   * events per worker), so it is shown; the distinct-subject witness is the floored quantity.
   */
  static readonly K_ANON_FLOOR = 5;

  /**
   * The conversion funnel surfaced on the dashboard (CLAUDE.md exit criteria + the demand loop).
   * Ordered stages; the UI renders stage-to-stage conversion. Each is an existing registered
   * event name.
   */
  static readonly FUNNEL_STAGES = [
    "feed.shown",
    "application.submitted",
    "unlock.granted",
    "contact.revealed",
  ] as const;

  /** The breach/circuit-breaker counters surfaced for ops monitoring (existing event names). */
  static readonly BREACH_EVENTS = [
    "worker.otp_send_cap_exceeded",
    "payer.otp_send_cap_exceeded",
    "ai.spend_cap_exceeded",
    "pace.ops_alert_raised",
    "unlock.cap_exceeded",
  ] as const;

  constructor(
    private readonly repo: AdminEventsRepository,
    private readonly events: EventsService,
  ) {}

  /** Route #1 — keyset-paginated, filtered event list. */
  async list(dto: AdminEventsQueryDto): Promise<AdminEventsPage> {
    const filter = AdminEventsService.toFilter(dto);
    const cursor = decodeCursor(dto.cursor);
    // Fetch one extra to know if there's a next page WITHOUT a count(*) over the whole filter.
    const rows = await this.repo.listKeyset(filter, dto.limit + 1, cursor);
    const hasMore = rows.length > dto.limit;
    const page = hasMore ? rows.slice(0, dto.limit) : rows;
    const last = page[page.length - 1];
    return {
      events: page.map(AdminEventsService.toListItem),
      nextCursor:
        hasMore && last
          ? encodeCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
          : null,
    };
  }

  /** Route #2 — full PII-free event detail (envelope + payload + metadata). */
  async getById(id: string): Promise<AdminEventDetail> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException("Event not found");
    return AdminEventsService.toDetail(row);
  }

  /** Route #3 — the causal chain for a correlation id (bounded, oldest-first). */
  async trace(correlationId: string): Promise<{ correlation_id: string; events: AdminEventDetail[] }> {
    const rows = await this.repo.traceByCorrelation(correlationId, ADMIN_TRACE_MAX);
    return {
      correlation_id: correlationId,
      // Detail (incl. payload + causation_id) so the UI can render the causal linkage.
      events: rows.map(AdminEventsService.toDetail),
    };
  }

  /** Route #4 — every event for a subject (keyset-paginated via the subject index). */
  async timeline(
    subjectType: string,
    subjectId: string,
    dto: AdminTimelineQueryDto,
  ): Promise<AdminEventsPage & { subject_type: string; subject_id: string }> {
    const cursor = decodeCursor(dto.cursor);
    const rows = await this.repo.listKeyset({ subjectType, subjectId }, dto.limit + 1, cursor);
    const hasMore = rows.length > dto.limit;
    const page = hasMore ? rows.slice(0, dto.limit) : rows;
    const last = page[page.length - 1];
    return {
      subject_type: subjectType,
      subject_id: subjectId,
      events: page.map(AdminEventsService.toListItem),
      nextCursor:
        hasMore && last
          ? encodeCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
          : null,
    };
  }

  /** Route #5 — dashboard aggregates with a k-anon floor on the funnel. */
  async metrics(dto: AdminMetricsQueryDto): Promise<AdminEventMetrics> {
    const since = new Date(Date.now() - dto.windowDays * 86400_000);
    const [byEventName, byDay, byActorType] = await Promise.all([
      this.repo.countByEventName(since),
      this.repo.countByDay(since),
      this.repo.countByActorType(since),
    ]);

    const funnel = await Promise.all(
      AdminEventsService.FUNNEL_STAGES.map(async (name): Promise<FunnelStage> => {
        const { count, distinctSubjects } = await this.repo.eventNameStats(name, since);
        const suppressed = distinctSubjects > 0 && distinctSubjects < AdminEventsService.K_ANON_FLOOR;
        return {
          event_name: name,
          count,
          distinct_subjects: suppressed ? 0 : distinctSubjects,
          suppressed,
        };
      }),
    );

    // Breaches are aggregate, by-construction PII-free counters (no worker subject) — counted raw.
    const breachMap = new Map(byEventName.map((b) => [b.key, b.count]));
    const breaches: CountBucket[] = AdminEventsService.BREACH_EVENTS.map((name) => ({
      key: name,
      count: breachMap.get(name) ?? 0,
    }));

    return {
      window_days: dto.windowDays,
      by_event_name: byEventName,
      by_day: byDay,
      by_actor_type: byActorType,
      funnel,
      breaches,
      k_anon_floor: AdminEventsService.K_ANON_FLOOR,
    };
  }

  /**
   * Route #6 — bounded export of PII-free events + the AUDITED `admin.action_performed` emit.
   * The export FACT is recorded on the spine (who exported, with a filter-hash as the opaque
   * target id) — keys/codes only, never the filter VALUES or any PII.
   */
  async export(
    adminId: string,
    dto: AdminExportQueryDto,
    ctx: RequestContext,
  ): Promise<AdminEventsExport> {
    const filter = AdminEventsService.toFilter(dto);
    const rows = await this.repo.listForExport(filter, dto.limit);

    await this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      // The export is not a mutation of one entity — pin the subject to the admin principal.
      subject: { subject_type: "admin_session", subject_id: adminId },
      payload: {
        admin_id: adminId,
        action_code: "events.export",
        target_type: "events",
        // Opaque, deterministic id for THIS filter shape (a filter-hash UUID) — carries no
        // value/PII; lets the audit row reference "what slice" without leaking the filter.
        target_id: AdminEventsService.filterHashUuid(dto),
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      format: dto.format,
      rows: rows.map(AdminEventsService.toListItem),
      count: rows.length,
    };
  }

  // --- internal mapping / projection (FACELESS by construction) ---

  private static toFilter(dto: AdminEventsQueryDto | AdminExportQueryDto): EventFilter {
    return {
      eventName: dto.eventName,
      actorType: dto.actorType,
      actorId: dto.actorId,
      subjectType: dto.subjectType,
      subjectId: dto.subjectId,
      correlationId: dto.correlationId,
      occurredFrom: dto.occurredFrom,
      occurredTo: dto.occurredTo,
    };
  }

  /** PII-free list projection — spine fields only (ids/enums/timestamps). */
  private static toListItem(e: EventRow): AdminEventListItem {
    return {
      id: e.id,
      event_name: e.eventName,
      event_version: e.eventVersion,
      actor_type: e.actorType,
      actor_id: e.actorId,
      subject_type: e.subjectType,
      subject_id: e.subjectId,
      occurred_at: e.occurredAt,
      correlation_id: e.correlationId,
      causation_id: e.causationId,
    };
  }

  /** Full detail — the list projection + the already-PII-free payload + metadata. */
  private static toDetail(e: EventRow): AdminEventDetail {
    return {
      ...AdminEventsService.toListItem(e),
      payload: (e.payload ?? {}) as Record<string, unknown>,
      metadata: (e.metadata ?? {}) as Record<string, unknown>,
    };
  }

  /**
   * A deterministic, opaque v4-shaped UUID derived from the (PII-free) export filter — so the
   * audit event's `target_id` references "this slice" without storing any filter value. Stable
   * for the same filter; collision-resistant enough for an audit reference.
   */
  private static filterHashUuid(dto: AdminExportQueryDto): string {
    const canonical = JSON.stringify({
      e: [...(dto.eventName ?? [])].sort(),
      at: dto.actorType ?? null,
      ai: dto.actorId ?? null,
      st: dto.subjectType ?? null,
      si: dto.subjectId ?? null,
      c: dto.correlationId ?? null,
      f: dto.occurredFrom?.toISOString() ?? null,
      t: dto.occurredTo?.toISOString() ?? null,
      fmt: dto.format,
      l: dto.limit,
    });
    // FNV-1a over the canonical string → 32 hex chars → format as a UUID. No crypto strength
    // needed (it is an audit reference, not a secret); determinism + opacity are what matter.
    let h1 = 0x811c9dc5;
    let h2 = 0x811c9dc5 ^ 0x5bd1e995;
    for (let i = 0; i < canonical.length; i++) {
      const c = canonical.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ((c << 1) | 1), 0x01000193) >>> 0;
    }
    const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
    // Lay out as 8-4-4-4-12; force version nibble '4' and variant nibble '8' to be UUID-valid.
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      "4" + hex.slice(13, 16),
      "8" + hex.slice(17, 20),
      hex.slice(20, 32),
    ].join("-");
  }
}
