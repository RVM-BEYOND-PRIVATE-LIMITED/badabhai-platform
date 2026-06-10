import { Injectable, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ConsentRepository } from "./consent.repository";
import type { AcceptConsentDto } from "./consent.dto";

@Injectable()
export class ConsentService {
  constructor(
    private readonly consents: ConsentRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
  ) {}

  async accept(dto: AcceptConsentDto, ip: string | undefined, userAgent: string | undefined, ctx: RequestContext) {
    const worker = await this.workers.findById(dto.worker_id);
    if (!worker) throw new NotFoundException(`Worker ${dto.worker_id} not found`);

    const acceptedAt = new Date();
    const consent = await this.consents.create({
      workerId: dto.worker_id,
      consentVersion: dto.consent_version,
      purposes: dto.purposes,
      acceptedAt,
      ipHash: ip ? this.pii.hashIp(ip) : null,
      userAgent: userAgent ?? null,
    });

    await this.events.emit({
      event_name: "consent.accepted",
      actor: { actor_type: "worker", actor_id: dto.worker_id },
      subject: { subject_type: "consent", subject_id: consent.id },
      payload: {
        worker_id: dto.worker_id,
        consent_id: consent.id,
        consent_version: dto.consent_version,
        purposes: dto.purposes,
        accepted_at: acceptedAt.toISOString(),
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { consent_id: consent.id, accepted_at: acceptedAt.toISOString() };
  }
}
