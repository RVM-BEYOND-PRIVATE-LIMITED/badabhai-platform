import { Inject, Injectable } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { type Database, events, type EventRow } from "@badabhai/db";
import type { BadaBhaiEvent } from "@badabhai/event-schema";
import { DATABASE } from "../database/database.module";

/** Persists validated events to the `events` table (insert-only). */
@Injectable()
export class EventsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Most-recent events first, for the read-only ops console. */
  async list(limit = 100): Promise<EventRow[]> {
    return this.db.select().from(events).orderBy(desc(events.occurredAt)).limit(limit);
  }

  async insert(event: BadaBhaiEvent): Promise<void> {
    await this.db.insert(events).values({
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
      payload: event.payload as Record<string, unknown>,
      metadata: event.metadata as Record<string, unknown>,
    });
  }
}
