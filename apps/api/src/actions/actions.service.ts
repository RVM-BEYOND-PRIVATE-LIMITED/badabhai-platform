import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { looksLikePii } from "@badabhai/validators";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import type { RecordActionDto, RecordActionsBatchDto } from "./actions.dto";

/**
 * Records worker-side behavioural actions as `action.recorded` events — the raw
 * material for the future Learn layer. Generic + extensible (new actions are a
 * data change to ACTION_TYPES), append-only into the event store, no PII.
 *
 * This is NOT the employer/match feedback loop (shortlist/reject/hire/no-show);
 * that learning loop is deferred with matching.
 */
@Injectable()
export class ActionsService {
  constructor(
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
  ) {}

  async record(dto: RecordActionDto, ctx: RequestContext) {
    await this.assertWorkerExists(dto.worker_id);
    assertNoPii(dto);

    await this.events.emit(this.toEmitParams(dto, ctx));

    return { recorded: true, worker_id: dto.worker_id, action_type: dto.action_type };
  }

  async recordBatch(dto: RecordActionsBatchDto, ctx: RequestContext) {
    // Validate every action up front so an invalid item rejects the whole batch
    // before any write (mirrors emitMany's all-or-nothing semantics).
    const workerIds = new Set(dto.actions.map((a) => a.worker_id));
    await Promise.all([...workerIds].map((id) => this.assertWorkerExists(id)));
    dto.actions.forEach(assertNoPii);

    const events = await this.events.emitMany(
      dto.actions.map((a) => this.toEmitParams(a, ctx)),
    );

    return { recorded_count: events.length };
  }

  private toEmitParams(
    dto: RecordActionDto,
    ctx: RequestContext,
  ): EmitParams<"action.recorded"> {
    const payload: PayloadInputOf<"action.recorded"> = {
      worker_id: dto.worker_id,
      action_type: dto.action_type,
      target_type: dto.target_type ?? null,
      target_id: dto.target_id ?? null,
      client_occurred_at: dto.client_occurred_at ?? null,
      source_surface: dto.source_surface ?? "worker_app",
      context: dto.context ?? {},
    };
    return {
      event_name: "action.recorded",
      actor: { actor_type: "worker", actor_id: dto.worker_id },
      subject: { subject_type: "worker", subject_id: dto.worker_id },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    };
  }

  private async assertWorkerExists(workerId: string): Promise<void> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);
  }
}

/**
 * Fail-closed PII guard at the capture boundary. The only free-form input is the
 * `context` bag; reject anything in a key OR a string value that looks like a
 * phone or email so raw PII can never reach the events table. We name the
 * position, never the offending content (which would log the PII we reject).
 *
 * NOTE: this is best-effort. `context` is for non-PII signals (counts, statuses,
 * enums, lengths) — names/addresses are not phone/email-shaped and are NOT
 * detected here, so callers must not put free text in context.
 */
function assertNoPii(dto: RecordActionDto): void {
  for (const [key, value] of Object.entries(dto.context ?? {})) {
    if (looksLikePii(key)) {
      throw new BadRequestException("a context key looks like PII; actions must not carry raw PII");
    }
    if (typeof value === "string" && looksLikePii(value)) {
      throw new BadRequestException(
        `context.${key} looks like PII (phone/email); actions must not carry raw PII`,
      );
    }
  }
}
