import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import {
  type Database,
  adminUsers,
  type AdminUser,
  type AdminRole,
  type AdminStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";

export interface CreateAdminInput {
  role: AdminRole;
  email: string;
}

/**
 * Data access for `admin_users` (ADR-0025 ADMIN-1 — the 4th privileged principal).
 *
 * The admin's OWN login email is ADMIN-class PII, handled with the SAME at-rest discipline
 * as worker/payer PII (ADR-0004): it is written as AES-256-GCM ciphertext via
 * {@link PiiCryptoService} (`email_enc`) plus a keyed HMAC (`email_hash`) for login
 * lookup/dedup. **The decrypted email is NEVER selected into a log, an event, or a return
 * value in ADMIN-1** — there is deliberately no `decryptEmail`/`decryptContact` method on
 * this repository, because no ADMIN-1 code path needs the plaintext admin email. The opaque
 * `admin_users.id` is the only admin token that leaves this boundary.
 *
 * SPINE READ-ONLY (ADR-0025 Decision 5 / must-fix #3): this repository touches ONLY
 * `admin_users` — it has no method that selects, updates, or deletes the `events` table.
 * Admin events are emitted exclusively through {@link import("../events/events.service").EventsService}.
 */
@Injectable()
export class AdminRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pii: PiiCryptoService,
  ) {}

  /** Normalize an email for hashing/lookup (case- and whitespace-insensitive). */
  private static normEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Keyed HMAC of a (normalized) login email — the `admin_users.email_hash` lookup key. */
  emailHash(email: string): string {
    return this.pii.hmac(AdminRepository.normEmail(email));
  }

  /**
   * Look up an admin by login email via the keyed hash (never scans plaintext, never
   * decrypts). Returns the raw row (ciphertext email) or undefined.
   */
  async findByEmailHash(emailHash: string): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.emailHash, emailHash))
      .limit(1);
    return row;
  }

  /** Fetch the raw row by id (ciphertext email; never decrypted in ADMIN-1). */
  async findById(id: string): Promise<AdminUser | undefined> {
    const [row] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
    return row;
  }

  /**
   * Create an admin (invite). `status` defaults to `'pending'` at the DB (ADR-0025 OQ-2,
   * invite-then-activate) — a created-but-unactivated admin authenticates to NOTHING.
   * Encrypts the email at rest + stores its keyed hash. Returns the new id only (never the
   * email). Idempotent enough for callers: a duplicate email 23505s on `admin_users_email_hash_uq`.
   */
  async create(input: CreateAdminInput): Promise<{ id: string }> {
    const normEmail = AdminRepository.normEmail(input.email);
    const [row] = await this.db
      .insert(adminUsers)
      .values({
        role: input.role,
        emailEnc: this.pii.encrypt(normEmail),
        emailHash: this.pii.hmac(normEmail),
        // status omitted → DB default 'pending' (invite-then-activate).
      })
      .returning({ id: adminUsers.id });
    return { id: row!.id };
  }

  /** Activate an invited admin (pending → active). Returns the updated row or undefined. */
  async markActive(id: string): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .update(adminUsers)
      .set({ status: "active" satisfies AdminStatus, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    return row;
  }

  /** Flip the MFA-enrolled flag (after a successful TOTP enrollment). */
  async setMfaEnrolled(id: string, enrolled: boolean): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .update(adminUsers)
      .set({ mfaEnrolled: enrolled, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    return row;
  }

  /** Stamp last_login_at (observability only). Best-effort — never blocks a login. */
  async touchLastLogin(id: string): Promise<void> {
    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(adminUsers.id, id));
  }

  // ---------------------------------------------------------------------------
  // ADMIN-3a governed admin_users management (ADR-0025 Decision 3 — `manage_admins`,
  // super_admin only). The role/status are enum CODES pinned at the DB (the role/status
  // CHECKs); no PII is read or written here. The decrypted email never appears.
  // ---------------------------------------------------------------------------

  /**
   * Change an admin's RBAC role. Returns the updated raw row (ciphertext email — never
   * decrypted) or undefined when no row matched the id. The new role is an enum CODE; it is
   * recorded on THIS row (the system-of-record), never in the emitted event payload.
   */
  async updateRole(id: string, role: AdminRole): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .update(adminUsers)
      .set({ role, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    return row;
  }

  /**
   * Suspend an admin (→ status 'suspended'). IDEMPOTENT + terminal: guarded on the current
   * status NOT already 'suspended', so a re-invoke matches no row and returns undefined — the
   * service treats that as an idempotent no-op (no duplicate event). A suspended admin
   * authenticates to NOTHING (only 'active' may auth).
   */
  async suspend(id: string): Promise<AdminUser | undefined> {
    const [row] = await this.db
      .update(adminUsers)
      .set({ status: "suspended" satisfies AdminStatus, updatedAt: new Date() })
      .where(and(eq(adminUsers.id, id), ne(adminUsers.status, "suspended")))
      .returning();
    return row;
  }
}
