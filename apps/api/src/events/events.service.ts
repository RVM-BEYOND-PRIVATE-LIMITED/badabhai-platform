import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  createEvent,
  type BadaBhaiEvent,
  type CreateEventInput,
  type EventName,
} from "@badabhai/event-schema";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsRepository } from "./events.repository";

/**
 * Params for emitting an event. `source` and `metadata` are filled by the
 * service; callers provide the domain bits + tracing ids.
 */
export type EmitParams<N extends EventName> = Omit<
  CreateEventInput<N>,
  "source" | "metadata" | "correlation_id" | "causation_id"
> & {
  correlationId?: string;
  causationId?: string | null;
  requestId?: string;
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
    const { correlationId, causationId, requestId, ...rest } = params;

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

    await this.repo.insert(event);
    this.logger.log(
      `event=${event.event_name} subject=${event.subject.subject_type}:${event.subject.subject_id ?? "-"} correlation=${event.correlation_id}`,
    );
    return event;
  }

  /**
   * Emit many events of the SAME event name in a single DB round-trip. Every
   * event is built + validated first (so one invalid item rejects the whole
   * batch before any write). Used for batched action recording.
   */
  async emitMany<N extends EventName>(list: EmitParams<N>[]): Promise<BadaBhaiEvent<N>[]> {
    const events = list.map(({ correlationId, causationId, requestId, ...rest }) =>
      createEvent<N>({
        ...rest,
        source: "api",
        correlation_id: correlationId,
        causation_id: causationId ?? null,
        metadata: {
          environment: this.config.NODE_ENV,
          service: "api",
          request_id: requestId ?? null,
        },
      }),
    );

    await this.repo.insertMany(events);
    const first = events[0];
    if (first) {
      this.logger.log(`events=${events.length} event=${first.event_name} (batch)`);
    }
    return events;
  }
}
