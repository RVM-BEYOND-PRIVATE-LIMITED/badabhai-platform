import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import {
  grantCreditsWithinTx,
  type Database,
  type PayerProfileVerificationStatus,
  type PayerRole,
  type PayerStatus,
  type WalletGrantResult,
} from "@badabhai/db";
import { sqlStateOf } from "../common/db-error";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";

/** The facts the welcome rule reads about one company (its tenant key), from one query. */
export interface WelcomeEligibilityFacts {
  /** `payers.role` of the tenant, or null when there is no such row. */
  readonly role: PayerRole | null;
  /** `payers.status` of the tenant, or null. */
  readonly status: PayerStatus | null;
  /** The company record's admin approval (employer or agency profile), or null with no record. */
  readonly verificationStatus: PayerProfileVerificationStatus | null;
  /** A GSTIN is on file (`gst_number_enc IS NOT NULL`, written only by the admin surface). */
  readonly hasGstNumber: boolean;
  /** The account's CURRENT phone is proven (`payer_phone_proofs`, #2754 item 3). */
  readonly phoneProven: boolean;
  /** At least one posting (or agency job) of the company is approved (`verified`). */
  readonly hasApprovedPosting: boolean;
}

/** Postgres "undefined_table": `payer_phone_proofs` before its migration is applied. */
const UNDEFINED_TABLE = "42P01";

/**
 * #2750 item 4 — the welcome grant's reads and its one write. The write goes through the wallet
 * helper (`grantCreditsWithinTx`: wallet row lock, then the lot, then ONE ledger line), keyed so a
 * company is credited once, ever: two approvals racing on one company serialise on the wallet row
 * and the second finds the key already on the ledger.
 */
@Injectable()
export class WelcomeCreditsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async eligibility(tenant: TenantKey): Promise<WelcomeEligibilityFacts> {
    const rows = await this.db.execute<{
      role: PayerRole | null;
      status: PayerStatus | null;
      verification_status: PayerProfileVerificationStatus | null;
      has_gst: boolean | null;
      has_approved_posting: boolean;
    }>(sql`
      SELECT
        p.role,
        p.status,
        CASE WHEN p.role = 'agent' THEN ap.verification_status ELSE ep.verification_status END
          AS verification_status,
        CASE WHEN p.role = 'agent' THEN ap.gst_number_enc IS NOT NULL
             ELSE ep.gst_number_enc IS NOT NULL END AS has_gst,
        (EXISTS (SELECT 1 FROM job_postings jp
                 WHERE jp.payer_id = ${tenant}::uuid AND jp.verification_status = 'verified')
         OR EXISTS (SELECT 1 FROM jobs j
                    WHERE j.payer_id = ${tenant}::uuid AND j.verification_status = 'verified'))
          AS has_approved_posting
      FROM (SELECT ${tenant}::uuid AS id) t
      LEFT JOIN payers p ON p.id = t.id
      LEFT JOIN employer_profiles ep ON ep.payer_id = t.id
      LEFT JOIN agency_profiles ap ON ap.payer_id = t.id`);
    const row = [...rows][0];
    return {
      role: row?.role ?? null,
      status: row?.status ?? null,
      verificationStatus: row?.verification_status ?? null,
      hasGstNumber: row?.has_gst === true,
      phoneProven: await this.phoneProven(tenant),
      hasApprovedPosting:
        row?.has_approved_posting === true || (await this.hasImportedApprovedPosting(tenant)),
    };
  }

  /**
   * #2754 item 10 — a moved company with a live APPROVED Campus job qualifies on move day (the
   * issue's default). An imported posting carries Campus's approval as its RVM review
   * (`job_posting_institute_reviews`, `approved`, written by the import with the posting), not the
   * ops "Verified job" badge, so it is counted here: OPEN, imported (a `job` row of the import
   * ledger names it) and RVM-approved. Fails CLOSED before migration `company_import` (42P01).
   */
  private async hasImportedApprovedPosting(tenant: TenantKey): Promise<boolean> {
    try {
      const rows = await this.db.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM job_postings jp
          JOIN company_import_rows r
            ON r.kind = 'job' AND r.target_id = jp.id AND r.state IN ('created', 'matched')
          JOIN job_posting_institute_reviews jr
            ON jr.job_posting_id = jp.id AND jr.institute_code = 'rvm' AND jr.state = 'approved'
          WHERE jp.payer_id = ${tenant}::uuid AND jp.status = 'open'
        ) AS ok`);
      return [...rows][0]?.ok === true;
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) return false;
      throw err;
    }
  }

  /**
   * Is the account's CURRENT phone proven? A proof counts only while it names the phone the
   * account holds now (the #2754 rule). Fails CLOSED: before `payer_phone_proofs` is applied
   * (42P01) no phone is proven, so the GSTIN is then the only second condition.
   */
  private async phoneProven(tenant: TenantKey): Promise<boolean> {
    try {
      const rows = await this.db.execute<{ proven: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM payer_phone_proofs pp
          JOIN payers p ON p.id = pp.payer_id
          WHERE pp.payer_id = ${tenant}::uuid AND p.phone_hash IS NOT NULL
            AND pp.phone_hash = p.phone_hash
        ) AS proven`);
      return [...rows][0]?.proven === true;
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) return false;
      throw err;
    }
  }

  /**
   * Grant the welcome lot, once per company, and run `afterGrant` (the event) in the SAME
   * transaction only when the grant applied. Keyed `welcome_credits:<tenant>`.
   */
  async grantOnce(
    tenant: TenantKey,
    input: { credits: number; expiresAt: Date },
    afterGrant: (tx: Database, lotId: string) => Promise<void>,
  ): Promise<WalletGrantResult> {
    return this.db.transaction(async (tx) => {
      const result = await grantCreditsWithinTx(tx, {
        payerId: tenant,
        credits: input.credits,
        lot: { source: "welcome", expiresAt: input.expiresAt },
        ledger: { reason: "welcome", idempotencyKey: welcomeCreditsIdempotencyKey(tenant) },
      });
      if (result.applied) await afterGrant(tx as unknown as Database, result.lotId);
      return result;
    });
  }
}

/** The ledger key that makes a company's welcome credits once, ever. */
export function welcomeCreditsIdempotencyKey(tenant: string): string {
  return `welcome_credits:${tenant}`;
}
