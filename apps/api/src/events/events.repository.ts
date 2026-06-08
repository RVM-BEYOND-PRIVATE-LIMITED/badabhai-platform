import { Inject, Injectable } from "@nestjs/common";
import { type Database, events } from "@badabhai/db";
import type { BadaBhaiEvent } from "@badabhai/event-schema";
import { DATABASE } from "../database/database.module";

/** Persists validated events to the `events` table (insert-only). */
@Injectable()
export class EventsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
