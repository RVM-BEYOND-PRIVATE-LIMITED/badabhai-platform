import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { AgencyWorkersService } from "./agency-workers.service";
import type { AgencyWorkersRepository, AgencyWorkerEngagementRow } from "./agency-workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { createHmac } from "node:crypto";

/**
 * B5 — the agency ENGAGEMENT projection (ADR-0022 portal).
 *
 * The properties under test are the ones that, if they broke, would expose a real
 * person to a commercial party — and would do so silently, because the response
 * would still look like a plausible dashboard.
 */

const AGENCY_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENCY_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const WORKER = "11111111-1111-4111-8111-111111111111";

/** A real keyed HMAC, so the per-agency divergence below is a measured fact. */
const pii = {
  hmac: (v: string) => createHmac("sha256", "test-pepper").update(v).digest("hex"),
} as unknown as PiiCryptoService;

function setup(rows: AgencyWorkerEngagementRow[]) {
  const repo = { listReferredWithConsent: vi.fn(async () => rows) };
  return {
    svc: new AgencyWorkersService(repo as unknown as AgencyWorkersRepository, pii),
    repo,
  };
}

const ROW: AgencyWorkerEngagementRow = {
  workerId: WORKER,
  profileComplete: true,
  appliedCount: 4,
  unlockedCount: 2,
  lastActiveOn: "2026-07-29",
};

describe("AgencyWorkersService — the projection is faceless", () => {
  it("NEVER returns the worker uuid, under any key", async () => {
    const { svc } = setup([ROW]);
    const out = await svc.listReferred(AGENCY_A);
    // The uuid must not appear anywhere in the serialized response — not as a field,
    // not embedded in the pseudonym, not in a stray debug key.
    expect(JSON.stringify(out)).not.toContain(WORKER);
  });

  it("returns ONLY the engagement fields (a new PII field cannot ride along unnoticed)", async () => {
    const { svc } = setup([ROW]);
    const [row] = (await svc.listReferred(AGENCY_A)).workers;
    expect(Object.keys(row!).sort()).toEqual(
      ["appliedCount", "lastActiveOn", "profileComplete", "ref", "unlockedCount"].sort(),
    );
  });

  it("reports last-active as a DAY, never a time of day", async () => {
    const { svc } = setup([ROW]);
    const [row] = (await svc.listReferred(AGENCY_A)).workers;
    // An exact minute would let an agency infer a worker's shift pattern, which is
    // surveillance rather than engagement. The UTC day is formatted in SQL (see the
    // repository) so no timezone round-trip here can shift it off by one.
    expect(row!.lastActiveOn).toBe("2026-07-29");
    expect(row!.lastActiveOn).not.toMatch(/[T:]/);
  });

  it("passes a null last-active through as null (never a fabricated date)", async () => {
    const { svc } = setup([{ ...ROW, lastActiveOn: null }]);
    const [row] = (await svc.listReferred(AGENCY_A)).workers;
    expect(row!.lastActiveOn).toBeNull();
  });
});

describe("AgencyWorkersService — the pseudonym is PER-AGENCY", () => {
  it("gives two agencies DIFFERENT handles for the SAME worker (no collusion join)", async () => {
    const { svc } = setup([ROW]);
    const a = (await svc.listReferred(AGENCY_A)).workers[0]!.ref;
    const b = (await svc.listReferred(AGENCY_B)).workers[0]!.ref;
    // If the payer id were left out of the HMAC input these would be EQUAL, and two
    // agencies could merge their lists to build a joint profile of one man.
    expect(a).not.toBe(b);
  });

  it("is STABLE for one agency across requests (the list stays usable)", async () => {
    const { svc } = setup([ROW]);
    const first = (await svc.listReferred(AGENCY_A)).workers[0]!.ref;
    const second = (await svc.listReferred(AGENCY_A)).workers[0]!.ref;
    expect(first).toBe(second);
  });
});

describe("AgencyWorkersService — the consent gate is the REPOSITORY's, and it is bounded", () => {
  it("returns an empty list when the repo yields nothing (no-consent is INDISTINGUISHABLE from never-referred)", async () => {
    // The gate lives in SQL: a non-consenting worker is never SELECTED. So the service
    // has nothing to filter and no way to leak a "this worker exists but said no",
    // which would be a consent oracle.
    const { svc } = setup([]);
    await expect(svc.listReferred(AGENCY_A)).resolves.toEqual({ workers: [] });
  });

  it("asks the repository for the caller's OWN payer id and a bounded page", async () => {
    const { svc, repo } = setup([ROW]);
    await svc.listReferred(AGENCY_A);
    expect(repo.listReferredWithConsent).toHaveBeenCalledWith(
      AGENCY_A,
      AgencyWorkersService.MAX_ROWS,
    );
    expect(AgencyWorkersService.MAX_ROWS).toBeLessThanOrEqual(200);
  });
});
