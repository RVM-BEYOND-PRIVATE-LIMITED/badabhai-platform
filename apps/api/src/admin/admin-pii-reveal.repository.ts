import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { type Database, workers } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * Data access for the ADMIN-3b reason-gated PII reveal (ADR-0025 Decision 4). SELECT-ONLY: it
 * fetches the worker's id + ENCRYPTED `phone_e164` ciphertext token (NEVER the plaintext — the
 * key never touches the DB; decryption happens in {@link PiiCryptoService} inside the service, at
 * the boundary). It reads `workers` ONLY.
 *
 * SPINE READ-ONLY (must-fix #3): this repository NEVER touches the `events` table — admin events
 * are emitted exclusively through EventsService.emit. It also never reads any other PII column
 * (full_name etc.): the reveal route discloses the phone ONLY.
 */
@Injectable()
export class AdminPiiRevealRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Fetch a worker's id + ENCRYPTED phone ciphertext token, or undefined if no such worker. The
   * returned `phoneE164Encrypted` is the `encryptPii` token from `workers.phone_e164` — still
   * ciphertext; the caller decrypts it transiently at the boundary.
   */
  async findEncryptedPhone(
    workerId: string,
  ): Promise<{ id: string; phoneE164Encrypted: string } | undefined> {
    const [row] = await this.db
      .select({ id: workers.id, phoneE164Encrypted: workers.phoneE164 })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    return row;
  }
}
