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

  // ---------------------------------------------------------------------------
  // SEAM / INVARIANT (finding #176) — a future DPDP consent-WITHDRAWAL endpoint lives here.
  //
  // A `withdraw()` that stamps `worker_consents.revokedAt` MUST also call
  // `SessionService.revokeAll(workerId)` in the SAME unit of work. The `WorkerAuthGuard` slide/
  // re-mint extends a live session on every [W] route WITHOUT reading consent (a hot-path
  // Postgres read was deliberately rejected for perf/deadlock), so a revoked-but-still-alive
  // session would SELF-RENEW indefinitely. This coupling is a launch-gate for the withdrawal
  // endpoint; it is locked by a regression test on the only current revoker (account-deletion).
  // Wiring SessionService here means importing AuthModule's SessionService — mind the module
  // cycle (AuthModule already imports ConsentModule), or place `revokeAll` in the caller.
  // ---------------------------------------------------------------------------

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
      // Keyed on the consent RECORD id (one per acceptance), not the worker — a
      // legitimate re-consent creates a new record → new key → not blocked.
      idempotencyKey: `consent.accepted:${consent.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { consent_id: consent.id, accepted_at: acceptedAt.toISOString() };
  }
}
