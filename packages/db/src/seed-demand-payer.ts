import { encryptPii, hmacValue } from "./crypto";
import type { NewPayer, NewPayerMember, NewPayerOrg } from "./schema";

/**
 * The account rows `db:seed:demand` writes for its payer (review of PR #2174, security L3).
 *
 * Pure (no DB, no env): the seed calls it, and `seed-demand-payer.test.ts` pins it. The rows are
 * the ones signup writes — `payers` (`PayersRepository.createOrGet`, then `activate`), the solo
 * `payer_orgs` row and its founding owner `payer_members` row (`PayerOrgsRepository
 * .ensureSoloOrg`). Without them the payer is a bare id, and with `PAYER_ORG_TENANCY_MODE=on`
 * the ops routes the demand loop drives refuse it (ADR-0053 §5.2 rule 4, R4 → R7).
 *
 * Synthetic only: the login is in the reserved, unregistrable `e2e.badabhai.invalid` domain, and
 * it and the org name are stored as ciphertext under the API's PII key, with the API's keyed
 * hash (`PiiCryptoService.hmac` = `hmacValue`) — so the API reads the row as it reads any payer.
 */

/** The seed's stable payer id (unchanged; `verify-demand.ts` names it too). */
export const DEMAND_PAYER_ID = "5eeded00-0004-4a00-8000-000000000004";
/** A reserved, unregistrable address (RFC 2606 `.invalid`), lower-case as the API normalises. */
const DEMAND_PAYER_EMAIL = "seed-demand@e2e.badabhai.invalid";
const DEMAND_ORG_NAME = "SYNTHETIC — Demand Seed (not a real employer)";

export interface DemandPayerRows {
  readonly payer: NewPayer & { emailEnc: string; emailHash: string; orgNameEnc: string };
  readonly org: NewPayerOrg;
}

/** The payer row and its solo org row. */
export function demandPayerRows(keyB64: string, pepper: string): DemandPayerRows {
  const emailEnc = encryptPii(DEMAND_PAYER_EMAIL, keyB64);
  const orgNameEnc = encryptPii(DEMAND_ORG_NAME, keyB64);
  return {
    payer: {
      id: DEMAND_PAYER_ID,
      role: "employer",
      emailEnc,
      emailHash: hmacValue(DEMAND_PAYER_EMAIL, pepper),
      orgNameEnc,
      status: "active",
    },
    org: { rootPayerId: DEMAND_PAYER_ID, nameEnc: orgNameEnc, status: "active" },
  };
}

/** The founding owner membership of the org `orgId` (as `ensureSoloOrg` writes it). */
export function demandOwnerRow(
  orgId: string,
  payer: Pick<DemandPayerRows["payer"], "emailEnc" | "emailHash">,
  now: Date,
): NewPayerMember {
  return {
    orgId,
    memberPayerId: DEMAND_PAYER_ID,
    emailEnc: payer.emailEnc,
    emailHash: payer.emailHash,
    orgRole: "owner",
    status: "active",
    acceptedAt: now,
  };
}
