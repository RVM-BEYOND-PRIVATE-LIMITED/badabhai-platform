import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { type Database, events, type EventRow } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { type KeysetCursor } from "./admin-events.cursor";

/**
 * Resolved, validated event filter (built by the service from the DTO). All fields optional;
 * each present field maps onto an EXISTING `events` index so the query is index-backed.
 */
export interface EventFilter {
  eventName?: string[];
  actorType?: string;
  actorId?: string;
  subjectType?: string;
  subjectId?: string;
  correlationId?: string;
  occurredFrom?: Date;
  occurredTo?: Date;
}

/** A single bucket from a GROUP BY aggregation. */
export interface CountBucket {
  key: string;
  count: number;
}

/** Per-day count bucket (UTC day). */
export interface DayBucket {
  day: string;
  count: number;
}

/**
 * The payload keys {@link AdminEventsRepository.countByPayloadField} may group by — a CLOSED
 * set, exported so a caller cannot widen it by passing a string.
 *
 * WHY THIS LIST EXISTS AT ALL. The grouping key is rendered as a SQL LITERAL, not a bound
 * parameter (see the method header for the Postgres reason), so this array IS the entire
 * injection surface of that read. Enumerating it here makes the surface reviewable in one
 * place, and the runtime membership check in `payloadKeyExpr` makes it fail closed rather than
 * relying on the compile-time union alone.
 */
export const ADMIN_PAYLOAD_GROUP_FIELDS = ["reason"] as const;
export type AdminPayloadGroupField = (typeof ADMIN_PAYLOAD_GROUP_FIELDS)[number];

/**
 * SELECT-ONLY data access over the `events` spine for the Admin Ops Portal (ADR-0025 ADMIN-2).
 *
 * SPINE IMMUTABILITY (ADR-0025 must-fix #3, CLAUDE.md invariant #1): this repository issues
 * ONLY `select(...)`/`count` reads against `events`. It has NO `update(events)` / `delete(events)`
 * method and never calls one — the static build-blocker (`admin-static-guards.test.ts`) scans
 * `admin/**` for those tokens and fails CI on any write. The events table is append-only; the
 * only writer in the whole codebase is `EventsRepository.insert` (via `EventsService.emit`).
 *
 * INDEX-BACKED + BOUNDED: every method either filters on an indexed column
 * (`events_event_name_idx`, `events_occurred_at_idx`, `events_subject_idx`,
 * `events_correlation_id_idx`) and/or applies a hard `limit`. Pagination is KEYSET on
 * `(occurred_at, id)`, never OFFSET. No method runs an unbounded query.
 *
 * PII-FREE: event rows are PII-free by registry construction (payloads carry ids/hashes/codes
 * only). This repository returns rows verbatim; the faceless projection lives in the service.
 */
@Injectable()
export class AdminEventsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Build the AND-of-conditions for a filter (each clause hits an indexed column). */
  private static whereFor(filter: EventFilter): SQL[] {
    const clauses: SQL[] = [];
    if (filter.eventName && filter.eventName.length > 0) {
      // event_name IN (...) — uses events_event_name_idx.
      clauses.push(inArray(events.eventName, filter.eventName));
    }
    if (filter.actorType) clauses.push(eq(events.actorType, filter.actorType));
    if (filter.actorId) clauses.push(eq(events.actorId, filter.actorId));
    // (subject_type, subject_id) — uses events_subject_idx (composite).
    if (filter.subjectType) clauses.push(eq(events.subjectType, filter.subjectType));
    if (filter.subjectId) clauses.push(eq(events.subjectId, filter.subjectId));
    // correlation_id — uses events_correlation_id_idx.
    if (filter.correlationId) clauses.push(eq(events.correlationId, filter.correlationId));
    // occurred_at range — uses events_occurred_at_idx.
    if (filter.occurredFrom) clauses.push(gte(events.occurredAt, filter.occurredFrom));
    if (filter.occurredTo) clauses.push(lte(events.occurredAt, filter.occurredTo));
    return clauses;
  }

  /**
   * The keyset predicate for "strictly OLDER than the cursor" under the DESC `(occurred_at, id)`
   * sort: `occurred_at < cur` OR (`occurred_at = cur` AND `id < curId`). Total ordering via the
   * unique `id` tie-breaker, so no row is skipped or repeated across page boundaries.
   *
   * BUGFIX (BP-1, 2026-08-04): the `<` terms were interpolated `sql` templates. Those pass the
   * value to the driver UNMAPPED, so the `Date` arrived raw and postgres-js threw
   * `The "string" argument must be of type string ... Received an instance of Date` — every
   * request carrying a cursor 500'd. Page one worked, so the events explorer looked fine and
   * only "Next" was broken. `lt(column, value)` routes through the column's
   * `mapToDriverValue`, which is what encodes the timestamp.
   */
  private static keysetBefore(cursor: KeysetCursor): SQL {
    const cur = new Date(cursor.occurredAt);
    return or(lt(events.occurredAt, cur), and(eq(events.occurredAt, cur), lt(events.id, cursor.id)))!;
  }

  /**
   * Keyset-paginated, filtered list (route #1 + #4 share this). Orders DESC on
   * `(occurred_at, id)` and fetches `limit` rows after the (optional) cursor. The caller passes
   * an already-capped `limit`; this method does not relax it.
   */
  async listKeyset(filter: EventFilter, limit: number, cursor: KeysetCursor | null): Promise<EventRow[]> {
    const clauses = AdminEventsRepository.whereFor(filter);
    if (cursor) clauses.push(AdminEventsRepository.keysetBefore(cursor));
    const where = clauses.length > 0 ? and(...clauses) : undefined;
    return this.db
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);
  }

  /** Single event by id (route #2). PII-free row or undefined. */
  async findById(id: string): Promise<EventRow | undefined> {
    const [row] = await this.db.select().from(events).where(eq(events.id, id)).limit(1);
    return row;
  }

  /**
   * The causal chain for a correlation id (route #3): all events sharing `correlation_id`,
   * oldest-first (so the UI renders the chain top-down), bounded by `limit`. Uses
   * `events_correlation_id_idx`.
   */
  async traceByCorrelation(correlationId: string, limit: number): Promise<EventRow[]> {
    return this.db
      .select()
      .from(events)
      .where(eq(events.correlationId, correlationId))
      .orderBy(asc(events.occurredAt), asc(events.id))
      .limit(limit);
  }

  /** Bounded, filtered fetch for export (route #6). DESC, hard row cap applied by the caller. */
  async listForExport(filter: EventFilter, limit: number): Promise<EventRow[]> {
    const clauses = AdminEventsRepository.whereFor(filter);
    const where = clauses.length > 0 ? and(...clauses) : undefined;
    return this.db
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(limit);
  }

  // --- Aggregations for the metrics dashboard (route #5). All windowed by `since`. ---

  /** Counts grouped by `event_name` within the window (uses events_event_name_idx scan). */
  async countByEventName(since: Date): Promise<CountBucket[]> {
    const rows = await this.db
      .select({ key: events.eventName, count: sql<number>`count(*)::int` })
      .from(events)
      .where(gte(events.occurredAt, since))
      .groupBy(events.eventName)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
  }

  /** Counts grouped by UTC day within the window. */
  async countByDay(since: Date): Promise<DayBucket[]> {
    const rows = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${events.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        count: sql<number>`count(*)::int`,
      })
      .from(events)
      .where(gte(events.occurredAt, since))
      .groupBy(sql`date_trunc('day', ${events.occurredAt} at time zone 'UTC')`)
      .orderBy(sql`date_trunc('day', ${events.occurredAt} at time zone 'UTC')`);
    return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
  }

  /** Counts grouped by `actor_type` within the window. */
  async countByActorType(since: Date): Promise<CountBucket[]> {
    const rows = await this.db
      .select({ key: events.actorType, count: sql<number>`count(*)::int` })
      .from(events)
      .where(gte(events.occurredAt, since))
      .groupBy(events.actorType)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
  }

  /**
   * The grouping key for {@link countByPayloadField}: `coalesce(payload->>'<field>', 'unknown')`,
   * built ONCE so the SELECT, GROUP BY and ORDER BY all render the same text.
   *
   * ── WHY THE KEY IS A LITERAL AND NOT A BOUND PARAMETER (BUGFIX, 2026-08-19) ─────────────
   * The first version of this passed `field` as a parameter — `payload->>${field}` — and it
   * 500'd EVERY request, measured against a real Postgres:
   *
   *     ERROR: column "events.payload" must appear in the GROUP BY clause or be used in an
   *     aggregate function
   *
   * Drizzle renders each occurrence of a `Param` as its own placeholder, so the same expression
   * came out as `$1` in the SELECT list, `$4` in GROUP BY and `$5` in ORDER BY. Postgres matches
   * a GROUP BY expression STRUCTURALLY, and `Param(paramid=1)` is not equal to `Param(paramid=4)`
   * — so the projected expression was never recognised as grouped, and the `events.payload` Var
   * inside it was therefore ungrouped. Reusing one `SQL` object does not help: the placeholder
   * index is assigned per render, not per object. Rendering the key as a literal removes the
   * `Param` entirely; all three clauses become the identical `Const`-bearing expression, which
   * is what Postgres's structural match needs. It is also what every other `->>` in this
   * codebase does (`notifications`, `posting-plans`, `ai-jobs`): literal key, value as the param.
   *
   * ── WHY THAT IS NOT AN INJECTION SEAM ───────────────────────────────────────────────────
   * `field` is typed to the CLOSED {@link ADMIN_PAYLOAD_GROUP_FIELDS} union and re-checked
   * against it at runtime here, so the only string that can ever reach `sql.raw` is one of the
   * literals in that array. Traced end to end: the sole caller is
   * `AdminDashboardService.summary`, which passes `AdminDashboardService.CAP_BREACH_FIELD` — a
   * `static readonly` constant, `"reason"`. No request DTO, query string, body or path parameter
   * reaches this argument, and the runtime check fails closed if one ever tries.
   */
  private static payloadKeyExpr(field: AdminPayloadGroupField): SQL<string> {
    // The compile-time union is erased at runtime, so re-assert it: a caller arriving through
    // `any`, JS interop or a future `as` cast must not be able to reach `sql.raw`.
    if (!(ADMIN_PAYLOAD_GROUP_FIELDS as readonly string[]).includes(field)) {
      throw new Error("countByPayloadField: unsupported payload group field");
    }
    return sql<string>`coalesce(${events.payload}->>${sql.raw(`'${field}'`)}, 'unknown')`;
  }

  /**
   * ONE event name's rows in the window, grouped by a payload FIELD (BP-5).
   *
   * WHY IT IS HERE AND NOT IN THE DASHBOARD REPOSITORY. `events` has exactly one admin reader by
   * design — this class — and the dashboard's cap-breach split is a read of `events`. Giving the
   * dashboard its own `from(events)` would make two, and the property this file's header states
   * ("no admin file issues update/delete against the spine", enforced by a source scan over
   * admin/**) is far easier to keep true of one class than of every class that grows an
   * aggregate. The single-reader half is a build-blocker too (`admin-static-guards.test.ts`).
   * The dashboard SERVICE stays separate — see `AdminDashboardService` — because that is where
   * the cross-table composition would have contaminated `AdminEventsService`.
   *
   * INDEX-BACKED AND BOUNDED IN THE ONLY WAY THAT MATTERS: `event_name = ?` uses
   * `events_event_name_idx`, which is what keeps this off the full spine. The event NAME and the
   * window bound are still bound parameters; only the payload KEY is a literal, for the
   * GROUP-BY reason in {@link payloadKeyExpr}.
   *
   * A payload missing the field groups under `NULL` and is reported as the literal
   * `"unknown"` rather than dropped: a breach whose reason did not serialize is still a breach,
   * and a silently-omitted bucket is how "silence means zero" starts.
   */
  async countByPayloadField(
    eventName: string,
    field: AdminPayloadGroupField,
    since: Date,
  ): Promise<CountBucket[]> {
    const key = AdminEventsRepository.payloadKeyExpr(field);
    const rows = await this.db
      .select({ key, count: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.eventName, eventName), gte(events.occurredAt, since)))
      .groupBy(key)
      .orderBy(desc(sql`count(*)`), key);
    return rows.map((r) => ({ key: r.key, count: Number(r.count) }));
  }

  /**
   * Distinct count of one event name within the window AND its distinct-subject count — the
   * latter is the k-anon witness (how many distinct workers/subjects a funnel stage covers).
   * Uses events_event_name_idx + events_occurred_at_idx.
   */
  async eventNameStats(eventName: string, since: Date): Promise<{ count: number; distinctSubjects: number }> {
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        distinctSubjects: sql<number>`count(distinct ${events.subjectId})::int`,
      })
      .from(events)
      .where(and(eq(events.eventName, eventName), gte(events.occurredAt, since)));
    return {
      count: Number(row?.count ?? 0),
      distinctSubjects: Number(row?.distinctSubjects ?? 0),
    };
  }
}
