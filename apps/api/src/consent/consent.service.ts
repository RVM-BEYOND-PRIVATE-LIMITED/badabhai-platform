import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { EMPLOYER_CONTACT_NOTICE_VERSIONS, EMPLOYER_CONTACT_PURPOSES } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { SessionService } from "../auth/session.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ConsentRepository } from "./consent.repository";
import type { AcceptConsentDto, MyConsentState } from "./consent.dto";
import { AgeBelowMinimumException, AgeConfirmationRequiredException } from "./age-gate";

/**
 * The two employer-contact purposes (`@badabhai/types`) are granted and removed TOGETHER — ONE
 * switch, not two. A worker who is disclosable but unmessageable would sell a payer a credit for
 * a handle that dials nothing, which is the exact defect E0 exists to close.
 */
const isEmployerContactPurpose = (purpose: string): boolean =>
  (EMPLOYER_CONTACT_PURPOSES as readonly string[]).includes(purpose);

/**
 * May a consent row at `consentVersion` carry an employer-contact purpose? Only when that notice
 * version SHOWED the employer-sharing copy (docs/product/employer-sharing-consent-notice.md).
 * Rows are append-only, so recording `employer_sharing` against older words would be a permanent
 * false claim about what the worker read — refused, not repaired later.
 */
function assertEmployerNoticeShown(consentVersion: string): void {
  if (!EMPLOYER_CONTACT_NOTICE_VERSIONS.includes(consentVersion)) {
    throw new BadRequestException(
      `consent_version ${consentVersion} did not show the employer-sharing notice`,
    );
  }
}

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private readonly consents: ConsentRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly pii: PiiCryptoService,
    private readonly sessions: SessionService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Record consent for `workerId` — which the CONTROLLER takes from the verified
   * session, never from the request body (XB-A). The signature makes that
   * structural: there is no worker id on `dto` to reach for by mistake.
   *
   * #2541 — THE SIGN-UP AGE GATE runs here, before any write (owner rulings 2026-11-04 on
   * CEO pack v1 A4 #9: every sign-up, a yes/no self-declaration, under-18 stops):
   *   - `age_18_plus: false` → {@link refuseUnderage}: no consent row (and any live one is
   *     withdrawn), so ConsentGuard keeps every processing route closed; 403. Whatever the flag
   *     says.
   *   - answer missing + `SIGNUP_AGE_GATE_ENABLED` → 400, nothing written or emitted.
   *   - answer missing + flag off → today's behaviour exactly (no age event).
   *   - `age_18_plus: true` → today's consent, plus `consent.age_declared` naming the row.
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

    if (dto.age_18_plus === false) return this.refuseUnderage(workerId, ctx);
    if (dto.age_18_plus === undefined && this.config.SIGNUP_AGE_GATE_ENABLED) {
      throw new AgeConfirmationRequiredException();
    }
    // After the age gate, so an under-18 answer is always refused (and any live consent
    // withdrawn) whatever else the body carries.
    if (dto.purposes.some(isEmployerContactPurpose)) assertEmployerNoticeShown(dto.consent_version);

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

    if (dto.age_18_plus === true) {
      await this.events.emit({
        event_name: "consent.age_declared",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, age_18_plus: true, consent_id: consent.id },
        idempotencyKey: `consent.age_declared:${consent.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    return { consent_id: consent.id, accepted_at: acceptedAt.toISOString() };
  }

  /**
   * #2541 — the worker said they are under 18. The owner ruling is "stop, keep the account
   * dormant": NO consent row is written (so nothing may be processed — ConsentGuard and every
   * consent read already treat "no row" as "no"), and the worker row stays exactly as any
   * never-consented sign-up's does. The APP signs the worker out on the 403; they can come back
   * at 18 and answer again.
   *
   * A LIVE CONSENT FROM BEFORE THIS ANSWER MUST NOT OUTLIVE IT. The shipped app never shows the
   * consent screen to a consented worker, but a direct call (or a future re-consent flow) could
   * answer "under 18" while a live row exists — and leaving it would keep a declared minor
   * profiled and visible to employers. So that row is withdrawn through {@link withdraw}, the
   * one consent-exit path (row stamped, sessions revoked, `consent.revoked`). It runs FIRST and
   * FAILS CLOSED: a failed stamp throws before anything is recorded.
   *
   * No sessions are revoked in the common case (no prior consent). `revokeAll` would push
   * "logged out everywhere" to a minor's phone, and a never-consented session reaches no
   * processing route anyway. The event carries no idempotency key: each refusal is its own fact.
   * Returns `never` — it always ends in the 403.
   */
  private async refuseUnderage(workerId: string, ctx: RequestContext): Promise<never> {
    const latest = await this.consents.findLatestByWorker(workerId);
    if (latest && latest.revokedAt === null) {
      this.logger.warn("under-18 answer from a worker with live consent: withdrawing it");
      await this.withdraw(workerId, ctx);
    }
    await this.events.emit({
      event_name: "consent.age_declared",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId, age_18_plus: false, consent_id: null },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    throw new AgeBelowMinimumException();
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
    const withdrawn = current.filter(isEmployerContactPurpose);
    if (withdrawn.length === 0) {
      return { ok: true, consent_id: null, withdrawn: [] };
    }

    const remaining = current.filter((purpose) => !isEmployerContactPurpose(purpose));
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

  /**
   * 2026-11-04 (E4 items 6-7) — the OPT-IN mirror of {@link withdrawEmployerContact}: an existing
   * worker was shown the approved employer-sharing notice (the app's one-time prompt, or the
   * Settings switch) and said yes. Without this, a worker who onboarded before the notice could
   * never become visible to payers: the candidate-search pool needs `employer_sharing` on his
   * LATEST row, and the only other way to write one is a full onboarding accept.
   *
   * THE ARRAY IS DERIVED SERVER-SIDE, exactly as the withdrawal's is: latest row ∪ the two
   * employer-contact purposes. The caller names only the NOTICE VERSION he was shown, and that
   * version must be one that carried the employer copy — the row is stamped with it, because it is
   * now the most recent notice he agreed to. (His other purposes carry over unchanged; their
   * wording did not change at this version.)
   *
   * IDEMPOTENT: a latest row already holding both purposes writes nothing and emits nothing.
   * 404 when there is no live row: a worker who never consented, or revoked everything, goes
   * through onboarding consent, not through this.
   */
  async grantEmployerContact(
    workerId: string,
    consentVersion: string,
    ip: string | undefined,
    userAgent: string | undefined,
    ctx: RequestContext,
  ): Promise<{ ok: true; consent_id: string | null; granted: string[] }> {
    assertEmployerNoticeShown(consentVersion);
    const latest = await this.consents.findLatestByWorker(workerId);
    if (!latest || latest.revokedAt !== null) {
      throw new NotFoundException(`No live consent record for worker ${workerId}`);
    }

    const current = latest.purposes ?? [];
    const granted = EMPLOYER_CONTACT_PURPOSES.filter((purpose) => !current.includes(purpose));
    if (granted.length === 0) {
      return { ok: true, consent_id: null, granted: [] };
    }

    const consent = await this.consents.create({
      workerId,
      consentVersion,
      purposes: [...current, ...granted],
      acceptedAt: new Date(),
      ipHash: ip ? this.pii.hashIp(ip) : null,
      userAgent: userAgent ?? null,
    });

    await this.events.emit({
      event_name: "consent.purposes_granted",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "consent", subject_id: consent.id },
      payload: {
        worker_id: workerId,
        consent_id: consent.id,
        consent_version: consentVersion,
        granted_purposes: granted,
      },
      idempotencyKey: `consent.purposes_granted:${consent.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true, consent_id: consent.id, granted };
  }
}
