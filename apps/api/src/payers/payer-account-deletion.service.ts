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
import { eraseLoginKeyedRows } from "../common/login-keyed-rows";
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
 *   1. revoke EVERY live session for the payer (FIRST side effect, OUTSIDE the transaction — a
 *      deleted-in-progress payer can never be re-authenticated, and Redis is not the database);
 *   2-3. then ONE TRANSACTION (#2811): everything below commits together or not at all, so a
 *      deletion that fails anywhere leaves nothing half-done:
 *   2. resolve the orgs this payer FOUNDED (`payer_orgs.root_payer_id`, RESTRICT): a solo
 *      org (no other linked payer member) is removed with its member rows; an
 *      org with ANY other linked payer member 409s — a test tap must never
 *      destroy a team's shared org;
 *   3. hard-delete the `payers` row. Its side rows go with it (`employer_profiles`,
 *      `agency_profiles`, `payer_capabilities`, `payer_member_invites`: ON DELETE CASCADE since
 *      #2811), and so do the campus-drive requests of the login's own tenant
 *      (`campus_drive_requests.payer_id` ON DELETE CASCADE). For EACH such request the database's
 *      delete trigger leaves one faceless erasure (`campus_drive_request_erasures`: the request id
 *      and a time) in this same transaction, which Campus's drive-request feed serves in `erased`
 *      so Campus deletes its copy of the contact (owners' gate on #2811). Then the login's
 *      `display_prefs` row, which no FK reaches (#2837, `eraseLoginKeyedRows`), then erase the
 *      campus-drive contacts this login ENTERED on the requests that survive (#2746:
 *      `created_by`; under org tenancy `on` a team member's requests belong to the company and
 *      outlive the login: they stay, with `contact: null` in the feed). A delete that fails rolls
 *      the transaction back before the erasure runs, so a refused deletion erases nothing; Billing
 *      rails (`credit_ledger`, `credit_lots` (#2749), `payment_orders`, plans, `unlocks`,
 *      disclosures) are opaque payer_id rails with NO FK to `payers` — they intentionally SURVIVE
 *      (B2: the cost ledger survives account deletion) as PII-free orphans, exactly like the
 *      worker seam's SET-NULL billing posture;
 *   4. after the commit, emit the PII-free `payer.account_deleted` event (opaque id + counts only).
 *
 * IDEMPOTENT: a re-run on an already-gone payer is a clean no-op
 * (`{ deleted: false }` — the controller still answers `{ ok: true }`).
 * PII: the org name / email / phone NEVER enter the event, a log, or any other
 * table — the only retained tokens are the opaque `payer_id` on the surviving
 * billing rails and the opaque request ids of the erasures (faceless by construction).
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

    // 2-3. ONE TRANSACTION (#2811): the solo org, the row (and everything that cascades from it,
    // with one erasure per campus-drive request, written by the database's trigger), the theme row
    // and the drive contacts commit together, or none of them does.
    const soloOrgDeleted = await this.db.transaction(async (tx: unknown) => {
      const executor = tx as Database;

      // 2. Founded orgs: solo → remove; shared → 409 (never destroy a team; the 409 rolls back).
      const owned = await executor
        .select({ id: payerOrgs.id })
        .from(payerOrgs)
        .where(eq(payerOrgs.rootPayerId, payerId));
      let removedSoloOrg = false;
      for (const org of owned) {
        const members = await executor
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
        await executor.delete(payerMembers).where(eq(payerMembers.orgId, org.id));
        await executor.delete(payerOrgs).where(eq(payerOrgs.id, org.id));
        removedSoloOrg = true;
      }

      // 3. The identity removal. Member rows that point AT this payer from other orgs SET NULL
      // (schema posture) — the audit trail survives without the identity. Faceless billing rails
      // have no FK and survive by design. The company record and the other payer side tables
      // cascade (#2811), as do the tenant's own campus-drive requests, each leaving its erasure.
      //
      // #2746 — then, in the SAME transaction, the campus-drive contacts this login typed on
      // requests that outlive it (a team member's, kept by the company). The row delete goes
      // FIRST: a delete that fails (a foreign key still holding the row) aborts the transaction
      // before any contact is touched, and the erasure's `updated_at` stamp lands just before the
      // commit.
      //
      // #2837 — the login's theme row has no FK, so no cascade takes it: deleted here, AFTER the
      // row delete, which waits for a theme PATCH holding the row (`FOR KEY SHARE`), so a choice
      // committed mid-deletion is seen and deleted too.
      await executor.delete(payers).where(eq(payers.id, payerId));
      await eraseLoginKeyedRows(executor, { kind: "payer_user", id: payerId });
      await this.driveContacts.eraseEnteredBy(payerId, executor);
      return removedSoloOrg;
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
