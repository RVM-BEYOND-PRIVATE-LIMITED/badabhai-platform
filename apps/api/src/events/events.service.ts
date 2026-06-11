import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  createEvent,
  type BadaBhaiEvent,
  type CreateEventInput,
  type EventName,
} from "@badabhai/event-schema";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsRepository, type EventToInsert } from "./events.repository";

/**
 * Params for emitting an event. `source` and `metadata` are filled by the
 * service; callers provide the domain bits + tracing ids.
 *
 * `idempotencyKey` (TD18): an optional stable key for the logical event. When
 * supplied, re-emitting the same logical event under an at-least-once retry is a
 * no-op at the DB (`ON CONFLICT DO NOTHING`) — exactly-once in the events table.
 * Omit it for events that are legitimately repeatable (e.g. otp resends,
 * behavioural actions), which then always insert.
 */
export type EmitParams<N extends EventName> = Omit<
  CreateEventInput<N>,
  "source" | "metadata" | "correlation_id" | "causation_id"
> & {
  correlationId?: string;
  causationId?: string | null;
  requestId?: string;
  idempotencyKey?: string;
};

/**
 * The single way to emit events. Builds + validates the event (via
 * `createEvent`), persists it to the events table, and logs it. If the event is
 * invalid this throws before any side effect — guaranteeing only valid events
 * are stored.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly repo: EventsRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async emit<N extends EventName>(params: EmitParams<N>): Promise<BadaBhaiEvent<N>> {
    const { event, idempotencyKey } = this.build(params);

    const written = await this.repo.insert(event, idempotencyKey);
    if (written) {
      this.logger.log(
        `event=${event.event_name} subject=${event.subject.subject_type}:${event.subject.subject_id ?? "-"} correlation=${event.correlation_id}`,
      );
    } else {
      // Idempotent no-op: an event with this key was already stored (at-least-once
      // retry). Log at debug-ish level so duplicate deliveries are observable.
      this.logger.log(
        `event=${event.event_name} DEDUPED (idempotency_key=${idempotencyKey}) correlation=${event.correlation_id}`,
      );
    }
    return event;
  }

  /**
   * Emit many events of the SAME event name in a single DB round-trip. Every
   * event is built + validated first (so one invalid item rejects the whole
   * batch before any write). Used for batched action recording. Per-row
   * `ON CONFLICT DO NOTHING`, so keyed duplicates inside the batch are skipped.
   *
   * RETURNS the built+validated events (length == items accepted), NOT the count
   * actually written — which can differ if a caller passes idempotency keys and a
   * keyed duplicate is deduped. Today the only batch caller (action.recorded) is
   * intentionally UNKEYED, so every row inserts and the two counts coincide. A
   * future keyed batch caller that needs the written count must use the number
   * returned by `repo.insertMany`, not `result.length`.
   */
  async emitMany<N extends EventName>(list: EmitParams<N>[]): Promise<BadaBhaiEvent<N>[]> {
    const built = list.map((p) => this.build(p));
    const toInsert: EventToInsert[] = built.map(({ event, idempotencyKey }) => ({
      event,
      idempotencyKey,
    }));

    const written = await this.repo.insertMany(toInsert);
    const first = built[0]?.event;
    if (first) {
      const deduped = built.length - written;
      this.logger.log(
        `events=${built.length} written=${written}${deduped > 0 ? ` deduped=${deduped}` : ""} event=${first.event_name} (batch)`,
      );
    }
    return built.map((b) => b.event as BadaBhaiEvent<N>);
  }

  /** Build + validate the event and separate out its delivery-dedup key. */
  private build<N extends EventName>(
    params: EmitParams<N>,
  ): { event: BadaBhaiEvent<N>; idempotencyKey?: string } {
    const { correlationId, causationId, requestId, idempotencyKey, ...rest } = params;
    const event = createEvent<N>({
      ...rest,
      source: "api",
      correlation_id: correlationId,
      causation_id: causationId ?? null,
      metadata: {
        environment: this.config.NODE_ENV,
        service: "api",
        request_id: requestId ?? null,
      },
    });
    return { event, idempotencyKey };
  }
}
