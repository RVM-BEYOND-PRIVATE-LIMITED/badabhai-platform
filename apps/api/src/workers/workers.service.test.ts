import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { WorkersService } from "./workers.service";
import type { WorkersRepository } from "./workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const NAME = "Asha Kumari";
const TOKEN = "v1.opaqueciphertext"; // encrypt() output — must NOT contain the name

function setup(workerExists = true) {
  const repo = {
    findById: vi.fn(async (_id: string) => (workerExists ? { id: "w-1", fullName: null } : undefined)),
    updateFullName: vi.fn(async (_id: string, _token: string) => ({ id: "w-1" })),
  };
  const pii = { encrypt: vi.fn((_plaintext: string) => TOKEN) };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const svc = new WorkersService(
    repo as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    events as unknown as EventsService,
  );
  return { svc, repo, pii, events };
}

describe("WorkersService.setFullName (TD21)", () => {
  it("encrypts the name before storing — a plaintext name is never persisted", async () => {
    const { svc, repo, pii } = setup();
    await svc.setFullName("w-1", NAME, CTX);

    expect(pii.encrypt).toHaveBeenCalledWith(NAME);
    expect(repo.updateFullName).toHaveBeenCalledWith("w-1", TOKEN);
    // the value handed to the DB is the ciphertext token, not the name
    expect(repo.updateFullName.mock.calls[0]![1]).not.toContain("Asha");
  });

  it("emits a PII-free worker.name_recorded event (no name) and returns only worker_id", async () => {
    const { svc, events } = setup();
    const res = await svc.setFullName("w-1", NAME, CTX);

    expect(res).toEqual({ worker_id: "w-1" });
    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.event_name).toBe("worker.name_recorded");
    expect(emitArg.payload).toEqual({ worker_id: "w-1" });
    // the name must appear NOWHERE in the emitted event
    expect(JSON.stringify(emitArg)).not.toMatch(/Asha/i);
  });

  it("throws NotFound for an unknown worker — no write, no event", async () => {
    const { svc, repo, events } = setup(false);
    await expect(svc.setFullName("missing", NAME, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateFullName).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getProfileSummary (TD54) — worker self-view summary of the latest profile row
// ---------------------------------------------------------------------------

/**
 * A full CONFIRMED profile row as the repo returns it. Includes extraneous PII
 * sentinels (fullName/phone-shaped keys + a rawProfile blob) that the DB row
 * type does NOT carry but a sloppy spread WOULD leak — the summary must project
 * a whitelist, so none of these may appear in the response.
 */
const CONFIRMED_PROFILE = {
  id: "p-1",
  workerId: "w-1",
  aiJobId: "j-1",
  profileStatus: "confirmed",
  canonicalTradeId: "cnc_vmc",
  canonicalRoleId: "role_vmc_operator",
  skills: ["skill_fanuc", "skill_measuring_instruments"],
  machines: ["mach_vmc"],
  experience: { total_years: 4, summary: "4 years on VMC" },
  salaryExpectation: { amount_min: 18000, amount_max: 22000, currency: "INR", period: "monthly" },
  locationPreference: { preferred_cities: ["pune", "mumbai"], willing_to_relocate: true },
  availability: { status: "immediate", notice_period_days: null },
  rawProfile: { note: "v1.ciphertext deadbeef" }, // sentinel: must NEVER be projected
  embedding: null,
  confirmedAt: new Date("2026-07-01T10:00:00Z"),
  createdAt: new Date("2026-06-30T00:00:00Z"),
  updatedAt: new Date("2026-07-01T10:00:00Z"),
  // Extraneous PII-shaped sentinels (not real profile columns) — assert absent:
  fullName: "v1.ciphertext",
  phoneE164: "v1.ciphertext",
  phoneHash: "deadbeef",
};

function summarySetup(profile: unknown) {
  const repo = {
    latestProfile: vi.fn(async (_workerId: string) => profile),
  };
  const pii = { encrypt: vi.fn() };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const svc = new WorkersService(
    repo as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    events as unknown as EventsService,
  );
  return { svc, repo, events };
}

describe("WorkersService.getProfileSummary (TD54)", () => {
  it('returns the "none" summary when the worker has no profile row', async () => {
    const { svc } = summarySetup(undefined);
    const res = await svc.getProfileSummary("w-1");
    expect(res).toEqual({
      profile_status: "none",
      confirmed_at: null,
      trade: { canonical_trade_id: null, canonical_role_id: null, display_name: null },
      city: null,
      strength: 0,
    });
  });

  it("maps a full confirmed profile: status, ISO confirmed_at, trade ids + taxonomy display_name, first city, hand-computed strength", async () => {
    const { svc } = summarySetup(CONFIRMED_PROFILE);
    const res = await svc.getProfileSummary("w-1");
    expect(res).toEqual({
      profile_status: "confirmed",
      confirmed_at: "2026-07-01T10:00:00.000Z",
      trade: {
        canonical_trade_id: "cnc_vmc",
        canonical_role_id: "role_vmc_operator",
        display_name: "VMC Operator", // getRole("role_vmc_operator").name
      },
      city: "pune", // preferred_cities[0]
      // countFields recompute: role(1) + trade(1) + skills(2) + machines(1)
      // + total_years(1) + salary(1) + cities(1) + availability(1) = 9
      strength: 9,
    });
  });

  it("malformed/empty location_preference JSONB ⇒ city null, no throw", async () => {
    for (const locationPreference of [{}, { preferred_cities: "notarray" }, null, "pune"]) {
      const { svc } = summarySetup({ ...CONFIRMED_PROFILE, locationPreference });
      const res = await svc.getProfileSummary("w-1");
      expect(res.city).toBeNull();
      // the cities +1 drops out of the recompute too
      expect(res.strength).toBe(8);
    }
  });

  it("unknown canonical_role_id ⇒ display_name null (getRole + trade-content both miss)", async () => {
    const { svc } = summarySetup({
      ...CONFIRMED_PROFILE,
      canonicalRoleId: "role_definitely_not_in_taxonomy",
      canonicalTradeId: null,
    });
    const res = await svc.getProfileSummary("w-1");
    expect(res.trade).toEqual({
      canonical_trade_id: null,
      canonical_role_id: "role_definitely_not_in_taxonomy",
      display_name: null,
    });
  });

  it("reads the CALLER-provided worker id, leaks no PII sentinel, and emits NO event (read-only self-view)", async () => {
    const { svc, repo, events } = summarySetup(CONFIRMED_PROFILE);
    const res = await svc.getProfileSummary("w-token-1");
    // identity: the repo is queried with exactly the id the guard provided
    expect(repo.latestProfile).toHaveBeenCalledWith("w-token-1");
    // no-PII: none of the row's sentinels (fullName/phone/rawProfile) survive projection
    expect(JSON.stringify(res)).not.toMatch(/ciphertext|deadbeef|phone|full_?name/i);
    // deliberately event-less: a read is not a material state change (§1)
    expect(events.emit).not.toHaveBeenCalled();
  });
});
