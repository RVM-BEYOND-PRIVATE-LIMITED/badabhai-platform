import { Inject, Injectable } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { type Database, events, type EventRow } from "@badabhai/db";
import type { BadaBhaiEvent } from "@badabhai/event-schema";
import { DATABASE } from "../database/database.module";

/** An event plus its optional delivery-dedup token (TD18). */
export interface EventToInsert {
  event: BadaBhaiEvent;
  /** Stable key for idempotent insert; null/undefined = no dedup (insert always). */
  idempotencyKey?: string | null;
}

/** Persists validated events to the `events` table (insert-only). */
@Injectable()
export class EventsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Most-recent events first, for the read-only ops console. */
  async list(limit = 100): Promise<EventRow[]> {
    return this.db.select().from(events).orderBy(desc(events.occurredAt)).limit(limit);
  }

  /**
   * Insert one event. Idempotent under at-least-once retry (TD18): when an
   * `idempotencyKey` is given and a row with that key already exists, the insert
   * is a no-op (`ON CONFLICT DO NOTHING`). Returns `true` if a row was written,
   * `false` if it was deduplicated. Rows with no key always insert (Postgres
   * treats NULL keys as distinct).
   *
   * `executor` lets a caller run this insert inside its OWN transaction (the events
   * table + the SoR tables are the same Postgres DB), so a SoR write + the event
   * emit commit atomically (must-fix H3). Defaults to the injected db.
   */
  async insert(
    event: BadaBhaiEvent,
    idempotencyKey?: string | null,
    executor: Database = this.db,
  ): Promise<boolean> {
    const written = await executor
      .insert(events)
      .values(toRow(event, idempotencyKey))
      .onConflictDoNothing({ target: events.idempotencyKey })
      .returning({ id: events.id });
    return written.length > 0;
  }

  /**
   * Bulk insert (one round-trip) — used for batched action recording. Per-row
   * `ON CONFLICT DO NOTHING`, so a keyed duplicate inside (or across) batches is
   * silently skipped. Returns the number of rows actually written.
   */
  async insertMany(batch: EventToInsert[]): Promise<number> {
    if (batch.length === 0) return 0;
    const written = await this.db
      .insert(events)
      .values(batch.map((b) => toRow(b.event, b.idempotencyKey)))
      .onConflictDoNothing({ target: events.idempotencyKey })
      .returning({ id: events.id });
    return written.length;
  }
}

function toRow(event: BadaBhaiEvent, idempotencyKey?: string | null) {
  return {
    id: event.event_id,
    eventName: event.event_name,
    eventVersion: event.event_version,
    occurredAt: new Date(event.occurred_at),
    actorType: event.actor.actor_type,
    actorId: event.actor.actor_id,
    subjectType: event.subject.subject_type,
    subjectId: event.subject.subject_id,
    correlationId: event.correlation_id,
    causationId: event.causation_id,
    idempotencyKey: idempotencyKey ?? null,
    payload: event.payload as Record<string, unknown>,
    metadata: event.metadata as Record<string, unknown>,
  };
}
