import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { type Database, payers, type Payer, type PayerRole } from "@badabhai/db";
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
