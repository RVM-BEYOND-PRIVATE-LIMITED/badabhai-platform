import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  type Database,
  payers,
  payerMembers,
  payerOrgs,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { CampusDriveContactErasureRepository } from "../campus-drives/campus-drive-contact-erasure.repository";
import { PayersRepository } from "./payers.repository";
import { PayerSessionService } from "./payer-session.service";

/**
 * QA-only immediate payer erasure behind `POST /payer/me/delete/immediate`
 * (the payer mirror of the worker `AccountDeletionService.execute` seam).
 *
 * Order (mirrors the worker seam: revoke FIRST, then erase):
 *   1. revoke EVERY live session for the payer (FIRST side effect — a
 *      deleted-in-progress payer can never be re-authenticated);
 *   2. resolve the orgs this payer FOUNDED (`payer_orgs.root_payer_id`): a solo
 *      org (no other linked payer member) is removed with its member rows; an
 *      org with ANY other linked payer member 409s — a test tap must never
 *      destroy a team's shared org;
 *   3. in ONE transaction: erase the campus-drive contacts this login ENTERED (#2746:
 *      `created_by`; under org tenancy `on` a team member's requests belong to the company and
 *      outlive the login), then hard-delete the `payers` row; the requests of the login's own
 *      tenant go with it (`campus_drive_requests.payer_id` ON DELETE CASCADE). A delete that fails
 *      rolls the erasure back with it, so a refused deletion erases nothing; Billing rails (`credit_ledger`,
 *      `payment_orders`, plans, `unlocks`, disclosures) are opaque payer_id
 *      rails with NO FK to `payers` — they intentionally SURVIVE (B2: the cost
 *      ledger survives account deletion) as PII-free orphans, exactly like the
 *      worker seam's SET-NULL billing posture;
 *   4. emit the PII-free `payer.account_deleted` event (opaque id + counts only).
 *
 * IDEMPOTENT: a re-run on an already-gone payer is a clean no-op
 * (`{ deleted: false }` — the controller still answers `{ ok: true }`).
 * PII: the org name / email / phone NEVER enter the event, a log, or any other
 * table — the only retained token is the opaque `payer_id` on the surviving
 * billing rails (faceless by construction).
 */
@Injectable()
export class PayerAccountDeletionService {
  private readonly logger = new Logger(PayerAccountDeletionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly payersRepo: PayersRepository,
    private readonly sessions: PayerSessionService,
    private readonly events: EventsService,
    private readonly driveContacts: CampusDriveContactErasureRepository,
  ) {}

  async execute(
    payerId: string,
    ctx: RequestContext,
  ): Promise<{ deleted: boolean; sessionsRevoked: number; soloOrgDeleted: boolean }> {
    const row = await this.payersRepo.findById(payerId);
    if (!row) return { deleted: false, sessionsRevoked: 0, soloOrgDeleted: false };

    // 1. Revoke FIRST — THROWS on Redis failure (fail closed, like the
    // suspension path): a deletion that reports success with live sessions is
    // worse than a 500 the caller retries.
    const sessionsRevoked = await this.sessions.revokeAllForPayer(payerId);

    // 2. Founded orgs: solo → remove; shared → 409 (never destroy a team).
    const owned = await this.db
      .select({ id: payerOrgs.id })
      .from(payerOrgs)
      .where(eq(payerOrgs.rootPayerId, payerId));
    let soloOrgDeleted = false;
    for (const org of owned) {
      const members = await this.db
        .select({
          memberPayerId: payerMembers.memberPayerId,
          status: payerMembers.status,
        })
        .from(payerMembers)
        .where(eq(payerMembers.orgId, org.id));
      const foreign = members.filter(
        (m) =>
          m.memberPayerId !== null &&
          m.memberPayerId !== payerId &&
          (m.status === "active" || m.status === "invited"),
      );
      if (foreign.length > 0) {
        throw new ConflictException(
          "This account owns a shared organisation — remove or transfer it first",
        );
      }
      await this.db.delete(payerMembers).where(eq(payerMembers.orgId, org.id));
      await this.db.delete(payerOrgs).where(eq(payerOrgs.id, org.id));
      soloOrgDeleted = true;
    }

    // 3. The atomic identity removal. Member rows that point AT this payer from
    // other orgs SET NULL (schema posture) — the audit trail survives without
    // the identity. Faceless billing rails have no FK and survive by design.
    //
    // #2746 — with it, in the SAME transaction, the campus-drive contacts this login typed on
    // requests that outlive it (a team member's, kept by the company). The erasure commits only
    // if the row delete does: a delete that fails (a foreign key still holding the row) rolls it
    // back, and the login is left exactly as it was, to retry.
    await this.db.transaction(async (tx: unknown) => {
      const executor = tx as Database;
      await this.driveContacts.eraseEnteredBy(payerId, executor);
      await executor.delete(payers).where(eq(payers.id, payerId));
    });

    // 4. Durable PII-free record — the payer row itself is gone.
    await this.events.emit({
      event_name: "payer.account_deleted",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload: { payer_id: payerId, sessions_revoked: sessionsRevoked, solo_org_deleted: soloOrgDeleted },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Box-local marker (8-char prefix only — never contact PII). `warn` because
    // on any box where this runs, someone armed irreversible deletion.
    this.logger.warn(
      `QA immediate delete payer=${payerId.slice(0, 8)} (sessions revoked, row removed, solo_org_deleted=${soloOrgDeleted})`,
    );

    return { deleted: true, sessionsRevoked, soloOrgDeleted };
  }
}
