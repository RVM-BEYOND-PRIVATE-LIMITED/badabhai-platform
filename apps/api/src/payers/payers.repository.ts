import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  payers,
  type Payer,
  type PayerRole,
  type PayerStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { PiiCryptoService } from "../common/pii-crypto.service";

export interface CreatePayerInput {
  role: PayerRole;
  email: string;
  orgName: string;
  phone?: string;
}

/** A payer's decrypted contact details — backend-only, for the payer's OWN view. */
export interface PayerContact {
  id: string;
  role: PayerRole;
  status: Payer["status"];
  email: string;
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
  ) {}

  /** Normalize an email for hashing/lookup (case- and whitespace-insensitive). */
  private static normEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Create a payer, encrypting all contact PII at rest. Returns the new id only. */
  async create(input: CreatePayerInput): Promise<{ id: string }> {
    const normEmail = PayersRepository.normEmail(input.email);
    const [row] = await this.db
      .insert(payers)
      .values({
        role: input.role,
        emailEnc: this.pii.encrypt(normEmail),
        emailHash: this.pii.hmac(normEmail),
        orgNameEnc: this.pii.encrypt(input.orgName),
        phoneEnc: input.phone ? this.pii.encrypt(input.phone) : null,
        phoneHash: input.phone ? this.pii.hashPhone(input.phone) : null,
      })
      .returning({ id: payers.id });
    return { id: row!.id };
  }

  /**
   * Idempotent, race-safe create-or-get keyed on the login email's keyed HMAC — the
   * payer analogue of `WorkersRepository.createOrGetByPhoneHash` (TD23). Two concurrent
   * first-time signups for the same email both reach here; a plain insert would 23505 on
   * `payers_email_hash_uq`. `created` is true ONLY for the request that actually inserted.
   *
   * SECURITY (XB-H no-enumeration): an existing email returns `{created:false}` WITHOUT
   * a duplicate row, an error, or any overwrite of the stored role/org-name — so signup
   * for a known email is indistinguishable (same neutral HTTP response, no 500-vs-200
   * oracle) from signup for a new one. The existing account is never mutated here.
   */
  async createOrGet(input: CreatePayerInput): Promise<{ id: string; created: boolean }> {
    const normEmail = PayersRepository.normEmail(input.email);
    const emailHash = this.pii.hmac(normEmail);
    const inserted = await this.db
      .insert(payers)
      .values({
        role: input.role,
        emailEnc: this.pii.encrypt(normEmail),
        emailHash,
        orgNameEnc: this.pii.encrypt(input.orgName),
        phoneEnc: input.phone ? this.pii.encrypt(input.phone) : null,
        phoneHash: input.phone ? this.pii.hashPhone(input.phone) : null,
      })
      .onConflictDoNothing({ target: payers.emailHash })
      .returning({ id: payers.id });
    if (inserted[0]) return { id: inserted[0].id, created: true };

    // Lost the insert race (or the account already existed) — resolve by the keyed hash.
    const [existing] = await this.db
      .select({ id: payers.id })
      .from(payers)
      .where(eq(payers.emailHash, emailHash))
      .limit(1);
    if (!existing) throw new Error("payer insert hit a conflict but no row was found");
    return { id: existing.id, created: false };
  }

  /** Fetch the raw row by id (ciphertext fields; decrypt only via {@link decryptContact}). */
  async findById(id: string): Promise<Payer | undefined> {
    const [row] = await this.db.select().from(payers).where(eq(payers.id, id)).limit(1);
    return row;
  }

  /**
   * The two facts {@link import("./payer-auth.guard").PayerAuthGuard} needs on EVERY
   * request: the vertical-authz `role` and the lifecycle `status` (ADR-0037).
   *
   * A NARROW projection on purpose. `findById` above is `select()` — it returns
   * `email_enc`, `phone_enc` and `org_name_enc`, i.e. the full encrypted-PII row. Putting
   * that on the hot path of all 55 payer routes would pull B2B contact ciphertext into
   * guard scope on every single request for two scalar columns. Two columns is what the
   * guard needs, so two columns is what it reads.
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
  async findAuthFacts(id: string): Promise<{ role: PayerRole; status: PayerStatus } | undefined> {
    const [row] = await this.db
      .select({ role: payers.role, status: payers.status })
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
  async activate(id: string): Promise<{ id: string } | undefined> {
    const [row] = await this.db
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
  ): Promise<Payer | undefined> {
    const set: Partial<typeof payers.$inferInsert> = { updatedAt: new Date() };
    if (patch.orgName !== undefined) set.orgNameEnc = this.pii.encrypt(patch.orgName);
    if (patch.phone !== undefined) {
      set.phoneEnc = this.pii.encrypt(patch.phone);
      set.phoneHash = this.pii.hashPhone(patch.phone);
    }
    const [row] = await this.db
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

  /** Decrypt a payer's contact PII for their OWN view (backend-only). */
  decryptContact(row: Payer): PayerContact {
    return {
      id: row.id,
      role: row.role,
      status: row.status,
      email: this.pii.decrypt(row.emailEnc),
      orgName: this.pii.decrypt(row.orgNameEnc),
      phone: row.phoneEnc ? this.pii.decrypt(row.phoneEnc) : null,
    };
  }
}
