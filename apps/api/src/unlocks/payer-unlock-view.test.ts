import { describe, expect, it } from "vitest";
import type { UnlockStatus } from "@badabhai/db";
import {
  PAYER_UNLOCK_STATUSES,
  PAYER_VISIBLE_STORED_STATUSES,
  payerUnlockStatus,
  toPayerUnlocks,
} from "./payer-unlock-view";
import type { UnlockProjection } from "./unlocks.repository";

/**
 * #2033 — the payer view of an unlock. The contract side of this is payer-web's
 * `unlockProjectionWireSchema` (`status: z.enum(["granted","revealed","expired","revoked"])`):
 * ONE row outside that enum fails the whole list parse, so the four-value set is pinned here.
 */
const NOW = new Date("2026-10-06T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 1);
const PAST = new Date(NOW.getTime() - 1);

describe("the payer contract", () => {
  it("is exactly granted | revealed | expired | revoked (payer-web's enum)", () => {
    expect([...PAYER_UNLOCK_STATUSES]).toEqual(["granted", "revealed", "expired", "revoked"]);
  });

  it("every stored status the payer route reads maps into that contract", () => {
    for (const s of PAYER_VISIBLE_STORED_STATUSES) {
      expect(PAYER_UNLOCK_STATUSES as readonly string[]).toContain(s);
    }
  });

  it("the internal statuses are not readable from the payer route", () => {
    const stored = PAYER_VISIBLE_STORED_STATUSES as readonly string[];
    expect(stored).not.toContain("requested");
    expect(stored).not.toContain("denied");
  });
});

describe("payerUnlockStatus", () => {
  it.each<[UnlockStatus, Date | null, string | null]>([
    ["granted", FUTURE, "granted"],
    ["granted", NOW, "expired"], // at the boundary the grant is no longer live (`>` in the grant path)
    ["granted", PAST, "expired"],
    ["granted", null, "granted"],
    ["revealed", FUTURE, "revealed"],
    ["revealed", PAST, "expired"],
    ["expired", FUTURE, "expired"],
    ["denied", FUTURE, null],
    ["requested", null, null],
  ])("%s, expires_at=%s → %s", (status, expiresAt, expected) => {
    expect(payerUnlockStatus(status, expiresAt, NOW)).toBe(expected);
  });

  it("fails closed on a status it does not know", () => {
    expect(payerUnlockStatus("bogus" as UnlockStatus, FUTURE, NOW)).toBeNull();
  });
});

describe("toPayerUnlocks", () => {
  const base: UnlockProjection = {
    unlock_id: "u1",
    payer_id: "p1",
    worker_id: "w1",
    job_id: null,
    job_posting_id: "jp1",
    status: "granted",
    reveal_count: 0,
    granted_at: PAST,
    expires_at: PAST,
    created_at: PAST,
  };

  it("keeps every other field (incl. job_posting_id), rewrites only status, drops internal rows", () => {
    const out = toPayerUnlocks(
      [base, { ...base, unlock_id: "u2", status: "denied", expires_at: null }],
      NOW,
    );
    expect(out).toEqual([{ ...base, status: "expired" }]);
  });
});
