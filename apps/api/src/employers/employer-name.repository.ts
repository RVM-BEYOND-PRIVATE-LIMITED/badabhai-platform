import { Inject, Injectable } from "@nestjs/common";
import { payers, workerEmployment, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * READ-ONLY employer-name access for the career validator's index (TD147(1), WP7).
 *
 * DB ACCESS ONLY: two bounded SELECTs that hand back the STORED AES-256-GCM tokens, never
 * plaintext — decryption belongs to the service beside this file. Both tables hold the names the
 * platform already stores: `payers.org_name_enc` is a company/payer display name, and
 * `worker_employment.employer_name_enc` is a worker's own employer. Neither is ever logged, and
 * neither leaves the process.
 *
 * A BOUNDED READ. The index is an in-memory safety net refreshed on a timer, not an analytics
 * export, so each read caps the rows it pulls (one page of names at alpha scale). The cap is a
 * documented, reviewed constant rather than a knob: raising it widens memory, not correctness.
 */
export const EMPLOYER_NAME_READ_LIMIT = 5_000;

@Injectable()
export class EmployerNameRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The payer/company display names the platform holds, as stored ciphertext tokens. */
  async listPayerOrgNameTokens(limit: number = EMPLOYER_NAME_READ_LIMIT): Promise<string[]> {
    const rows = await this.db
      .select({ token: payers.orgNameEnc })
      .from(payers)
      .limit(limit);
    return rows.map((row) => row.token).filter((token): token is string => typeof token === "string");
  }

  /** The worker-employment employer names the platform holds, as stored ciphertext tokens. */
  async listEmployerNameTokens(limit: number = EMPLOYER_NAME_READ_LIMIT): Promise<string[]> {
    const rows = await this.db
      .select({ token: workerEmployment.employerNameEnc })
      .from(workerEmployment)
      .limit(limit);
    return rows.map((row) => row.token).filter((token): token is string => typeof token === "string");
  }
}
