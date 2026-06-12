import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "./workers.repository";

/**
 * Worker write-side logic (identity). Read-only ops queries stay on the
 * repository; mutations that touch PII go through here so encryption + the
 * event are never bypassed.
 */
@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);

  constructor(
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /**
   * Record the worker's real name. The name is PII (TD21): it is encrypted at
   * rest (AES-256-GCM, same as phone_e164) and NEVER logged, returned, or placed
   * in an event — only the fact that a name was recorded is emitted. The plaintext
   * name does not leave this method. Returns `{ worker_id }` only.
   */
  async setFullName(
    workerId: string,
    fullName: string,
    ctx: RequestContext,
  ): Promise<{ worker_id: string }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    // Encrypt before it touches the DB — a plaintext name is never persisted.
    const encrypted = this.pii.encrypt(fullName);
    await this.workers.updateFullName(workerId, encrypted);

    // PII-free signal: carries only worker_id (the name stays in workers.full_name).
    await this.events.emit({
      event_name: "worker.name_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    this.logger.log(`full_name recorded (encrypted) for worker ${workerId}`); // never logs the name
    return { worker_id: workerId };
  }
}
