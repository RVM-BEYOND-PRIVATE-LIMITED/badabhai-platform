import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
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
  /**
   * Keyed HMAC of the single-use accept token. The RAW token is never passed here — the
   * service hashes it before the write, so the plaintext bearer secret has no path into the
   * data layer at all.
   */
  inviteTokenHash: string;
  inviteExpiresAt: Date;
}

/**
 * A password write (migration 0144). The RAW password never reaches this layer — the service
 * hashes first, exactly as the payer door does (#2497).
 */
export interface AdminPasswordWrite {
  /** The self-encoded scrypt token from `PiiCryptoService.hashPassword`. */
  hash: string;
  pepperVersion: number;
  /**
   * When it was set. Also the SESSION cut-off (`AdminSessionService` rejects a JWT whose `iat`
   * predates it), so it is passed in from the caller's clock rather than read from the DB's —
   * the session the caller mints next is then guaranteed to land on or after it.
   */
  setAt: Date;
}

/** A super_admin creating an ACTIVE admin directly with a temporary password (0144). */
export interface CreateActiveAdminInput {
  role: AdminRole;
  email: string;
  /** Display name — encrypted at rest here, like the email (ADR-0004). */
  name: string;
  password: AdminPasswordWrite;
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
   * Count the currently-ACTIVE super_admins (L1 last-super_admin lockout guard). Used to reject
   * a suspend/demote that would leave ZERO active super_admins (an org-wide `manage_admins`
   * lockout). Value-free: a count only, no PII.
   */
  async countActiveSuperAdmins(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(adminUsers)
      .where(and(eq(adminUsers.role, "super_admin"), eq(adminUsers.status, "active")));
    return row?.n ?? 0;
  }

  /**
   * Create an admin (invite), or return undefined when the email is already registered.
   * `status` defaults to `'pending'` at the DB (ADR-0025 OQ-2, invite-then-activate) — a
   * created-but-unactivated admin authenticates to NOTHING. Encrypts the email at rest + stores
   * its keyed hash. Returns the new id only (never the email).
   *
   * `ON CONFLICT (email_hash) DO NOTHING`, not a caught 23505 (#1811): the invite runs inside a
   * transaction, and a raised unique violation aborts it — the caller's follow-up
   * `refreshInvite` on the same `tx` would then fail with 25P02 instead of refreshing.
   */
  async createUnlessEmailTaken(
    input: CreateAdminInput,
    tx: Database = this.db,
  ): Promise<{ id: string } | undefined> {
    const normEmail = AdminRepository.normEmail(input.email);
    const [row] = await tx
      .insert(adminUsers)
      .values({
        role: input.role,
        emailEnc: this.pii.encrypt(normEmail),
        emailHash: this.pii.hmac(normEmail),
        // status omitted → DB default 'pending' (invite-then-activate).
        inviteTokenHash: input.inviteTokenHash,
        inviteExpiresAt: input.inviteExpiresAt,
      })
      .onConflictDoNothing({ target: adminUsers.emailHash })
      .returning({ id: adminUsers.id });
    return row;
  }

  /**
   * Re-invite an admin who is still `pending` — refresh the accept token + expiry in place.
   *
   * Guarded on `status = 'pending'`, so it matches NO row for an already-active or suspended
   * admin and returns undefined; the service maps that to the same 409 a duplicate email
   * gets. That guard is the whole point: without it, a super_admin could mint a fresh accept
   * link for an ACTIVE admin's email and hand themselves a way to re-enrol that account's
   * second factor. Re-inviting a pending admin is legitimate (the first link expired or never
   * arrived); "re-inviting" an active one is an account takeover.
   */
  async refreshInvite(
    emailHash: string,
    input: { role: AdminRole; inviteTokenHash: string; inviteExpiresAt: Date },
    tx: Database = this.db,
  ): Promise<{ id: string } | undefined> {
    const [row] = await tx
      .update(adminUsers)
      .set({
        role: input.role,
        inviteTokenHash: input.inviteTokenHash,
        inviteExpiresAt: input.inviteExpiresAt,
        updatedAt: new Date(),
      })
      .where(and(eq(adminUsers.emailHash, emailHash), eq(adminUsers.status, "pending")))
      .returning({ id: adminUsers.id });
    return row;
  }

  /**
   * Resolve a PENDING invite by its token HASH (never the raw token), rejecting an expired
   * one in the same predicate so an expired link is indistinguishable from an unknown one —
   * the caller has a single `undefined` branch and cannot accidentally build an oracle that
   * says "this token existed but lapsed".
   *
   * `now` is passed in rather than read from the clock here so the expiry boundary is
   * testable without faking time globally.
   */
  async findByInviteTokenHash(
    inviteTokenHash: string,
    now: Date,
    tx: Database = this.db,
  ): Promise<AdminUser | undefined> {
    const [row] = await tx
      .select()
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.inviteTokenHash, inviteTokenHash),
          eq(adminUsers.status, "pending"),
          // `gt`, not a raw sql`` template: the template interpolates a JS Date through
          // toString() ("Fri Sep 11 2026 … (India Standard Time)"), which Postgres rejects
          // for a timestamptz. The operator routes the value through the column's own type
          // mapper instead.
          gt(adminUsers.inviteExpiresAt, now),
        ),
      );
    return row;
  }

  /**
   * ACCEPT an invite: `pending` → `active`, consuming the token in the SAME statement.
   *
   * The token hash is matched in the WHERE clause and nulled in the SET, which makes the
   * accept atomically single-use: two concurrent requests presenting the same link both run
   * this UPDATE, but only one matches a row — the loser sees `undefined` and gets the same
   * no-oracle 404 an unknown token gets. Doing it as a read-then-write would leave exactly
   * that race open, and the thing being raced for is admin access.
   *
   * The expiry is re-checked here and not merely in {@link findByInviteTokenHash}, so this
   * method is safe on its own terms rather than only in the order the service happens to
   * call it.
   */
  async acceptInvite(
    inviteTokenHash: string,
    now: Date,
    tx: Database = this.db,
  ): Promise<AdminUser | undefined> {
    const [row] = await tx
      .update(adminUsers)
      .set({
        status: "active" satisfies AdminStatus,
        inviteTokenHash: null,
        inviteExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(adminUsers.inviteTokenHash, inviteTokenHash),
          eq(adminUsers.status, "pending"),
          // See findByInviteTokenHash: `gt` so the Date is bound as a real timestamptz.
          gt(adminUsers.inviteExpiresAt, now),
        ),
      )
      .returning();
    return row;
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
  async setMfaEnrolled(
    id: string,
    enrolled: boolean,
    tx: Database = this.db,
  ): Promise<AdminUser | undefined> {
    const [row] = await tx
      .update(adminUsers)
      .set({ mfaEnrolled: enrolled, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    return row;
  }

  /**
   * ADR-0038 — persist the admin's TOTP seed CIPHERTEXT. Encryption stays in
   * {@link import("./admin-mfa.store").AdminMfaSecretStore}; this method only stores the
   * token it is handed, so the repository never sees a plaintext seed.
   */
  async setMfaSecret(id: string, secretEnc: string | null, tx: Database = this.db): Promise<void> {
    await tx
      .update(adminUsers)
      .set({ mfaSecretEnc: secretEnc, updatedAt: new Date() })
      .where(eq(adminUsers.id, id));
  }

  /**
   * ADR-0038 — read the TOTP seed CIPHERTEXT. A NARROW projection: `findById` returns the
   * whole row including `email_enc`, and the second factor has no business pulling the
   * admin's contact ciphertext into scope on every MFA verify.
   */
  async findMfaSecret(id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ mfaSecretEnc: adminUsers.mfaSecretEnc })
      .from(adminUsers)
      .where(eq(adminUsers.id, id))
      .limit(1);
    return row?.mfaSecretEnc ?? null;
  }

  // ---------------------------------------------------------------------------
  // Migration 0144 — password sign-in + the per-admin two-step switch. Every write takes a
  // HASH or a CIPHERTEXT, never a raw password or TOTP seed; every guard lives in the WHERE so
  // a concurrent change is a no-op (undefined / false), never a silent overwrite.
  // ---------------------------------------------------------------------------

  /**
   * Create an ACTIVE admin with a temporary password (`POST /admin/admins/direct`), or return
   * undefined when the email already belongs to ANY admin row (pending, active or suspended) —
   * `ON CONFLICT (email_hash) DO NOTHING`, for the same #1811 reason as the invite insert: a
   * raised 23505 would abort the caller's transaction. Born `must_change_password = true` with
   * no second factor (`mfa_enrolled`/`mfa_enabled` false). Returns the new id only.
   */
  async createActiveWithTemporaryPassword(
    input: CreateActiveAdminInput,
    tx: Database = this.db,
  ): Promise<{ id: string } | undefined> {
    const normEmail = AdminRepository.normEmail(input.email);
    const [row] = await tx
      .insert(adminUsers)
      .values({
        role: input.role,
        status: "active" satisfies AdminStatus,
        emailEnc: this.pii.encrypt(normEmail),
        emailHash: this.pii.hmac(normEmail),
        nameEnc: this.pii.encrypt(input.name),
        passwordHash: input.password.hash,
        passwordPepperVersion: input.password.pepperVersion,
        passwordSetAt: input.password.setAt,
        mustChangePassword: true,
        mfaEnrolled: false,
        mfaEnabled: false,
      })
      .onConflictDoNothing({ target: adminUsers.emailHash })
      .returning({ id: adminUsers.id });
    return row;
  }

  /**
   * Store (or replace) an ACTIVE admin's password and clear `must_change_password`. Guarded on
   * `status = 'active'` so a suspended or pending admin can never be given a password by any
   * path (a reset racing a suspension loses). Returns the updated row, or undefined when the
   * guard matched nothing.
   */
  async setPassword(
    id: string,
    password: AdminPasswordWrite,
    tx: Database = this.db,
  ): Promise<AdminUser | undefined> {
    const [row] = await tx
      .update(adminUsers)
      .set({
        passwordHash: password.hash,
        passwordPepperVersion: password.pepperVersion,
        passwordSetAt: password.setAt,
        mustChangePassword: false,
        updatedAt: password.setAt,
      })
      .where(and(eq(adminUsers.id, id), eq(adminUsers.status, "active")))
      .returning();
    return row;
  }

  /**
   * Stage a FRESH TOTP seed for an admin switching two-step ON (`POST /admin/me/mfa/enable`):
   * the ciphertext replaces any previous seed and `mfa_enrolled` drops to false until the
   * confirm step proves the authenticator works. Guarded on `mfa_enabled = false` — an admin
   * whose two-step is ON cannot have their live seed swapped from a session alone.
   */
  async stageMfaEnrolment(id: string, secretEnc: string, tx: Database = this.db): Promise<boolean> {
    const rows = await tx
      .update(adminUsers)
      .set({ mfaSecretEnc: secretEnc, mfaEnrolled: false, updatedAt: new Date() })
      .where(and(eq(adminUsers.id, id), eq(adminUsers.mfaEnabled, false)))
      .returning({ id: adminUsers.id });
    return rows.length > 0;
  }

  /**
   * Switch two-step ON after a confirmed code: `mfa_enrolled` + `mfa_enabled` together, in one
   * statement. Guarded on a staged seed being present and two-step being OFF, so a double
   * confirm is a no-op rather than a second event.
   */
  async enableMfa(id: string, tx: Database = this.db): Promise<boolean> {
    const rows = await tx
      .update(adminUsers)
      .set({ mfaEnrolled: true, mfaEnabled: true, updatedAt: new Date() })
      .where(
        and(
          eq(adminUsers.id, id),
          eq(adminUsers.mfaEnabled, false),
          isNotNull(adminUsers.mfaSecretEnc),
        ),
      )
      .returning({ id: adminUsers.id });
    return rows.length > 0;
  }

  /**
   * Switch two-step OFF: enabled, enrolled AND the seed go together, so re-enabling always shows
   * a new QR and every trusted device (fingerprinted on the seed ciphertext) dies with it.
   * Guarded on `mfa_enabled = true` (a double disable is a no-op).
   */
  async disableMfa(id: string, tx: Database = this.db): Promise<boolean> {
    const rows = await tx
      .update(adminUsers)
      .set({ mfaEnabled: false, mfaEnrolled: false, mfaSecretEnc: null, updatedAt: new Date() })
      .where(and(eq(adminUsers.id, id), eq(adminUsers.mfaEnabled, true)))
      .returning({ id: adminUsers.id });
    return rows.length > 0;
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
   * Run `cb` inside one Drizzle transaction — the actions service uses this to commit the
   * admin_users SoR write + its `admin.action_performed` event atomically (must-fix H3).
   */
  withTransaction<T>(cb: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(cb as (tx: unknown) => Promise<T>);
  }

  /**
   * Change an admin's RBAC role. Returns the updated raw row (ciphertext email — never
   * decrypted) or undefined when no row matched the id. The new role is an enum CODE; it is
   * recorded on THIS row (the system-of-record), never in the emitted event payload.
   *
   * SAME-ROLE NO-OP (L2): guarded on `role != newRole` so a role X→X PATCH matches NO row →
   * undefined (the service suppresses the bump + the event, mirroring the other terminal no-ops).
   * `tx` runs the write on a caller transaction (H3) so it commits with the event atomically.
   */
  async updateRole(id: string, role: AdminRole, tx: Database = this.db): Promise<AdminUser | undefined> {
    const [row] = await tx
      .update(adminUsers)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(adminUsers.id, id), ne(adminUsers.role, role)))
      .returning();
    return row;
  }

  /**
   * Suspend an admin (→ status 'suspended'). IDEMPOTENT + terminal: guarded on the current
   * status NOT already 'suspended', so a re-invoke matches no row and returns undefined — the
   * service treats that as an idempotent no-op (no duplicate event). A suspended admin
   * authenticates to NOTHING (only 'active' may auth). `tx` runs the write on a caller
   * transaction (H3) so it commits with the event atomically.
   */
  async suspend(id: string, tx: Database = this.db): Promise<AdminUser | undefined> {
    const [row] = await tx
      .update(adminUsers)
      .set({ status: "suspended" satisfies AdminStatus, updatedAt: new Date() })
      .where(and(eq(adminUsers.id, id), ne(adminUsers.status, "suspended")))
      .returning();
    return row;
  }
}
