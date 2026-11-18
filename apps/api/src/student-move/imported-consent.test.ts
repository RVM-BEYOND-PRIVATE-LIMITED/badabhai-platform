import { describe, expect, it, vi } from "vitest";
import { workerConsents, type Database } from "@badabhai/db";
import { consentAcceptedFrom, withConsentAccepted } from "../consent/consent-flag";
import {
  IMPORTED_CONSENT_PURPOSES,
  isImportedConsent,
  recordImportedConsent,
} from "./imported-consent";

/**
 * #2887 — a moved student's Campus consent as his consent row (owner choice: ACTIVE), and the
 * sign-in signal that still sends him through BadaBhai's own consent screen (with the 18+ tick)
 * once.
 */

const WORKER = "22222222-2222-4222-8222-222222222222";

function fakeTx() {
  const values = vi.fn();
  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        values(table, v);
        return { returning: async () => [{ id: "consent-1", ...v }] };
      },
    })),
  };
  return { tx: tx as unknown as Database, values };
}

describe("recordImportedConsent", () => {
  it("writes an active row: campus_import:<version>, the Campus date, the imported purposes", async () => {
    const { tx, values } = fakeTx();
    const at = new Date("2026-08-01T10:00:00Z");
    await recordImportedConsent(tx, WORKER, { campusConsentVersion: "v3.2", campusConsentedAt: at });
    expect(values).toHaveBeenCalledWith(workerConsents, {
      workerId: WORKER,
      consentVersion: "campus_import:v3.2",
      purposes: [...IMPORTED_CONSENT_PURPOSES],
      acceptedAt: at,
      ipHash: null,
      userAgent: null,
    });
  });

  it("the imported purposes let a visible student be searched and contacted", () => {
    expect(IMPORTED_CONSENT_PURPOSES).toContain("employer_sharing");
    expect(IMPORTED_CONSENT_PURPOSES).toContain("employer_messaging");
  });

  it.each([
    ["an empty version", "", new Date()],
    ["a version that forges a prefix", "x:campus_import:v1", new Date()],
    ["a version with spaces", "v 1", new Date()],
    ["an invalid date", "v1", new Date("not a date")],
  ])("refuses %s and writes nothing", async (_label, version, at) => {
    const { tx, values } = fakeTx();
    await expect(
      recordImportedConsent(tx, WORKER, { campusConsentVersion: version, campusConsentedAt: at }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(values).not.toHaveBeenCalled();
  });
});

describe("consent_accepted at sign-in", () => {
  const live = (consentVersion: string) => ({ revokedAt: null, consentVersion });

  it("an ordinary active consent is accepted", () => {
    expect(consentAcceptedFrom(live("2026-11-04"))).toBe(true);
  });

  it("an imported Campus consent is NOT accepted: the app shows BadaBhai's consent screen once", () => {
    expect(isImportedConsent("campus_import:v3.2")).toBe(true);
    expect(consentAcceptedFrom(live("campus_import:v3.2"))).toBe(false);
  });

  it("none, or revoked, is not accepted (unchanged)", () => {
    expect(consentAcceptedFrom(undefined)).toBe(false);
    expect(consentAcceptedFrom({ revokedAt: new Date(), consentVersion: "2026-11-04" })).toBe(false);
  });

  it("the login compose applies the same rule", async () => {
    const reader = { findLatestByWorker: vi.fn(async () => live("campus_import:v3.2")) };
    const out = await withConsentAccepted(reader as never, { worker_id: WORKER });
    expect(out.consent_accepted).toBe(false);
    reader.findLatestByWorker.mockResolvedValue(live("2026-11-04"));
    expect((await withConsentAccepted(reader as never, { worker_id: WORKER })).consent_accepted).toBe(
      true,
    );
  });
});
