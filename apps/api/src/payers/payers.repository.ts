import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type Database, payers, type Payer, type PayerRole, type PayerStatus } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { NameTokenService } from "../admin/candidate-index/name-token.service";

/**
 * The pepper version that produced a row's `password_hash` (#2497). Defined once in
 * `common/password-policy.ts` (shared with the admin password door, migration 0144) and
 * re-exported here so every existing payer import keeps resolving unchanged.
 */
export { CURRENT_PASSWORD_PEPPER_VERSION } from "../common/password-policy";

export type CreatePayerInput = {
  role: PayerRole;
  /** Login email (optional since #2497 — phone-only signup has none). Normalized on write. */
  email?: string;
  phone?: string;
} & (
  | {
      /** Display name in PLAINTEXT; encrypted on write and given the exact-name login hash. */
      orgName: string;
      orgNameEnc?: never;
    }
  | {
      /**
       * #2563 — an ALREADY-ENCRYPTED display name, copied from `payer_orgs.name_enc` when an
       * admin attaches a team member to an existing org. No plaintext exists in that path, so
       * there is nothing to encrypt and no exact-name login hash is written (a team member
       * signs in by email/phone, never by the company name).
       */
      orgNameEnc: string;
      orgName?: never;
    }
);

/**
 * #2563 follow-up — the neutral display name a removed member is reset to. It is deliberately
 * NOT a login identifier, so a row carrying it has no company-name lookup hash.
 */
export const DEFAULT_ORG_NAME = "My Organisation";

/** A payer's decrypted contact details — backend-only, for the payer's OWN view. */
export interface PayerContact {
  id: string;
  role: PayerRole;
  status: Payer["status"];
  /** NULL for phone-only accounts (#2497) — callers must not assume an email. */
  email: string | null;
  orgName: string;
  phone: string | null;
}

/**
 * Data access for `payers` (ADR-0019 Decision B). Payer/employer B2B contact PII is a
 * NEW PII class (B-R2) and is handled with the SAME at-rest discipline as worker PII
 * (ADR-0004): contact fields are written as AES-256-GCM ciphertext via
 * {@link PiiCryptoService}; the login email also carries a keyed HMAC for
 * lookup/dedup. **No raw payer PII is ever returned to a caller that did not ask to
 * decrypt, written to an event, or logged** — `payer_id` is the only token elsewhere.
 */
@Injectable()
export class PayersRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pii: PiiCryptoService,
    // #2564 — company-name search tokens. Optional so every existing `new PayersRepository(db,
    // pii)` keeps compiling and simply writes no tokens (`[]` + NULL kid = not tokenised).
    @Optional() private readonly nameTokens?: NameTokenService,
  ) {}

  /**
   * #2564 — the company-name search tokens for a PLAINTEXT org name: keyed HMACs of each folded
   * word under the `company:` domain. `[]` + NULL kid when the keys are unset (name search is
   * then OFF, fail closed) or for the neutral placeholder a removed member is reset to, which
   * names no company. Written in the SAME statement as `org_name_enc`, so they cannot drift.
   */
  private orgNameTokens(orgName: string): {
    orgNameTokenHashes: string[];
    orgNameTokenKeyId: string | null;
  } {
    if (orgName === DEFAULT_ORG_NAME || !this.nameTokens) {
      return { orgNameTokenHashes: [], orgNameTokenKeyId: null };
    }
    const { hashes, kid } = this.nameTokens.tokenise(orgName, "company");
    return { orgNameTokenHashes: hashes, orgNameTokenKeyId: kid };
  }

  /** Run `work` inside ONE transaction (the caller's atomic boundary for a write + its event). */
  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** Normalize an email for hashing/lookup (case- and whitespace-insensitive). */
  private static normEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Normalize an org display name for the lookup hash (#2497 — exact company-name
   * login is trimmed + case-insensitive). The STORED name keeps its original casing;
   * only the hash input is folded. Unicode-aware `toLowerCase` (locale-insensitive),
   * so "SHARMA TRADING" and "sharma trading" hash identically.
   */
  static normOrgName(orgName: string): string {
    return orgName.trim().toLowerCase();
  }

  /**
   * The two org-name columns for an insert: either encrypt the caller's plaintext and derive
   * the exact-name login hash, or copy an already-encrypted token with no hash (#2563 team
   * member). One helper so the three insert paths cannot drift.
   */
  private orgColumns(input: CreatePayerInput): {
    orgNameEnc: string;
    orgNameLookupHash: string | null;
    orgNameTokenHashes: string[];
    orgNameTokenKeyId: string | null;
  } {
    if (input.orgName !== undefined) {
      return {
        orgNameEnc: this.pii.encrypt(input.orgName),
        orgNameLookupHash: this.pii.hashOrgName(PayersRepository.normOrgName(input.orgName)),
        ...this.orgNameTokens(input.orgName),
      };
    }
    // A team member's copied ciphertext: no plaintext, so no lookup hash and no search tokens —
    // the Companies list finds the org through its ROOT, never through a member's copy.
    return {
      orgNameEnc: input.orgNameEnc,
      orgNameLookupHash: null,
      orgNameTokenHashes: [],
      orgNameTokenKeyId: null,
    };
  }

  /** Create a payer, encrypting all contact PII at rest. Returns the new id only. */
  async create(input: CreatePayerInput, tx?: Database): Promise<{ id: string }> {
    const db = tx ?? this.db;
    const normEmail = input.email ? PayersRepository.normEmail(input.email) : null;
    const [row] = await db
      .insert(payers)
      .values({
        role: input.role,
        emailEnc: normEmail ? this.pii.encrypt(normEmail) : null,
        emailHash: normEmail ? this.pii.hmac(normEmail) : null,
        ...this.orgColumns(input),
        phoneEnc: input.phone ? this.pii.encrypt(input.phone) : null,
        phoneHash: input.phone ? this.pii.hashPhone(input.phone) : null,
      })
      .returning({ id: payers.id });
    return { id: row!.id };
  }

  /**
   * Idempotent, race-safe create-or-get keyed on the payer's contact (#2497: the login
   * email's keyed HMAC when one is supplied, the phone's when the signup is phone-only) —
   * the payer analogue of `WorkersRepository.createOrGetByPhoneHash` (TD23). Two
   * concurrent first-time signups for the same contact both reach here; a plain insert
   * would 23505 on `payers_email_hash_uq`. `created` is true ONLY for the request that
   * actually inserted.
   *
   * EMAIL path is unchanged (unique hash → `ON CONFLICT DO NOTHING`). PHONE has no unique
   * index (historical rows may share a phone), so the phone path serializes on a
   * transaction-scoped advisory lock keyed on the phone hash (the `unlocks`/`posting-plans`
   * pattern) instead: find-inside-the-lock, insert when absent.
   *
   * SECURITY (XB-H no-enumeration): an existing contact returns `{created:false}`
   * WITHOUT a duplicate row, an error, or any overwrite of the stored role/org-name — so
   * signup for a known contact is indistinguishable (same neutral HTTP response, no
   * 500-vs-200 oracle) from signup for a new one. The existing account is never mutated
   * here. At least one of `email`/`phone` is REQUIRED (the DTO guarantees it); neither
   * is a programming error and throws rather than inserting a contactless row.
   */
  async createOrGet(
    input: CreatePayerInput,
    tx?: Database,
  ): Promise<{ id: string; created: boolean }> {
    if (!input.email && !input.phone) {
      throw new Error("payer signup requires at least one of email/phone");
    }
    // Email wins on a both-supplied body (deterministic + preserves the unique-key dedup).
    if (input.email) return this.createOrGetByEmail({ ...input, email: input.email }, tx);
    return this.createOrGetByPhone(input as CreatePayerInput & { phone: string }, tx);
  }

  /** Email-keyed path — the pre-#2497 behaviour, unchanged. */
  private async createOrGetByEmail(
    input: CreatePayerInput & { email: string },
    tx?: Database,
  ): Promise<{ id: string; created: boolean }> {
    const db = tx ?? this.db;
    const normEmail = PayersRepository.normEmail(input.email);
    const emailHash = this.pii.hmac(normEmail);
    const inserted = await db
      .insert(payers)
      .values({
        role: input.role,
        emailEnc: this.pii.encrypt(normEmail),
        emailHash,
        ...this.orgColumns(input),
        phoneEnc: input.phone ? this.pii.encrypt(input.phone) : null,
        phoneHash: input.phone ? this.pii.hashPhone(input.phone) : null,
      })
      .onConflictDoNothing({ target: payers.emailHash })
      .returning({ id: payers.id });
    if (inserted[0]) return { id: inserted[0].id, created: true };

    // Lost the insert race (or the account already existed) — resolve by the keyed hash.
    const [existing] = await db
      .select({ id: payers.id })
      .from(payers)
      .where(eq(payers.emailHash, emailHash))
      .limit(1);
    if (!existing) throw new Error("payer insert hit a conflict but no row was found");
    return { id: existing.id, created: false };
  }

  /**
   * Phone-keyed path (#2497 — phone-only signup). Serialized by an advisory lock on the
   * phone hash so two concurrent same-phone signups cannot both insert: the loser reads
   * the winner's row inside the same lock. The lock is transaction-scoped (released on
   * commit/rollback) and keyed on the opaque hash, never the raw phone.
   */
  private async createOrGetByPhone(
    input: CreatePayerInput & { phone: string },
    tx?: Database,
  ): Promise<{ id: string; created: boolean }> {
    const phoneHash = this.pii.hashPhone(input.phone);
    const work = async (db: Database) => {
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${phoneHash}, 0))`);
      const [existing] = await db
        .select({ id: payers.id })
        .from(payers)
        .where(eq(payers.phoneHash, phoneHash))
        .limit(1);
      if (existing) return { id: existing.id, created: false };
      const [inserted] = await db
        .insert(payers)
        .values({
          role: input.role,
          emailEnc: null,
          emailHash: null,
          ...this.orgColumns(input),
          phoneEnc: this.pii.encrypt(input.phone),
          phoneHash,
        })
        .returning({ id: payers.id });
      if (!inserted) throw new Error("payer insert returned no row");
      return { id: inserted.id, created: true };
    };
    // Inside the caller's transaction, join it rather than opening a second connection: a nested
    // transaction would commit the payer even if the caller later rolled back, and would wait on
    // an advisory lock held by the outer transaction. Alone, open the transaction ourselves.
    return tx
      ? work(tx)
      : this.db.transaction(work as (tx: unknown) => Promise<{ id: string; created: boolean }>);
  }

  /** Fetch the raw row by id (ciphertext fields; decrypt only via {@link decryptContact}). */
  async findById(id: string, tx?: Database): Promise<Payer | undefined> {
    const [row] = await (tx ?? this.db).select().from(payers).where(eq(payers.id, id)).limit(1);
    return row;
  }

  /**
   * The two facts {@link import("./payer-auth.guard").PayerAuthGuard} needs on EVERY
   * request: the vertical-authz `role`, the lifecycle `status` (ADR-0037) and — since #2563 —
   * the credential-epoch watermark `sessions_valid_after`. Formerly two columns; the third is
   * read on the same PK lookup and never widens the projection to contact ciphertext.
   *
   * A NARROW projection on purpose. `findById` above is `select()` — it returns
   * `email_enc`, `phone_enc` and `org_name_enc`, i.e. the full encrypted-PII row. Putting
   * that on the hot path of all 55 payer routes would pull B2B contact ciphertext into
   * guard scope on every single request for three scalar columns. Three columns is what the
   * guard needs, so three columns is what it reads.
   *
   * Deliberately NOT cached in the session blob. `PayerSessionService` writes that blob
   * once at `create()` and `validateAndTouch` only slides the TTL — it never rewrites it —
   * while the TTL itself slides to a fresh 30 days on every request with no absolute
   * ceiling. A status cached there would be stale for the entire (unbounded) life of the
   * session, which is worse than useless: it would LOOK like enforcement.
   *
   * Cost: one PK-index lookup per guarded request — the same order as the per-request read
   * `PayerOrgRoleGuard` already performs on the org routes.
   */
  async findAuthFacts(
    id: string,
  ): Promise<
    | {
        role: PayerRole;
        status: PayerStatus;
        sessionsValidAfter: Date | null;
        mustChangePassword: boolean;
      }
    | undefined
  > {
    const [row] = await this.db
      .select({
        role: payers.role,
        status: payers.status,
        sessionsValidAfter: payers.sessionsValidAfter,
        mustChangePassword: payers.mustChangePassword,
      })
      .from(payers)
      .where(eq(payers.id, id))
      .limit(1);
    return row;
  }

  /**
   * ADR-0037 — promote a payer to `active` on successful OTP verification.
   *
   * `status = 'pending'` is IN THE WHERE CLAUSE, not checked in TS beforehand. That makes
   * it structurally impossible for this to resurrect a `suspended` payer: a suspended row
   * matches no predicate and the update is a no-op, regardless of what the caller believes
   * about the row it read a moment ago. It is also the only first-verify discriminator
   * that exists — `payers` has no `verified_at` or `last_login_at`, and `is_new_payer` is
   * hardcoded `false` on the response.
   *
   * Returns the row ONLY when it actually moved, so the caller emits `payer.activated`
   * exactly once per payer and every subsequent login is a silent no-op.
   */
  async activate(id: string, tx?: Database): Promise<{ id: string } | undefined> {
    const [row] = await (tx ?? this.db)
      .update(payers)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(payers.id, id), eq(payers.status, "pending")))
      .returning({ id: payers.id });
    return row;
  }

  /**
   * Self-edit a payer's OWN contact (PROF-3, `PATCH /payer/me`). Updates ONLY the fields
   * present in `patch` (a partial update): `orgName` re-encrypts the display name, and
   * `phone` re-encrypts the E.164 value AND refreshes `phoneHash` (the keyed lookup key,
   * kept in lockstep with the ciphertext). `updatedAt` is bumped (last-write-wins). The
   * caller-supplied `phone` is the already-validated E.164 string from `PayerUpdateSchema`.
   *
   * `id` is the GUARD principal id only — there is no body-supplied id path, so this can
   * never write another payer's row. An unknown id matches no row and returns `undefined`
   * (the service maps that to a neutral 404 — no existence oracle). Returns the UPDATED row
   * (ciphertext; decrypt via {@link decryptContact}) so the caller re-derives the masked DTO.
   */
  async update(
    id: string,
    patch: { orgName?: string; phone?: string },
    tx?: Database,
  ): Promise<Payer | undefined> {
    const set: Partial<typeof payers.$inferInsert> = { updatedAt: new Date() };
    if (patch.orgName !== undefined) {
      set.orgNameEnc = this.pii.encrypt(patch.orgName);
      // #2497 - the exact-name login key follows the display name (same write, so
      // they can never drift: a renamed payer keeps logging in by the new name).
      set.orgNameLookupHash = this.pii.hashOrgName(PayersRepository.normOrgName(patch.orgName));
      // #2564 - and so do the company-name search tokens.
      Object.assign(set, this.orgNameTokens(patch.orgName));
    }
    if (patch.phone !== undefined) {
      set.phoneEnc = this.pii.encrypt(patch.phone);
      set.phoneHash = this.pii.hashPhone(patch.phone);
    }
    const [row] = await (tx ?? this.db)
      .update(payers)
      .set(set)
      .where(eq(payers.id, id))
      .returning();
    return row;
  }

  /** Look up a payer by login email via the keyed hash (never scans plaintext). */
  async findByEmail(email: string): Promise<Payer | undefined> {
    const hash = this.pii.hmac(PayersRepository.normEmail(email));
    const [row] = await this.db.select().from(payers).where(eq(payers.emailHash, hash)).limit(1);
    return row;
  }

  /**
   * Rows for an E.164 phone via the keyed hash (#2497 — up to 2, newest... in row
   * order). Phone has NO unique index (historical rows may share one), so callers —
   * not this method — decide what multiples mean: the OTP door takes the first match
   * (proving the shared contact), the password door requires exactly one (else
   * neutral 401). `limit(2)` is all any caller needs to tell 0 / 1 / many apart.
   */
  async findByPhone(phone: string): Promise<Payer[]> {
    const hash = this.pii.hashPhone(phone);
    return this.db.select().from(payers).where(eq(payers.phoneHash, hash)).limit(2);
  }

  /**
   * Look up payers by EXACT org display name (#2497 — company-name login). The name is
   * normalized (trim + lowercase) and matched on the keyed HMAC — the raw name is
   * never scanned and never leaves this boundary. `limit(2)`: the caller only ever
   * needs to distinguish 0 / exactly-1 / many (many logs in NOBODY, neutral 401).
   */
  async findByOrgName(orgName: string): Promise<Payer[]> {
    const hash = this.pii.hashOrgName(PayersRepository.normOrgName(orgName));
    return this.db.select().from(payers).where(eq(payers.orgNameLookupHash, hash)).limit(2);
  }

  /**
   * One payer's organisation display name, decrypted — and ONLY that column (least privilege:
   * no email or phone ciphertext is read). `GET /payer/me` reads the TENANT's name with it for a
   * team member (ADR-0053 O-10: a teammate's posting carries the founder's company name), so the
   * caller passes the resolver's tenant key. `undefined` when there is no such payer. A decrypt
   * failure throws (the caller fails closed). Never logged.
   */
  async findOrgName(id: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ orgNameEnc: payers.orgNameEnc })
      .from(payers)
      .where(eq(payers.id, id))
      .limit(1);
    return row ? this.pii.decrypt(row.orgNameEnc) : undefined;
  }

  /** Decrypt a payer's contact PII for their OWN view (backend-only). */
  decryptContact(row: Payer): PayerContact {
    return {
      id: row.id,
      role: row.role,
      status: row.status,
      // #2497 — email is nullable now (phone-only accounts); decrypt only when set.
      email: row.emailEnc ? this.pii.decrypt(row.emailEnc) : null,
      orgName: this.pii.decrypt(row.orgNameEnc),
      phone: row.phoneEnc ? this.pii.decrypt(row.phoneEnc) : null,
    };
  }

  /**
   * Store (or replace) a payer's login password (#2497 — `POST /payer/password/set`).
   * Writes the self-encoded scrypt token + its pepper version + the set timestamp in
   * ONE row write; the raw password never reaches this layer (the service hashes
   * first). Returns the updated row.
   */
  async setPassword(
    id: string,
    password: { hash: string; pepperVersion: number },
    options?: { tx?: Database; sessionsValidAfter?: Date | null },
  ): Promise<Payer | undefined> {
    const [row] = await (options?.tx ?? this.db)
      .update(payers)
      .set({
        passwordHash: password.hash,
        passwordPepperVersion: password.pepperVersion,
        passwordSetAt: new Date(),
        // A new password always clears the temporary-password and revocation state: the
        // credential the payer now holds is their own, and the password door is open again.
        mustChangePassword: false,
        passwordRevokedAt: null,
        ...(options?.sessionsValidAfter !== undefined
          ? { sessionsValidAfter: options.sessionsValidAfter }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(payers.id, id))
      .returning();
    return row;
  }

  /**
   * #2563 — store the payer's own replacement password ONLY if the row still holds the exact
   * temporary credential that was just verified and still requires a change.
   *
   * The conditional WHERE is what makes two concurrent forced-change requests safe: both may
   * verify the same temporary password, but only the first UPDATE matches. The loser gets zero
   * rows and must answer the neutral 401 rather than overwrite the winner's password (which
   * would leave the payer holding a password nobody chose). Clears the temporary/revocation
   * state in the same write.
   */
  async replaceTemporaryPassword(
    id: string,
    password: { hash: string; pepperVersion: number },
    expectedTemporaryHash: string,
    tx?: Database,
  ): Promise<Payer | undefined> {
    const now = new Date();
    const [row] = await (tx ?? this.db)
      .update(payers)
      .set({
        passwordHash: password.hash,
        passwordPepperVersion: password.pepperVersion,
        passwordSetAt: now,
        mustChangePassword: false,
        passwordRevokedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(payers.id, id),
          eq(payers.mustChangePassword, true),
          eq(payers.passwordHash, expectedTemporaryHash),
        ),
      )
      .returning();
    return row;
  }

  /**
   * #2563 — an admin ISSUES a temporary password (create or re-issue). Stores the credential,
   * marks it temporary, clears any revocation, and stamps `sessions_valid_after` so sessions
   * minted before this instant are dead even if the Redis revoke is missed. The caller revokes
   * the live sessions after this transaction commits.
   */
  async setTemporaryPassword(
    id: string,
    password: { hash: string; pepperVersion: number },
    tx?: Database,
  ): Promise<Payer | undefined> {
    const now = new Date();
    const [row] = await (tx ?? this.db)
      .update(payers)
      .set({
        passwordHash: password.hash,
        passwordPepperVersion: password.pepperVersion,
        passwordSetAt: now,
        mustChangePassword: true,
        passwordRevokedAt: null,
        sessionsValidAfter: now,
        updatedAt: now,
      })
      .where(eq(payers.id, id))
      .returning();
    return row;
  }

  /**
   * #2563 — an admin REVOKES password sign-in. The hash stays (so the account's password age
   * and history survive), but `password_revoked_at` closes the door; a later set clears it.
   * The session watermark is stamped for the same reason as issue.
   */
  async revokePassword(id: string, tx?: Database): Promise<Payer | undefined> {
    const now = new Date();
    const [row] = await (tx ?? this.db)
      .update(payers)
      .set({
        passwordRevokedAt: now,
        mustChangePassword: false,
        sessionsValidAfter: now,
        updatedAt: now,
      })
      .where(eq(payers.id, id))
      .returning();
    return row;
  }

  /** #2563 — stamp a successful sign-in (OTP or password). Best-effort by caller contract. */
  async recordLogin(id: string): Promise<void> {
    await this.db
      .update(payers)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(payers.id, id));
  }

  /**
   * #2563 follow-up — replace a payer's display org name and its exact-name login hash in ONE
   * write. Used when a removed team member's row still carries the founder's copied name:
   * after removal they must not keep it (or its lookup hash) into a later solo org.
   *
   * The neutral {@link DEFAULT_ORG_NAME} is a display fallback, not a login identifier, so it
   * writes a NULL lookup hash in the same statement. That keeps "My Organisation" rows out of
   * the company-name sign-in lookup and makes the reset atomic.
   */
  async setOrgName(id: string, orgName: string): Promise<void> {
    await this.db
      .update(payers)
      .set({
        orgNameEnc: this.pii.encrypt(orgName),
        orgNameLookupHash:
          orgName === DEFAULT_ORG_NAME
            ? null
            : this.pii.hashOrgName(PayersRepository.normOrgName(orgName)),
        // #2564 - tokens follow the name (none for the neutral placeholder).
        ...this.orgNameTokens(orgName),
        updatedAt: new Date(),
      })
      .where(eq(payers.id, id));
  }

  /**
   * #2563 follow-up — clear a stale company-name login hash. A removed member must never keep
   * the founder's hash: `findByOrgName` would otherwise return both rows and the founder's
   * company-name sign-in would resolve to NOBODY.
   */
  async clearOrgLookupHash(id: string): Promise<void> {
    await this.db
      .update(payers)
      .set({ orgNameLookupHash: null, updatedAt: new Date() })
      .where(eq(payers.id, id));
  }

  /**
   * Lazily fill `org_name_lookup_hash` for rows created before #2497 (#2497 — the
   * HMAC key lives server-side, so no SQL backfill can compute it). Called on the
   * next successful login; the `WHERE ... IS NULL` guard makes concurrent logins
   * converge on one write and makes this a no-op for rows that already have a hash.
   * Best-effort by contract: the caller never fails a login on this write.
   */
  async ensureOrgLookupHash(row: Payer): Promise<void> {
    if (row.orgNameLookupHash) return;
    const hash = this.pii.hashOrgName(
      PayersRepository.normOrgName(this.pii.decrypt(row.orgNameEnc)),
    );
    await this.db
      .update(payers)
      .set({ orgNameLookupHash: hash, updatedAt: new Date() })
      .where(and(eq(payers.id, row.id), isNull(payers.orgNameLookupHash)));
  }
}
