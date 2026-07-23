import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { Database } from "@badabhai/db";
import { AgencyKycRepository } from "./agency-kyc.repository";

const AGENCY = "11111111-1111-4111-8111-111111111111";

/** Capturing mock of the update(...).set(...).where(...).returning(...) chain. */
function makeDb(returnRows: Array<{ id: string }>): { db: Database; captured: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured = v;
        return { where: () => ({ returning: async () => returnRows }) };
      },
    }),
  } as unknown as Database;
  return { db, captured: () => captured };
}

describe("AgencyKycRepository — ops transitions", () => {
  it("markRejected does NOT set verified_at (a rejection was never verified) + returns the ts", async () => {
    const { db, captured } = makeDb([{ id: "kyc-1" }]);
    const repo = new AgencyKycRepository(db);
    const at = await repo.markRejected(AGENCY, "invalid_pan");

    const set = captured();
    expect(set.status).toBe("rejected");
    expect(set.rejectReason).toBe("invalid_pan");
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(set.verifiedAt).toBeUndefined(); // the #5 fix: never stamp verified_at on a reject
    expect(at).toBeInstanceOf(Date); // the transition ts feeds the per-decision event key
  });

  it("markVerified sets verified_at + returns the transition ts; a no-op returns null", async () => {
    const hit = makeDb([{ id: "kyc-1" }]);
    expect(await new AgencyKycRepository(hit.db).markVerified(AGENCY)).toBeInstanceOf(Date);
    expect(hit.captured().status).toBe("verified");
    expect(hit.captured().verifiedAt).toBeInstanceOf(Date);

    const miss = makeDb([]); // not pending → no transition
    expect(await new AgencyKycRepository(miss.db).markVerified(AGENCY)).toBeNull();
  });
});
