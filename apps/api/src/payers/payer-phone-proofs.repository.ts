import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  type Database,
  type Payer,
  type PayerPhoneProofMethod,
  payerPhoneProofs,
  payers,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { PG_UNIQUE_VIOLATION, sqlStateOf } from "../common/db-error";

/** Postgres `undefined_table`: `payer_phone_proofs` is not there yet (a deploy ahead of it). */
export const PG_UNDEFINED_TABLE = "42P01";

/** The ONE-ACCOUNT-PER-PROVEN-PHONE index (`payer_phone_proofs_phone_hash_uq`). */
export const PHONE_PROOF_PHONE_UNIQUE = "payer_phone_proofs_phone_hash_uq";

/** True when `err` is the proof table missing (42P01), wrapped by drizzle or not. */
export function isPhoneProofTableMissing(err: unknown): boolean {
  return sqlStateOf(err) === PG_UNDEFINED_TABLE;
}

/**
 * True when `err` is the unique index refusing a proof because ANOTHER account already holds the
 * proof of that phone. Matched on the constraint NAME, not only the SQLSTATE: inside the proof
 * transaction the event insert has its own unique index, and its 23505 must not read as this one.
 */
export function isPhoneProvenElsewhere(err: unknown): boolean {
  if (sqlStateOf(err) !== PG_UNIQUE_VIOLATION) return false;
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const c = candidate as { constraint_name?: unknown; constraint?: unknown } | null | undefined;
    const name = c?.constraint_name ?? c?.constraint;
    if (name === PHONE_PROOF_PHONE_UNIQUE) return true;
  }
  return false;
}

/**
 * #2754 item 3 — DROP A PROOF THAT NO LONGER NAMES THE ACCOUNT'S PHONE, in the caller's
 * transaction: the ONE helper every write of `payers.phone_hash` runs after it
 * ({@link import("./payers.repository").PayersRepository.updateContact}). A proof whose hash
 * still equals `currentPhoneHash` (the same number saved again) is kept; any other is deleted, so
 * a new number starts unproven. `null` (no phone at all) drops whatever proof there is.
 *
 * IN A SAVEPOINT (`executor.transaction` on a transaction is a savepoint in drizzle). Before the
 * migration is applied the table does not exist; a bare DELETE would then abort the caller's whole
 * transaction (and with it a legitimate phone change). The savepoint rolls back alone, and 42P01
 * is swallowed: with no table there is no proof to drop. Any other error propagates.
 *
 * Returns how many proofs were dropped (0 or 1).
 */
export async function dropStalePhoneProof(
  executor: Database,
  payerId: string,
  currentPhoneHash: string | null,
): Promise<number> {
  try {
    return await executor.transaction(async (savepoint) => {
      const dropped = await savepoint
        .delete(payerPhoneProofs)
        .where(
          and(
            eq(payerPhoneProofs.payerId, payerId),
            currentPhoneHash === null
              ? undefined
              : ne(payerPhoneProofs.phoneHash, currentPhoneHash),
          ),
        )
        .returning({ payerId: payerPhoneProofs.payerId });
      return dropped.length;
    });
  } catch (err) {
    if (isPhoneProofTableMissing(err)) return 0;
    throw err;
  }
}

/** What writing a proof came to. */
export type PhoneProofWrite =
  /** The proof row now holds the account's current phone. */
  | "proven"
  /** The account's phone is no longer the one the code was sent to (or the account is gone). */
  | "phone_changed"
  /** Another account already holds the proof of this phone (the unique index refused it). */
  | "held_elsewhere";

/**
 * Data access for `payer_phone_proofs` (#2754 item 3): which company proved which phone.
 *
 * A phone is a SIGN-IN CREDENTIAL only through {@link findProvenAccount}: a proof row joined to a
 * payer whose CURRENT `phone_hash` still equals the proof's. Every read FAILS CLOSED on 42P01 (the
 * table not yet migrated): no phone counts as proven. Ids and a keyed hash only; never a number.
 */
@Injectable()
export class PayerPhoneProofsRepository {
  private readonly logger = new Logger(PayerPhoneProofsRepository.name);
  private warnedMissing = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The ONE account a phone signs in by SMS code: the payer holding a proof of `phoneHash` whose
   * current `payers.phone_hash` is still that hash. `undefined` when the phone is unproven, its
   * proof is stale (the account changed its phone), or the table is missing (42P01, fail closed).
   * The unique index on the proof's hash makes "the one" structural: at most one row can match.
   *
   * The payer's STATUS is not filtered here: the callers already refuse a suspended or archived
   * account on both doors (no code is delivered; verify answers 403), and keep their own spine
   * events for it.
   */
  async findProvenAccount(phoneHash: string): Promise<Payer | undefined> {
    try {
      const rows = await this.db
        .select()
        .from(payers)
        .innerJoin(
          payerPhoneProofs,
          and(
            eq(payerPhoneProofs.payerId, payers.id),
            eq(payerPhoneProofs.phoneHash, payers.phoneHash),
          ),
        )
        .where(eq(payerPhoneProofs.phoneHash, phoneHash))
        .limit(1);
      return rows[0]?.payers;
    } catch (err) {
      if (isPhoneProofTableMissing(err)) {
        this.warnMissingOnce("sign-in lookup");
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Is the account's CURRENT phone proven (`GET /payer/me/phone-proof`)? True only when its proof
   * row still names the account's current `payers.phone_hash` — the same join as
   * {@link findProvenAccount}, keyed by the account instead of the phone. A stale proof, no proof,
   * no phone, no account, and a missing table (42P01) are all `false`: the screen then simply
   * offers to prove the phone, and the proof routes say 503 themselves if the table is missing.
   */
  async isCurrentPhoneProven(payerId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .select({ payerId: payerPhoneProofs.payerId })
        .from(payerPhoneProofs)
        .innerJoin(
          payers,
          and(
            eq(payers.id, payerPhoneProofs.payerId),
            eq(payers.phoneHash, payerPhoneProofs.phoneHash),
          ),
        )
        .where(eq(payerPhoneProofs.payerId, payerId))
        .limit(1);
      return rows.length > 0;
    } catch (err) {
      if (isPhoneProofTableMissing(err)) {
        this.warnMissingOnce("status read");
        return false;
      }
      throw err;
    }
  }

  /**
   * A cheap probe that the table exists (the proof routes answer 503 before sending a code that
   * could not be stored). Throws the driver error, so the caller maps 42P01 itself.
   */
  async assertTablePresent(payerId: string): Promise<void> {
    await this.db
      .select({ payerId: payerPhoneProofs.payerId })
      .from(payerPhoneProofs)
      .where(eq(payerPhoneProofs.payerId, payerId))
      .limit(1);
  }

  /**
   * Record that the SIGNED-IN company proved its phone by SMS code (`POST /payer/me/phone-proof/
   * verify`), and run `onProven` (the event) in the SAME transaction.
   *
   *   1. Lock the payer row `FOR UPDATE` — the lock a phone change (`PATCH /payer/me`) takes — and
   *      re-read its phone hash. If it is no longer `phoneHash` (the hash the code was bound to),
   *      nothing is written: `phone_changed`. So a proof can never be written for a number the
   *      account has just left, and a phone change can never slip between this check and the
   *      insert (it waits on the lock, then drops this proof).
   *   2. Upsert the proof (one per account, `ON CONFLICT (payer_id)`), `INSERT … SELECT` from the
   *      locked row so the stored hash is the account's own.
   *   3. If ANOTHER account holds the proof of this phone, the unique index refuses the insert
   *      (23505 on {@link PHONE_PROOF_PHONE_UNIQUE}; two concurrent proofs of one phone: the second
   *      waits on the first's index entry, then fails). The transaction rolls back — no row, no
   *      event — and this returns `held_elsewhere`.
   *
   * A missing table (42P01) propagates; the caller answers 503.
   */
  async recordSmsProof(
    payerId: string,
    phoneHash: string,
    onProven: (tx: Database) => Promise<void>,
  ): Promise<PhoneProofWrite> {
    try {
      return await this.db.transaction(async (raw) => {
        const tx = raw as unknown as Database;
        const [row] = await tx
          .select({ phoneHash: payers.phoneHash })
          .from(payers)
          .where(eq(payers.id, payerId))
          .limit(1)
          .for("update");
        if (!row || row.phoneHash !== phoneHash) return "phone_changed" as const;
        const written = await PayerPhoneProofsRepository.upsert(tx, payerId, phoneHash, "sms_code");
        if (!written) return "phone_changed" as const;
        await onProven(tx);
        return "proven" as const;
      });
    } catch (err) {
      if (isPhoneProvenElsewhere(err)) return "held_elsewhere";
      throw err;
    }
  }

  /**
   * #2754 item 6 (no caller yet) — record that an IMPORTED Campus company's phone is proven: Campus
   * verified that sign-in phone by its own OTP. Runs in the import's transaction `tx`, inside a
   * SAVEPOINT, so a phone another account already holds the proof of rolls back alone and comes
   * back as `held_elsewhere` (the import puts that company on its exception list) instead of
   * aborting the whole batch. Writes nothing (`phone_changed`) unless `phoneHash` is the payer's
   * CURRENT `payers.phone_hash` — a proof of a number the account does not hold would be inert, and
   * is never stored. A missing table (42P01) propagates: the import needs the migration.
   */
  async recordImportedProof(
    payerId: string,
    phoneHash: string,
    tx: Database,
  ): Promise<PhoneProofWrite> {
    try {
      return await tx.transaction(async (savepoint) => {
        const written = await PayerPhoneProofsRepository.upsert(
          savepoint as unknown as Database,
          payerId,
          phoneHash,
          "campus_import",
        );
        return written ? ("proven" as const) : ("phone_changed" as const);
      });
    } catch (err) {
      if (isPhoneProvenElsewhere(err)) return "held_elsewhere";
      throw err;
    }
  }

  /**
   * The one proof write: from the payer row itself, only while its current phone hash is
   * `phoneHash`; one row per account (a re-proof refreshes method and time). True when a row was
   * written. A 23505 on the phone-hash index (another account holds it) propagates to the caller.
   */
  private static async upsert(
    executor: Database,
    payerId: string,
    phoneHash: string,
    method: PayerPhoneProofMethod,
  ): Promise<boolean> {
    const rows = await executor.execute(sql`
      INSERT INTO payer_phone_proofs (payer_id, phone_hash, method, proven_at)
      SELECT p.id, p.phone_hash, ${method}, now()
        FROM payers p
       WHERE p.id = ${payerId}::uuid AND p.phone_hash = ${phoneHash}
      ON CONFLICT (payer_id) DO UPDATE
        SET phone_hash = EXCLUDED.phone_hash,
            method = EXCLUDED.method,
            proven_at = EXCLUDED.proven_at
      RETURNING payer_id`);
    return (rows as unknown as unknown[]).length > 0;
  }

  /** One warning per process for the deploy-before-migration window (never per request). */
  private warnMissingOnce(op: string): void {
    if (this.warnedMissing) return;
    this.warnedMissing = true;
    this.logger.warn(
      `payer_phone_proofs is missing (sqlstate=42P01) during ${op}: no phone counts as proven ` +
        "until the migration is applied, so SMS sign-in sends nothing",
    );
  }
}
