import { Controller, Get, Query } from "@nestjs/common";
import { clampLimit } from "../common/pagination";
import { EventsRepository } from "./events.repository";

/**
 * Read-only event stream for the ops console. Event payloads carry ids/hashes
 * only (never raw PII) by construction — see the event-schema registry.
 */
@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsRepository) {}

  @Get()
  async list(@Query("limit") limit?: string) {
    const rows = await this.events.list(clampLimit(limit));
    return {
      events: rows.map((e) => ({
        id: e.id,
        event_name: e.eventName,
        event_version: e.eventVersion,
        actor_type: e.actorType,
        subject_type: e.subjectType,
        subject_id: e.subjectId,
        occurred_at: e.occurredAt,
        correlation_id: e.correlationId,
      })),
    };
  }
}
