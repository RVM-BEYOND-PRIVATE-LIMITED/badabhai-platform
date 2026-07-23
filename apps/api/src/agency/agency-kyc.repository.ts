import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  type Database,
  agencyKyc,
  type AgencyKyc,
  type AgencyKycStatus,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The ciphertext fields written on submit (already encrypted by the service). */
export interface AgencyKycCiphertext {
  panEnc: string;
  panHash: string;
  bankAccountEnc: string;
  ifscEnc: string;
  accountHolderNameEnc: string;
}

/**
 * Data access for `agency_kyc` (ADR-0022 Amendment 2). FINANCIAL PII AT REST — the columns
 * are AES ciphertext + a keyed HMAC (`panHash`); this repo only ever moves those tokens, never
 * plaintext (the service owns encrypt/decrypt). One row per agency (`payer_id` UNIQUE); a
 * re-submit RESETS the row to `pending` (a new submission must be re-verified).
 */
@Injectable()
export class AgencyKycRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Upsert the agency's KYC (create or replace-and-reset-to-pending). A resubmission wipes any
   * prior verified/rejected state — new details require fresh ops verification. Returns the row.
   */
  async upsertPending(payerId: string, c: AgencyKycCiphertext): Promise<AgencyKyc> {
    const [row] = await this.db
      .insert(agencyKyc)
      .values({
        payerId,
        panEnc: c.panEnc,
        panHash: c.panHash,
        bankAccountEnc: c.bankAccountEnc,
        ifscEnc: c.ifscEnc,
        accountHolderNameEnc: c.accountHolderNameEnc,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: agencyKyc.payerId,
        set: {
          panEnc: c.panEnc,
          panHash: c.panHash,
          bankAccountEnc: c.bankAccountEnc,
          ifscEnc: c.ifscEnc,
          accountHolderNameEnc: c.accountHolderNameEnc,
          status: "pending",
          verifiedAt: null,
          verifiedBy: null,
          rejectReason: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("failed to upsert agency kyc");
    return row;
  }

  /** Fetch the agency's own KYC row (ciphertext; decrypt only via the service). */
  async findByPayer(payerId: string): Promise<AgencyKyc | undefined> {
    const [row] = await this.db
      .select()
      .from(agencyKyc)
      .where(eq(agencyKyc.payerId, payerId))
      .limit(1);
    return row;
  }

  /** Ops list by status (default pending) — for the ops-console verify queue. */
  async listByStatus(status: AgencyKycStatus): Promise<AgencyKyc[]> {
    return this.db
      .select()
      .from(agencyKyc)
      .where(eq(agencyKyc.status, status))
      .orderBy(desc(agencyKyc.createdAt));
  }

  /**
   * Ops verify: pending → verified (idempotency-guarded on still-pending so a double verify is a
   * no-op). Returns true iff this call performed the transition. `verified_by` stays null on the
   * ops shared-secret path (no per-person id today; the column awaits a future ADR-0025 wiring).
   */
  async markVerified(payerId: string): Promise<boolean> {
    const rows = await this.db
      .update(agencyKyc)
      .set({ status: "verified", verifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agencyKyc.payerId, payerId), eq(agencyKyc.status, "pending")))
      .returning({ id: agencyKyc.id });
    return rows.length > 0;
  }

  /** Ops reject: pending → rejected with a bounded reason CODE. No-op if not pending. */
  async markRejected(payerId: string, reason: string): Promise<boolean> {
    const rows = await this.db
      .update(agencyKyc)
      .set({
        status: "rejected",
        rejectReason: reason,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agencyKyc.payerId, payerId), eq(agencyKyc.status, "pending")))
      .returning({ id: agencyKyc.id });
    return rows.length > 0;
  }
}
