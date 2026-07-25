import { Injectable, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { SessionService } from "../auth/session.service";
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
    private readonly sessions: SessionService,
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
      idempotencyKey: `consent.accepted:${consent.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { consent_id: consent.id, accepted_at: acceptedAt.toISOString() };
  }

  async withdraw(workerId: string, ctx: RequestContext): Promise<{ ok: true }> {
    await this.consents.withdraw(workerId);
    let sessionsRevoked = 0;
    try {
      sessionsRevoked = await this.sessions.revokeAll(workerId);
    } catch {
      // Best-effort: a revoke failure must NOT prevent the consent-withdrawal event.
    }
    await this.events.emit({
      event_name: "consent.revoked",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "consent", subject_id: workerId },
      payload: {
        worker_id: workerId,
        sessions_revoked: sessionsRevoked,
      },
      idempotencyKey: `consent.revoked:${workerId}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    return { ok: true };
  }
}
