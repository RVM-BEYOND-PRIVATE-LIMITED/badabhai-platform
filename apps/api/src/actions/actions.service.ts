import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { looksLikeActionContextPii } from "@badabhai/validators";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import type {
  RecordActionDto,
  RecordActionsBatchDto,
  WorkerRecordActionDto,
  WorkerRecordActionsBatchDto,
} from "./actions.dto";

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

  /**
   * One action recorded by the AUTHENTICATED worker (#694).
   *
   * A THIN SEAM OVER {@link record}, not a parallel implementation. Everything that makes an
   * action safe to store — the worker-exists check, the fail-closed PII guard on `context`, the
   * `action.recorded` shape — has exactly one home, so the worker path cannot drift into being
   * the lenient one. The only thing this adds is the identity, and it adds it from the token.
   */
  async recordForWorker(workerId: string, dto: WorkerRecordActionDto, ctx: RequestContext) {
    return this.record({ ...dto, worker_id: workerId }, ctx);
  }

  /** The batch sibling. Every action in the batch is stamped with the SAME authenticated worker. */
  async recordBatchForWorker(
    workerId: string,
    dto: WorkerRecordActionsBatchDto,
    ctx: RequestContext,
  ) {
    return this.recordBatch(
      { actions: dto.actions.map((a) => ({ ...a, worker_id: workerId })) },
      ctx,
    );
  }

  async recordBatch(dto: RecordActionsBatchDto, ctx: RequestContext) {
    // Validate every action up front so an invalid item rejects the whole batch
    // before any write (mirrors emitMany's all-or-nothing semantics).
    const workerIds = new Set(dto.actions.map((a) => a.worker_id));
    await Promise.all([...workerIds].map((id) => this.assertWorkerExists(id)));
    dto.actions.forEach(assertNoPii);

    const events = await this.events.emitMany(dto.actions.map((a) => this.toEmitParams(a, ctx)));

    return { recorded_count: events.length };
  }

  private toEmitParams(dto: RecordActionDto, ctx: RequestContext): EmitParams<"action.recorded"> {
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
 * `context` bag; reject anything in a key OR a value that looks like a phone,
 * email, human name, or address (TD11 — `looksLikeActionContextPii`) so raw PII
 * can never reach the events table. We name the position, never the offending
 * content (which would log the PII we reject).
 *
 * EVERY VALUE, NOT JUST THE STRINGS. `contextSchema` accepts
 * `string | number | boolean`, and this checked `typeof value === "string"` — so
 * `{"phone":"9876543210"}` was a 400 while the identical `{"phone":9876543210}`
 * was a 201, wrote through `createEvent` unexamined, and landed verbatim in
 * `events.payload.context`. Every 10-digit Indian mobile and every 12-digit
 * Aadhaar is a valid JS number, so the two highest-value PII items on this
 * platform each had a one-character bypass. A skipped value TYPE is not
 * best-effort, it is fail-open, and #705 is what first put worker-controlled
 * JSON on this path (`POST /workers/me/actions`) rather than a trusted
 * service-to-service caller.
 *
 * Numbers are stringified before the check rather than digit-counted separately,
 * so the phone/Aadhaar bound stays defined in exactly one place. Legitimate
 * signals are unaffected: `question_index`, `duration_ms` and `retry_count` are
 * well under the 7-digit run `PHONE_DIGIT_RUN` looks for.
 *
 * NOTE: this remains best-effort ON SHAPE. `context` is for non-PII signals
 * (counts, statuses, enums, lengths); the name tier in particular is ASCII
 * title-case only, so a Devanagari name is not flagged (the R32 ruling stands —
 * name-shape masking measured dead). Callers must not put arbitrary free text in
 * context; what changed here is that no value now goes UNEXAMINED.
 */
function assertNoPii(dto: RecordActionDto): void {
  for (const [key, value] of Object.entries(dto.context ?? {})) {
    if (looksLikeActionContextPii(key)) {
      throw new BadRequestException("a context key looks like PII; actions must not carry raw PII");
    }
    // Booleans cannot carry PII and stringify to two fixed words; everything else is examined.
    const asText = typeof value === "boolean" ? "" : String(value);
    if (asText !== "" && looksLikeActionContextPii(asText)) {
      throw new BadRequestException(
        `context.${key} looks like PII (phone/email/name/address); actions must not carry raw PII`,
      );
    }
  }
}
