import { Injectable, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { SessionService } from "../auth/session.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ConsentRepository } from "./consent.repository";
import type { AcceptConsentDto, MyConsentState } from "./consent.dto";

/**
 * The two employer-contact purposes the E0 C-2 exit removes — ONE switch, not two. A
 * worker who is disclosable but unmessageable would sell a payer a credit for a handle
 * that dials nothing, which is the exact defect E0 exists to close.
 */
const EMPLOYER_CONTACT_PURPOSES = ["employer_sharing", "employer_messaging"] as const;

@Injectable()
export class ConsentService {
  constructor(
    private readonly consents: ConsentRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Record consent for `workerId` — which the CONTROLLER takes from the verified
   * session, never from the request body (XB-A). The signature makes that
   * structural: there is no worker id on `dto` to reach for by mistake.
   */
  async accept(
    workerId: string,
    dto: AcceptConsentDto,
    ip: string | undefined,
    userAgent: string | undefined,
    ctx: RequestContext,
  ) {
    const worker = await this.workers.findById(workerId);
    // Unreachable via the guarded route (a session cannot outlive its worker's
    // row — deletion revokes sessions), but kept: the alternative is writing a
    // consent row against a worker that no longer exists.
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const acceptedAt = new Date();
    const consent = await this.consents.create({
      workerId,
      consentVersion: dto.consent_version,
      purposes: dto.purposes,
      acceptedAt,
      ipHash: ip ? this.pii.hashIp(ip) : null,
      userAgent: userAgent ?? null,
    });

    await this.events.emit({
      event_name: "consent.accepted",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "consent", subject_id: consent.id },
      payload: {
        worker_id: workerId,
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

  /**
   * #1637 — the caller's LATEST consent row, for the stop-employer-contact switch.
   *
   * WHY IT EXISTS. The consent surface was write-only, so the FE could only render the
   * switch from optimistic local state; #1630 requires server truth on mount and after a
   * write. This is that read.
   *
   * NO ROW IS A REAL ANSWER, not a 404: a worker who has never consented renders "off".
   * `ip_hash`/`user_agent` are deliberately absent — they are consent EVIDENCE, not state a
   * client draws (§9). Purposes come back verbatim; `[]` when there is no row.
   */
  async getLatestForWorker(workerId: string): Promise<MyConsentState> {
    const latest = await this.consents.findLatestByWorker(workerId);
    if (!latest) {
      return {
        consent_id: null,
        consent_version: null,
        accepted_at: null,
        revoked_at: null,
        purposes: [],
      };
    }
    return {
      consent_id: latest.id,
      consent_version: latest.consentVersion,
      accepted_at: latest.acceptedAt.toISOString(),
      revoked_at: latest.revokedAt ? latest.revokedAt.toISOString() : null,
      purposes: [...(latest.purposes ?? [])],
    };
  }

  /**
   * E0 C-2 (`docs/agent/phases/E0_BUILD.md`) — the PER-PURPOSE exit from employer contact.
   *
   * WHAT IT IS FOR. The only exits today are `withdraw` above (all-or-nothing, and it logs
   * the worker out of every device) and account deletion. Neither is an exit from employer
   * contact; both are exits from the product. This writes a NEW consent row that omits
   * exactly the two employer-contact purposes and carries everything else over, so the
   * worker keeps profiling, resume generation and voice — and stays logged in.
   *
   * THE ARRAY IS DERIVED SERVER-SIDE, FROM THE LATEST ROW, AND THAT IS THE WHOLE RISK. A
   * client-supplied list would be one screen bug away from dropping `profiling`, and
   * consent rows are append-only — the mistake would be permanent. This method takes no
   * purposes from the caller; there is no field for them to arrive in.
   *
   * IDEMPOTENT: a latest row that already omits both purposes is a no-op — no new row (the
   * table is append-only and rows are not free) and no event (nothing changed).
   *
   * C-3: because `UnlockService`'s relay resolution re-reads the LATEST consent row at use
   * time, this exit reaches unlocks that are already live — a payer who unlocked the worker
   * before he left can no longer message him. Without that, "stop" would mean "stop in
   * fourteen days".
   */
  async withdrawEmployerContact(
    workerId: string,
    ip: string | undefined,
    userAgent: string | undefined,
    ctx: RequestContext,
  ): Promise<{ ok: true; consent_id: string | null; withdrawn: string[] }> {
    const latest = await this.consents.findLatestByWorker(workerId);
    if (!latest || latest.revokedAt !== null) {
      // Nothing live to derive from. 404 matches the consent surface's "no row" posture;
      // there is no row to write a narrowed version of.
      throw new NotFoundException(`No live consent record for worker ${workerId}`);
    }

    const current = latest.purposes ?? [];
    const withdrawn = current.filter((purpose) =>
      (EMPLOYER_CONTACT_PURPOSES as readonly string[]).includes(purpose),
    );
    if (withdrawn.length === 0) {
      return { ok: true, consent_id: null, withdrawn: [] };
    }

    const remaining = current.filter(
      (purpose) => !(EMPLOYER_CONTACT_PURPOSES as readonly string[]).includes(purpose),
    );
    const consent = await this.consents.create({
      workerId,
      // The SAME notice version the worker actually read — the copy has not changed, and
      // stamping a newer version would record a claim about what he was shown that is false.
      consentVersion: latest.consentVersion,
      purposes: remaining,
      acceptedAt: new Date(),
      ipHash: ip ? this.pii.hashIp(ip) : null,
      userAgent: userAgent ?? null,
    });

    await this.events.emit({
      event_name: "consent.purposes_withdrawn",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "consent", subject_id: consent.id },
      payload: {
        worker_id: workerId,
        consent_id: consent.id,
        withdrawn_purposes: withdrawn,
      },
      idempotencyKey: `consent.purposes_withdrawn:${consent.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true, consent_id: consent.id, withdrawn };
  }
}
