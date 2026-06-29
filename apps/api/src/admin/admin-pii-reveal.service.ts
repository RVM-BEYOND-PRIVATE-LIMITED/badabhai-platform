import { HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { AdminPiiRevealRepository } from "./admin-pii-reveal.repository";
import {
  AdminPiiRevealCapService,
  type AdminPiiRevealCapWindow,
} from "./admin-pii-reveal-cap.service";
import type { AdminPiiRevealDto, AdminPiiRevealResponse } from "./admin-pii-reveal.dto";

/**
 * The reason-gated, audited, rate-capped worker-PII reveal (ADR-0025 ADMIN-3b, Decision 4) — the
 * single most sensitive operation in the system: it decrypts a worker's phone and returns it to
 * ONE authenticated admin. EVERY control below is mandatory.
 *
 * OQ-7 (the control that makes reason-gating meaningful): the product owner reviews the
 * `admin.pii_viewed` audit stream WEEKLY and retains it for 1 YEAR. Reason-gating is only
 * meaningful because every reveal is non-repudiably recorded on the spine for that review — see
 * the route doc comment on the controller.
 *
 * The CONTROL PIPELINE, in order (each step happens BEFORE the next; any failure reveals nothing):
 *   1. FLAG: the controller short-circuits to a neutral 404 when the feature flag is OFF — the
 *      service is never reached, so its existence is not observable (Control 1).
 *   2. RATE CAP (must-fix #8, Control 5), checked BEFORE the decrypt: a per-admin hour+day cap in
 *      Redis. A Redis error → DENY (fail closed). An over-cap denial emits a PII-FREE
 *      `admin.pii_reveal_cap_exceeded` breach event and throws the NEUTRAL not-found shape (no
 *      reveal, no oracle).
 *   3. LOOKUP: fetch the worker's ENCRYPTED phone. An unknown worker throws the SAME neutral
 *      not-found shape as a denied case (Control 7 — no enumeration oracle).
 *   4. AUDIT-BEFORE-DECRYPT (must-fix #7, Control 4): emit `admin.pii_viewed {admin_id,
 *      subject_id, reason_code}` and AWAIT it to commit BEFORE any plaintext is computed. If the
 *      emit fails → do NOT decrypt (fail closed). The emit is standalone (NOT in a transaction the
 *      later response could roll back), so the audit row persists even if the response then fails.
 *   5. DECRYPT-AT-BOUNDARY (Control 8): decrypt transiently; the plaintext exists SOLELY in the
 *      returned response body — never logged, cached, persisted, or put on any event.
 *
 * VALUE-NEVER-IN-EVENT/LOG (CLAUDE.md invariant #2): the decrypted phone, the reason note, and the
 * admin's email NEVER touch the event payload (`.strict()` on `AdminPiiViewedPayload` is the
 * structural backstop), a log line, `ai_jobs`, or `audit_logs`. Only the response body carries it.
 */
@Injectable()
export class AdminPiiRevealService {
  private readonly logger = new Logger(AdminPiiRevealService.name);

  constructor(
    private readonly repo: AdminPiiRevealRepository,
    private readonly cap: AdminPiiRevealCapService,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** True when the feature flag is ON. The controller uses this to return a neutral 404 when OFF. */
  isEnabled(): boolean {
    return this.config.ADMIN_PII_REVEAL_ENABLED;
  }

  /**
   * Reveal one worker's decrypted phone to the authenticated admin (single-subject, never bulk —
   * Control 6: exactly one `:id`; there is NO list/range/batch entry point). `dto.note` has
   * ALREADY been residual-PII-validated at the DTO boundary; it is NOT persisted and is NEVER
   * referenced here (it never enters the event/log — Control 3).
   *
   * @param adminId the session admin (`@CurrentAdmin().id`) — the non-spoofable actor.
   * @param workerId the validated path-param uuid — the non-spoofable target (no IDOR).
   */
  async revealContact(
    adminId: string,
    workerId: string,
    dto: AdminPiiRevealDto,
    ctx: RequestContext,
  ): Promise<AdminPiiRevealResponse> {
    // Defense-in-depth: the controller already gated on the flag (neutral 404). If the service is
    // somehow reached with the flag OFF, fail closed with the same neutral shape (no reveal).
    if (!this.isEnabled()) throw AdminPiiRevealService.neutralNotFound();

    // --- Control 5: per-admin rate cap, checked BEFORE the decrypt; fail-closed on Redis error.
    const capResult = await this.cap.consume(adminId);
    if (!capResult.ok) {
      // Over-cap (or Redis down) → reveal NOTHING. Emit a PII-free breach event, then throw the
      // SAME neutral not-found shape (no oracle that distinguishes over-cap from unknown worker).
      await this.emitCapExceeded(adminId, capResult.window, ctx);
      throw AdminPiiRevealService.neutralNotFound();
    }

    // --- Control 7: lookup. An unknown worker throws the SAME neutral shape as any other
    // non-success (no enumeration oracle: "not found" is indistinguishable from "denied").
    const worker = await this.repo.findEncryptedPhone(workerId);
    if (!worker) throw AdminPiiRevealService.neutralNotFound();

    // --- Control 4: AUDIT BEFORE DECRYPT (must-fix #7). Emit + AWAIT the commit of the value-free
    // `admin.pii_viewed` event BEFORE any plaintext is computed. The emit is standalone (no tx),
    // so the audit row persists even if the response then fails (e.g. decrypt throws). If the emit
    // FAILS, the exception propagates and we NEVER reach the decrypt below — fail closed.
    await this.events.emit({
      event_name: "admin.pii_viewed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        admin_id: adminId,
        subject_id: workerId,
        reason_code: dto.reason_code,
      } satisfies PayloadInputOf<"admin.pii_viewed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // --- Control 8: decrypt at the boundary. The plaintext exists ONLY from here to the HTTP
    // response — it is NEVER logged, cached, persisted, or put on any event. The cap event +
    // pii_viewed event are already committed above (audit-before-decrypt).
    const phone = this.pii.decrypt(worker.phoneE164Encrypted);

    // Log the FACT only — opaque ids + reason CODE; NEVER the phone or the note.
    this.logger.log(
      `admin PII reveal admin_id=${adminId.slice(0, 8)}… worker_id=${workerId.slice(0, 8)}… reason=${dto.reason_code}`,
    );

    return { worker_id: workerId, phone };
  }

  /**
   * Emit the PII-FREE `admin.pii_reveal_cap_exceeded` breach (must-fix #8). Subject is the admin
   * session whose velocity tripped the cap; payload is the opaque admin id + which window ONLY —
   * NEVER a worker id, the value, or the note. Emitted in ADDITION to the neutral response.
   */
  private async emitCapExceeded(
    adminId: string,
    window: AdminPiiRevealCapWindow,
    ctx: RequestContext,
  ): Promise<void> {
    this.logger.warn(
      `admin PII reveal cap exceeded admin_id=${adminId.slice(0, 8)}… window=${window} — reveal denied`,
    );
    await this.events.emit({
      event_name: "admin.pii_reveal_cap_exceeded",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "admin_session", subject_id: adminId },
      payload: { admin_id: adminId, window } satisfies PayloadInputOf<"admin.pii_reveal_cap_exceeded">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * The single NEUTRAL non-success shape (Control 7, no-oracle). An unknown worker, an over-cap
   * denial, and a Redis-down fail-closed deny ALL throw THIS — so a caller cannot tell them apart
   * (no enumeration / feature-detection oracle). It is a 404 so it is also indistinguishable from
   * the flag-OFF neutral 404. NOTE: a successful reveal implies existence — that is the authorized,
   * audited action and is expected; the oracle concern is only the DENIED/unknown shapes matching.
   */
  private static neutralNotFound(): HttpException {
    return new NotFoundException("Not found");
  }
}
