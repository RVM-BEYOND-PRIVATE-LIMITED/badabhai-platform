import { ConflictException, Injectable } from "@nestjs/common";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { CURRENT_PASSWORD_PEPPER_VERSION } from "../common/password-policy";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminRepository } from "./admin.repository";
import { ADMIN_ACTION_CODES } from "./admin-actions.service";
import { emitAdminAccountAction } from "./admin-account-event";
import type { AdminCreateDirectDto } from "./admin-actions.dto";

/**
 * A super_admin creating an admin DIRECTLY (migration 0142, owner ruling 2026-11-03) — the
 * alternative to the invite link, which in production still renders as a `mock://` URL and so
 * cannot onboard anyone on its own.
 *
 * The new admin is born ACTIVE with a TEMPORARY password and `must_change_password = true`: their
 * first password sign-in must set their own before anything else (see AdminPasswordService), and
 * the temporary one never works for more than that. Two-step starts OFF (Amendment 1 — the admin
 * switches it on from their Account page) and nothing is enrolled.
 *
 * Its own small provider rather than a twelfth method on AdminActionsService: it is the one admin
 * action that handles a credential, and keeping the KDF next to the code that needs it keeps it
 * out of the governed-actions service entirely. The route still lives on AdminActionsController
 * so the static every-route-guarded scan covers it with the other `manage_admins` routes.
 */
@Injectable()
export class AdminProvisioningService {
  constructor(
    private readonly admins: AdminRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /**
   * Create the admin + emit `admin_created` (actor = the creating super_admin, target = the new
   * admin) on ONE transaction. 409 when the email already belongs to ANY admin row — value-free,
   * so the response never says whose. Returns the opaque id only.
   */
  async createDirect(
    creatorAdminId: string,
    dto: AdminCreateDirectDto,
    ctx: RequestContext,
  ): Promise<{ admin_id: string }> {
    // Hashed OUTSIDE the transaction: the KDF is deliberately slow, and a DB transaction held
    // open across it buys nothing.
    const password = {
      hash: this.pii.hashPassword(dto.temporary_password),
      pepperVersion: CURRENT_PASSWORD_PEPPER_VERSION,
      setAt: new Date(),
    };
    const created = await this.admins.withTransaction(async (tx) => {
      const row = await this.admins.createActiveWithTemporaryPassword(
        { role: dto.role, email: dto.email, name: dto.name, password },
        tx,
      );
      if (!row) return undefined;
      await emitAdminAccountAction(this.events, {
        actorAdminId: creatorAdminId,
        targetAdminId: row.id,
        actionCode: ADMIN_ACTION_CODES.admin_created,
        ctx,
        tx,
      });
      return row;
    });
    if (!created) throw new ConflictException("An admin with that email already exists");
    return { admin_id: created.id };
  }
}
