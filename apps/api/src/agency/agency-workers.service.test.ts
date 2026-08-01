import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { AgencyWorkersService } from "./agency-workers.service";
import type {
  AgencyWorkersRepository,
  AgencyWorkerEngagementRow,
} from "./agency-workers.repository";
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

/**
 * The repository orders by `last_active_on DESC NULLS LAST, ai.invited_worker_id ASC` so the
 * LIMIT is deterministic — but that tiebreak is a RAW WORKER UUID. Shipping that order to the
 * client makes the row positions a function of exactly the ids `ref` exists to hide: an agency
 * is also a payer and holds real workers.id values from the applicant/unlock surfaces, so
 * within a tie group (in practice the whole never-active block) it could sort its known uuids
 * and read the alignment straight off the returned order.
 *
 * These rows arrive in uuid-ascending order, the way the SQL hands them over.
 */
const CREW = [
  "10000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
  "40000000-0000-4000-8000-000000000004",
  "50000000-0000-4000-8000-000000000005",
  "60000000-0000-4000-8000-000000000006",
];

const refFor = (agency: string, worker: string) =>
  createHmac("sha256", "test-pepper")
    .update(`agency_worker:${agency}:${worker}`)
    .digest("hex")
    .slice(0, 16);

/** Recover which worker each returned `ref` stands for, so orders are comparable ACROSS agencies. */
const orderOf = (out: { workers: { ref: string }[] }, agency: string): string[] =>
  out.workers.map((w) => CREW.find((id) => refFor(agency, id) === w.ref) ?? `unknown:${w.ref}`);

const crewRows = (lastActiveOn: string | null = null): AgencyWorkerEngagementRow[] =>
  CREW.map((workerId) => ({ ...ROW, workerId, lastActiveOn }));

describe("AgencyWorkersService — the RESPONSE ORDER carries no worker-uuid signal", () => {
  it("gives two agencies the SAME workers in DIFFERENT orders (order is not a shared function of the uuids)", async () => {
    const { svc } = setup(crewRows());
    const a = orderOf(await svc.listReferred(AGENCY_A), AGENCY_A);
    const b = orderOf(await svc.listReferred(AGENCY_B), AGENCY_B);

    // Same underlying men, both times — nothing was dropped or invented by the re-sort.
    expect(new Set(a)).toEqual(new Set(CREW));
    expect(new Set(b)).toEqual(new Set(CREW));
    // If the response kept the repository's uuid-derived order these would be IDENTICAL, and
    // that shared order is what lets a colluding/knowing agency align rows to known uuids.
    expect(a).not.toEqual(b);
  });

  it("does NOT hand back the repository's uuid-ascending order", async () => {
    const { svc } = setup(crewRows());
    expect(orderOf(await svc.listReferred(AGENCY_A), AGENCY_A)).not.toEqual(CREW);
  });

  it("orders a tie group by the per-agency pseudonym (deterministic, and stable per agency)", async () => {
    const { svc } = setup(crewRows());
    const refs = (await svc.listReferred(AGENCY_A)).workers.map((w) => w.ref);
    expect(refs).toEqual([...refs].sort());
    // Stable: a second identical request returns the same order (the list stays usable).
    expect((await svc.listReferred(AGENCY_A)).workers.map((w) => w.ref)).toEqual(refs);
  });

  it("still returns most-recently-active first, with never-active LAST (the product order is unchanged)", async () => {
    const { svc } = setup([
      { ...ROW, workerId: CREW[0]!, lastActiveOn: null },
      { ...ROW, workerId: CREW[1]!, lastActiveOn: "2026-07-20" },
      { ...ROW, workerId: CREW[2]!, lastActiveOn: "2026-07-29" },
      { ...ROW, workerId: CREW[3]!, lastActiveOn: null },
      { ...ROW, workerId: CREW[4]!, lastActiveOn: "2026-07-25" },
    ]);
    const days = (await svc.listReferred(AGENCY_A)).workers.map((w) => w.lastActiveOn);
    expect(days).toEqual(["2026-07-29", "2026-07-25", "2026-07-20", null, null]);
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
