import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * #2753 item 12 — the ONE statement behind `GET /referrals/helper`: the encrypted company name of
 * the agency a code belongs to, or no row.
 *
 * A row only for a LIVE AGENCY CODE, in the order the attribution hook resolves a code, so the
 * name shown before sign-in is the agency that `POST /referrals/attribute` would attribute to:
 *   - an `agency_invites` code not yet accepted (an accepted invite is spent: it attributes nobody
 *     else), or an `agent` `referral_links` code that has not expired;
 *   - whose agency (`payers`, the tenant anchor the invite names) is an ACTIVE `agent` — a
 *     suspended or archived agency is shown to nobody;
 *   - and the code is neither a worker's invite (`invites`, which the hook tries first and treats
 *     as terminal) nor a résumé QR (`referral_links` `resume_qr`, where the hook stops).
 *
 * The company name is `payers.org_name_enc` of that anchor, the column `GET /payer/me` reads for
 * the tenant's name (ADR-0053 O-10). No worker table is named, so no worker's name can come back.
 *
 * Every lookup is a unique-index probe on `code`, and the statement is the same for every input,
 * so a worker code, an unknown code and an expired one cost the same query.
 */
export function agencyNameByCodeStatement(code: string): SQL {
  return sql`select p.org_name_enc as "name_enc"
    from payers p
    where p.id = coalesce(
        (select ai.inviter_payer_id from agency_invites ai
          where ai.code = ${code} and ai.invited_worker_id is null),
        (select rl.agent_payer_id from referral_links rl
          where rl.code = ${code} and rl.kind = 'agent'
            and (rl.expires_at is null or rl.expires_at > now()))
      )
      and p.role = 'agent'
      and p.status = 'active'
      and not exists (select 1 from invites i where i.code = ${code})
      and not exists (
        select 1 from referral_links q where q.code = ${code} and q.kind = 'resume_qr'
      )
    limit 1`;
}

/** Data access for the helper's name. Ciphertext only: the service decrypts. */
@Injectable()
export class ReferralHelperNameRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The agency's encrypted company name for a live agency code, else null. */
  async findAgencyNameEnc(code: string): Promise<string | null> {
    const rows = await this.db.execute<{ name_enc: string }>(agencyNameByCodeStatement(code));
    return rows[0]?.name_enc ?? null;
  }
}
