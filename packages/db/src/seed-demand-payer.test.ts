import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPii, hmacValue } from "./crypto";
import { DEMAND_PAYER_ID, demandOwnerRow, demandPayerRows } from "./seed-demand-payer";

/**
 * `db:seed:demand`'s payer is a REAL account (review of PR #2174, security L3 / code L-4).
 *
 * The demand loop (`db:verify:demand`) buys a plan and unlocks through the OPS routes, whose body
 * `payer_id` goes through the payer tenant resolver (ADR-0053 §5.2 rule 4). With
 * `PAYER_ORG_TENANCY_MODE=on` the resolver refuses an id that names no payer (R4 heal → R7), so a
 * seed that wrote only a `payer_credits` row under a bare id broke the loop in `on`. The seed now
 * writes the rows signup writes: the `payers` row, its solo org and the founding owner
 * membership — keyed the way the API keys them, so the resolver reads them as a solo payer.
 */
const KEY = randomBytes(32).toString("base64");
const PEPPER = "test-pepper-for-seed-demand";
const NOW = new Date("2026-10-08T00:00:00.000Z");

describe("seed-demand's payer — the account rows signup writes", () => {
  const { payer, org } = demandPayerRows(KEY, PEPPER);

  it("is an ACTIVE employer under the seed's stable id, with a synthetic, encrypted login", () => {
    expect(payer).toMatchObject({ id: DEMAND_PAYER_ID, role: "employer", status: "active" });
    // A reserved, unregistrable address, stored only as ciphertext + the API's keyed hash.
    const email = decryptPii(payer.emailEnc, KEY);
    expect(email).toMatch(/@e2e\.badabhai\.invalid$/);
    expect(payer.emailHash).toBe(hmacValue(email, PEPPER));
    expect(decryptPii(payer.orgNameEnc, KEY)).toMatch(/SYNTHETIC/);
  });

  it("anchors its own solo org (the resolver's tenant for it is itself)", () => {
    expect(org).toMatchObject({ rootPayerId: DEMAND_PAYER_ID, status: "active" });
    expect(org.nameEnc).toBe(payer.orgNameEnc);
  });

  it("is that org's active OWNER member, under the same login hash (as ensureSoloOrg writes it)", () => {
    const owner = demandOwnerRow("org-1", payer, NOW);
    expect(owner).toEqual({
      orgId: "org-1",
      memberPayerId: DEMAND_PAYER_ID,
      emailEnc: payer.emailEnc,
      emailHash: payer.emailHash,
      orgRole: "owner",
      status: "active",
      acceptedAt: NOW,
    });
  });
});
