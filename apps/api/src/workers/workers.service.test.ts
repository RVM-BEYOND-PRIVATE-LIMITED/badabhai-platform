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

// ---------------------------------------------------------------------------
// getResumeFields / updateResumePrefs — the worker-editable resume "safe fields"
// ---------------------------------------------------------------------------

function resumeFieldsSetup(
  worker:
    | { id: string; fullName: string | null; resumeShowPhoto: boolean; resumeNightShiftReady: boolean }
    | undefined,
  updatedRow?: unknown,
) {
  const repo = {
    findById: vi.fn(async (_id: string) => worker),
    updateResumePrefs: vi.fn(async (_id: string, _patch: unknown) => updatedRow),
  };
  const pii = {
    encrypt: vi.fn(),
    // decrypt maps the stored ciphertext token back to a readable name
    decrypt: vi.fn((_token: string) => NAME),
  };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const svc = new WorkersService(
    repo as unknown as WorkersRepository,
    pii as unknown as PiiCryptoService,
    events as unknown as EventsService,
  );
  return { svc, repo, pii, events };
}

describe("WorkersService.getResumeFields", () => {
  it("decrypts and returns the worker's OWN name + prefs; emits NO event (read)", async () => {
    const { svc, pii, events } = resumeFieldsSetup({
      id: "w-1",
      fullName: TOKEN,
      resumeShowPhoto: true,
      resumeNightShiftReady: true,
    });
    const res = await svc.getResumeFields("w-1");

    expect(pii.decrypt).toHaveBeenCalledWith(TOKEN); // the stored ciphertext, not a name
    expect(res).toEqual({ full_name: NAME, show_photo: true, night_shift_ready: true });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("returns full_name null (and never decrypts) when no name is set", async () => {
    const { svc, pii } = resumeFieldsSetup({
      id: "w-1",
      fullName: null,
      resumeShowPhoto: false,
      resumeNightShiftReady: false,
    });
    const res = await svc.getResumeFields("w-1");
    expect(res).toEqual({ full_name: null, show_photo: false, night_shift_ready: false });
    expect(pii.decrypt).not.toHaveBeenCalled();
  });

  it("throws NotFound for an unknown worker", async () => {
    const { svc } = resumeFieldsSetup(undefined);
    await expect(svc.getResumeFields("missing")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("DEGRADES name-less (never throws) when decrypt fails — corrupt/legacy-plaintext row", async () => {
    const { svc, pii, events } = resumeFieldsSetup({
      id: "w-1",
      fullName: TOKEN,
      resumeShowPhoto: true,
      resumeNightShiftReady: false,
    });
    // A corrupt / wrong-key / legacy-plaintext token: decryptPii throws.
    pii.decrypt = vi.fn(() => {
      throw new Error("decrypt failed"); // must NOT leak to the client or crash the edit screen
    });

    const res = await svc.getResumeFields("w-1");

    // Fails closed: name-less, prefs intact, no event, no re-throw.
    expect(res).toEqual({ full_name: null, show_photo: true, night_shift_ready: false });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("WorkersService.updateResumePrefs", () => {
  const WORKER = {
    id: "w-1",
    fullName: TOKEN,
    resumeShowPhoto: true,
    resumeNightShiftReady: false,
  };

  it("maps the dto to repo fields and emits the RESULTING values (PII-free)", async () => {
    // repo returns the post-update row: show_photo flipped off, night-shift on
    const updated = { ...WORKER, resumeShowPhoto: false, resumeNightShiftReady: true };
    const { svc, repo, events } = resumeFieldsSetup(WORKER, updated);

    const res = await svc.updateResumePrefs(
      "w-1",
      { show_photo: false, night_shift_ready: true },
      CTX,
    );

    expect(repo.updateResumePrefs).toHaveBeenCalledWith("w-1", {
      resumeShowPhoto: false,
      resumeNightShiftReady: true,
    });
    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.event_name).toBe("worker.resume_prefs_updated");
    expect(emitArg.payload).toEqual({
      worker_id: "w-1",
      show_photo: false,
      night_shift_ready: true,
    });
    // no name/phone/ciphertext anywhere in the emitted event
    expect(JSON.stringify(emitArg)).not.toMatch(/Asha|ciphertext|phone|full_?name/i);
    expect(res).toEqual({ worker_id: "w-1" });
  });

  it("emits only the resulting flags even on a partial patch (one flag)", async () => {
    const updated = { ...WORKER, resumeShowPhoto: false };
    const { svc, repo, events } = resumeFieldsSetup(WORKER, updated);

    await svc.updateResumePrefs("w-1", { show_photo: false }, CTX);

    // only the provided flag is written (night-shift stays undefined in the patch)
    expect(repo.updateResumePrefs).toHaveBeenCalledWith("w-1", {
      resumeShowPhoto: false,
      resumeNightShiftReady: undefined,
    });
    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.payload).toEqual({
      worker_id: "w-1",
      show_photo: false,
      night_shift_ready: false, // read back from the (unchanged) row
    });
  });

  it("throws NotFound for an unknown worker — no write, no event", async () => {
    const { svc, repo, events } = resumeFieldsSetup(undefined);
    await expect(
      svc.updateResumePrefs("missing", { show_photo: true }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.updateResumePrefs).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
