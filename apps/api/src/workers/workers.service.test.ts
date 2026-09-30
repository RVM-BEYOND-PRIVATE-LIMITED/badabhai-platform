import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { BadaBhaiEvent } from "@badabhai/event-schema";
import { WorkersService } from "./workers.service";
import type { WorkersRepository } from "./workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import type { EventsRepository } from "../events/events.repository";
import type { StorageService } from "../storage/storage.service";
import type { RequestContext } from "../common/request-context";
import type { Queue } from "bullmq";
import type { ResumeRenderJobData } from "../queue/queue.constants";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const NAME = "Asha Kumari";
/** TD77: the worker's latest resume — the target of a forced presentation re-render. */
const RESUME_ID = "3c4d5e6f-3333-4333-8333-000000000003";
const TOKEN = "v1.opaqueciphertext"; // encrypt() output — must NOT contain the name
/** The worker-self name route (PATCH /workers/me/name) — the only one that counts as a résumé edit. */
const SELF = { origin: "worker_self" } as const;

/**
 * #1803 — the transaction token a pass-through `withTransaction` hands to its callback. The
 * erasure paths must pass THIS to both the write and the sibling emit; the rollback semantics
 * themselves are proven by the staging-world harness at the end of this file.
 */
const FAKE_TX = { __fakeTx: true } as const;

/** A `withTransaction` that just runs the callback on {@link FAKE_TX} (no rollback modelled). */
function passThroughTx() {
  return vi.fn(async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(FAKE_TX));
}

/** Default storage mock — every method resolves happily; override per test. */
function mockStorage() {
  return {
    createSignedUploadUrl: vi.fn(async (_key: string, _bucket?: string) => ({
      url: "https://storage.example/signed-upload?token=SIGNED_UPLOAD_TOKEN",
      expiresIn: 7200,
    })),
    createSignedUrl: vi.fn(
      async (_key: string, _ttl: number, _bucket?: string) =>
        "https://storage.example/signed-read?token=SIGNED_READ_TOKEN",
    ),
    getObjectInfo: vi.fn(
      async (
        _key: string,
        _bucket?: string,
      ): Promise<{ contentType: string | null; sizeBytes: number | null } | null> => ({
        contentType: "image/jpeg",
        sizeBytes: 500_000,
      }),
    ),
    deletePdf: vi.fn(async (_key: string, _bucket?: string) => undefined),
  };
}

/** ADR-0032 config surface: photo bucket armed by default; tests unset it to prove 503. */
function mockConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    WORKER_PHOTOS_BUCKET: "worker-profile-photos",
    RESUME_SIGNED_URL_TTL_SECONDS: 900,
    ...overrides,
  } as ServerConfig;
}

/** TD77 render queue: the forced re-render producer. Assert `add` per test. */
function mockRenderQueue() {
  return {
    add: vi.fn(
      async (_name: string, _data: ResumeRenderJobData, _opts?: Record<string, unknown>) => ({
        id: "job-1",
      }),
    ),
    // ADR-0043 — the erasure fan-out asks whether a keyed job for an older résumé exists, and in
    // which state. Default: none, so every older résumé gets its first slot.
    getJob: vi.fn(
      async (_id: string) => undefined as { getState: () => Promise<string> } | undefined,
    ),
  };
}

function newSvc(
  repo: unknown,
  pii: unknown,
  events: unknown,
  storage: unknown = mockStorage(),
  config: ServerConfig = mockConfig(),
  renderQueue: unknown = mockRenderQueue(),
) {
  return new WorkersService(
    repo as WorkersRepository,
    pii as PiiCryptoService,
    events as EventsService,
    storage as StorageService,
    config,
    renderQueue as unknown as Queue<ResumeRenderJobData>,
  );
}

function setup(workerExists = true) {
  const repo = {
    findById: vi.fn(async (_id: string) =>
      workerExists ? { id: "w-1", fullName: null } : undefined,
    ),
    updateFullName: vi.fn(async (_id: string, _token: string) => ({ id: "w-1" })),
    updateLocation: vi.fn(async (_id: string, _patch: unknown) => ({ id: "w-1" })),
    // The name is baked onto the PDF at render time, so setFullName re-renders the
    // latest resume in place (TD77 parity with updateResumePrefs).
    latestResume: vi.fn(async (_id: string) => ({ id: "res-1", version: 1 })),
    // ADR-0043 — the erasure fan-out's read. No older rendered entries by default.
    listErasureTargetIds: vi.fn(async (_id: string) => ["res-1"]),
  };
  const pii = { encrypt: vi.fn((_plaintext: string) => TOKEN) };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const renderQueue = mockRenderQueue();
  const svc = newSvc(repo, pii, events, mockStorage(), mockConfig(), renderQueue);
  return { svc, repo, pii, events, renderQueue };
}

describe("WorkersService.setFullName (TD21)", () => {
  it("encrypts the name before storing — a plaintext name is never persisted", async () => {
    const { svc, repo, pii } = setup();
    await svc.setFullName("w-1", NAME, CTX, SELF);

    expect(pii.encrypt).toHaveBeenCalledWith(NAME);
    expect(repo.updateFullName).toHaveBeenCalledWith("w-1", TOKEN);
    // the value handed to the DB is the ciphertext token, not the name
    expect(repo.updateFullName.mock.calls[0]![1]).not.toContain("Asha");
  });

  it("emits a PII-free worker.name_recorded event (no name) and returns only worker_id", async () => {
    const { svc, events } = setup();
    const res = await svc.setFullName("w-1", NAME, CTX, SELF);

    expect(res).toEqual({ worker_id: "w-1" });
    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.event_name).toBe("worker.name_recorded");
    expect(emitArg.payload).toEqual({ worker_id: "w-1" });
    // the name must appear NOWHERE in the emitted event
    expect(JSON.stringify(emitArg)).not.toMatch(/Asha/i);
  });

  it("throws NotFound for an unknown worker — no write, no event", async () => {
    const { svc, repo, events } = setup(false);
    await expect(svc.setFullName("missing", NAME, CTX, SELF)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.updateFullName).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("re-renders the latest resume PDF in place so a name change reaches the download (TD77)", async () => {
    const { svc, renderQueue } = setup();
    await svc.setFullName("w-1", NAME, CTX, SELF);
    // The name is decrypted live in the render worker, so a forced in-place re-render
    // rebuilds the PDF with the new name — without it the downloaded PDF keeps the old
    // name (the app defers to this server-side re-render and never regenerates on edit).
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: "res-1", workerId: "w-1", force: true }),
    );
  });

  it("skips the re-render when the worker has no resume yet — the first generate picks the name up", async () => {
    const { svc, repo, renderQueue } = setup();
    repo.latestResume.mockResolvedValueOnce(undefined as never);
    await svc.setFullName("w-1", NAME, CTX, SELF);
    expect(renderQueue.add).not.toHaveBeenCalled();
  });
});

describe("the idempotency key (ADR-0048) — the chat intake's, and ONLY the chat intake's", () => {
  // The identity intake writes before a CAS that can be lost and re-run, so it passes a key per
  // session; the two HTTP routes pass none and must record every save exactly as before — an
  // emit carrying an `idempotencyKey: undefined` field would be a changed call for them.
  it("setFullName: carries the key when given, and no key field at all when not", async () => {
    const keyed = setup();
    await keyed.svc.setFullName("w-1", NAME, CTX, { ...SELF, idempotencyKey: "k-name" });
    expect((keyed.events.emit.mock.calls[0]![0] as Record<string, unknown>).idempotencyKey).toBe(
      "k-name",
    );
    const plain = setup();
    await plain.svc.setFullName("w-1", NAME, CTX, SELF);
    expect("idempotencyKey" in (plain.events.emit.mock.calls[0]![0] as object)).toBe(false);
  });

  it("setLocation: carries the key when given, and no key field at all when not", async () => {
    const keyed = setup();
    await keyed.svc.setLocation("w-1", { city: "Patna" }, CTX, { idempotencyKey: "k-loc" });
    expect((keyed.events.emit.mock.calls[0]![0] as Record<string, unknown>).idempotencyKey).toBe(
      "k-loc",
    );
    const plain = setup();
    await plain.svc.setLocation("w-1", { city: "Patna" }, CTX);
    expect("idempotencyKey" in (plain.events.emit.mock.calls[0]![0] as object)).toBe(false);
  });
});

describe("WorkersService.setLocation (#1428)", () => {
  it("stores city and state as PLAINTEXT — the PII crypto is not involved", async () => {
    // The inverse of the assertion on setFullName above, and deliberately so. Owner ruling
    // 2026-07-31 puts a city outside the identity classes ("cities as PII -> a 20-point matching
    // input; never redact"); encrypting it would destroy the matching signal that is the only
    // reason to store it, and would be encrypting something the platform has ruled is not
    // identity. If someone "hardens" this by routing it through pii.encrypt, this goes red.
    const { svc, repo, pii } = setup();
    await svc.setLocation("w-1", { city: "Patna", state: "Bihar" }, CTX);

    expect(pii.encrypt).not.toHaveBeenCalled();
    expect(repo.updateLocation).toHaveBeenCalledWith("w-1", {
      currentCity: "Patna",
      currentState: "Bihar",
    });
  });

  it("emits city_recorded/state_recorded and NEVER the values themselves", async () => {
    // A city is not an identifier, but a city plus a state plus a worker id plus a timestamp
    // narrows a person considerably — the same reasoning `worker.employment_recorded` records for
    // its own city, and `worker-preferences.service.ts` states as "COUNTS, NEVER THE ANSWERS".
    const { svc, events } = setup();
    await svc.setLocation("w-1", { city: "Patna", state: "Bihar" }, CTX);

    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.event_name).toBe("worker.location_recorded");
    expect(emitArg.payload).toEqual({
      worker_id: "w-1",
      city_recorded: true,
      state_recorded: true,
    });
    expect(JSON.stringify(emitArg)).not.toMatch(/Patna|Bihar/i);
  });

  it("ACCEPTS a city the gazetteer has never heard of, verbatim", async () => {
    // THE PRODUCT DECISION THIS LOCKS. `preferred_cities` 400s on anything outside the 36-value
    // closed set (#1406) — correct for a finishing-form field a worker reaches after committing.
    // This is screen ONE of onboarding, and the gazetteer is a closed set of manufacturing hubs,
    // so applying the same rule here would refuse a worker in Patna at the first thing the
    // product ever asks him — about the name of the place he lives, which he is not wrong about.
    const { svc, repo } = setup();
    await svc.setLocation("w-1", { city: "Muzaffarpur" }, CTX);
    expect(repo.updateLocation).toHaveBeenCalledWith("w-1", { currentCity: "Muzaffarpur" });
  });

  it("canonicalises a spelling the gazetteer DOES know, so the hubs stay comparable", async () => {
    // "poona" and "PUNE" must land on the one spelling `preferred_cities` and the résumé already
    // use — otherwise the same city is three strings and nothing can be compared to anything.
    const { svc, repo } = setup();
    await svc.setLocation("w-1", { city: "poona", state: "maharashtra" }, CTX);
    expect(repo.updateLocation).toHaveBeenCalledWith("w-1", {
      currentCity: "Pune",
      currentState: "Maharashtra",
    });
  });

  it("writes and emits NOTHING when neither half is present", async () => {
    // setFullName is the caller and a name-only PATCH is the common case — the pre-#1428 request
    // shape, which must stay byte-identical in effect.
    const { svc, repo, events } = setup();
    await svc.setLocation("w-1", {}, CTX);
    expect(repo.updateLocation).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("writes only the half that was given", async () => {
    const { svc, repo, events } = setup();
    await svc.setLocation("w-1", { state: "Bihar" }, CTX);
    expect(repo.updateLocation).toHaveBeenCalledWith("w-1", { currentState: "Bihar" });
    const payload = (events.emit.mock.calls[0]![0] as Record<string, unknown>).payload;
    expect(payload).toEqual({ worker_id: "w-1", city_recorded: false, state_recorded: true });
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
  // Task 1 — a real column now (not a sentinel): the road is projected as-is.
  source: "chat",
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

function summarySetup(profile: unknown, workerOverrides: Record<string, unknown> = {}) {
  const worker = { id: "w-1", photoStorageKey: null, ...workerOverrides };
  const repo = {
    latestProfile: vi.fn(async (_workerId: string) => profile),
    findById: vi.fn(async (_id: string) => worker),
  };
  const pii = { encrypt: vi.fn() };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const svc = newSvc(repo, pii, events);
  return { svc, repo, events };
}

describe("WorkersService.getProfileSummary (TD54)", () => {
  it('returns the "none" summary when the worker has no profile row', async () => {
    const { svc } = summarySetup(undefined);
    const res = await svc.getProfileSummary("w-1");
    expect(res).toEqual({
      profile_status: "none",
      source: null,
      confirmed_at: null,
      trade: { canonical_trade_id: null, canonical_role_id: null, display_name: null },
      city: null,
      strength: 0,
      strength_max: 9,
      missing_fields: [
        "role",
        "trade",
        "skills",
        "machines",
        "experience",
        "salary",
        "location",
        "availability",
        "photo",
      ],
      skills: [],
      machines: [],
      experience_years: null,
      education_level: null,
      education_field: null,
      has_photo: false,
    });
  });

  it("maps a full confirmed profile: status, ISO confirmed_at, trade ids + taxonomy display_name, first city, hand-computed strength", async () => {
    const { svc } = summarySetup(CONFIRMED_PROFILE, {
      photoStorageKey: "photos/w-1/face.jpg",
    });
    const res = await svc.getProfileSummary("w-1");
    expect(res).toEqual({
      profile_status: "confirmed",
      source: "chat",
      confirmed_at: "2026-07-01T10:00:00.000Z",
      trade: {
        canonical_trade_id: "cnc_vmc",
        canonical_role_id: "role_vmc_operator",
        display_name: "VMC Operator", // getRole("role_vmc_operator").name
      },
      city: "pune", // preferred_cities[0]
      // countFields recompute: role(1) + trade(1) + skills(2) + machines(1)
      // + total_years(1) + salary(1) + cities(1) + availability(1) + photo(1) = 10
      strength: 10,
      strength_max: 9,
      missing_fields: [],
      // Additive projections (skill_*/mach_* ids resolved to display NAMES — the
      // resume tab must never show a raw id; only the NUMBER of experience is
      // surfaced, never the free-text summary).
      skills: ["Fanuc control operation", "Micrometer / Vernier / gauge usage"],
      machines: ["Vertical Machining Center (VMC)"],
      experience_years: 4,
      // CONFIRMED_PROFILE.rawProfile carries no education keys → both null.
      education_level: null,
      education_field: null,
      has_photo: true,
    });
  });

  it("projects skills/machines LABELS + experience YEARS only — never the free-text experience.summary (§2), and narrows malformed JSONB", async () => {
    const { svc } = summarySetup({
      ...CONFIRMED_PROFILE,
      // Dirty inputs the mapper must narrow, not trust:
      skills: ["  cnc operating  ", 42, "", null, "gd&t"], // trim; drop non-strings/blanks
      machines: "not-an-array", // non-array ⇒ []
      experience: { total_years: 6.5, summary: "Ramesh Industries Pvt Ltd (employer PII)" },
    });
    const res = await svc.getProfileSummary("w-1");
    expect(res.skills).toEqual(["cnc operating", "gd&t"]);
    expect(res.machines).toEqual([]);
    expect(res.experience_years).toBe(6.5);
    // The free-text summary can carry §2 employer PII — it must NEVER reach the wire.
    expect(res).not.toHaveProperty("experience");
    expect(JSON.stringify(res)).not.toContain("employer PII");
  });

  it("malformed/empty location_preference JSONB ⇒ city null, no throw", async () => {
    for (const locationPreference of [{}, { preferred_cities: "notarray" }, null, "pune"]) {
      const { svc } = summarySetup({ ...CONFIRMED_PROFILE, locationPreference });
      const res = await svc.getProfileSummary("w-1");
      expect(res.city).toBeNull();
      // cities(0) + photo(0 — no photo on default worker) ⇒ 8
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

  it("surfaces education_level/education_field out of raw_profile JSONB (non-column, defensively narrowed)", async () => {
    const { svc } = summarySetup({
      ...CONFIRMED_PROFILE,
      rawProfile: { education_level: "  12th  ", education_field: "Electronics", note: "ignored" },
    });
    const res = await svc.getProfileSummary("w-1");
    expect(res.education_level).toBe("12th"); // trimmed
    expect(res.education_field).toBe("Electronics");
  });

  it("malformed/missing education fields in raw_profile ⇒ null, never a throw", async () => {
    for (const rawProfile of [
      {},
      { education_level: 42, education_field: "" },
      null,
      "not-an-object",
    ]) {
      const { svc } = summarySetup({ ...CONFIRMED_PROFILE, rawProfile });
      const res = await svc.getProfileSummary("w-1");
      expect(res.education_level).toBeNull();
      expect(res.education_field).toBeNull();
    }
  });

  it("projects the road as-is, and maps unknown/pre-0107 roads to null (never a guess)", async () => {
    const { svc } = summarySetup({ ...CONFIRMED_PROFILE, source: "form" });
    expect((await svc.getProfileSummary("w-1")).source).toBe("form");

    // A pre-0107 row carries no source key at all; a corrupt one carries garbage.
    // Both project to null (unknown) — the mapper never invents a road.
    for (const source of [undefined, null, "", "FORM", "trade_form", 42]) {
      const row: Record<string, unknown> = { ...CONFIRMED_PROFILE };
      if (source === undefined) delete row.source;
      else row.source = source;
      const { svc: s } = summarySetup(row);
      expect((await s.getProfileSummary("w-1")).source).toBeNull();
    }
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
    | {
        id: string;
        fullName: string | null;
        resumeShowPhoto: boolean;
        resumeNightShiftReady: boolean;
        photoStorageKey?: string | null;
      }
    | undefined,
  updatedRow?: unknown,
) {
  const repo = {
    findById: vi.fn(async (_id: string) => worker),
    withTransaction: passThroughTx(),
    updateResumePrefs: vi.fn(async (_id: string, _patch: unknown, _tx?: unknown) => updatedRow),
    // TD77: a show_photo flip re-renders the worker's LATEST resume.
    latestResume: vi.fn(async (_id: string) => ({ id: RESUME_ID, version: 1 })),
    // ADR-0043 — the erasure fan-out's read. No older rendered entries by default.
    listErasureTargetIds: vi.fn(async (_id: string) => [RESUME_ID]),
  };
  const pii = {
    encrypt: vi.fn(),
    // decrypt maps the stored ciphertext token back to a readable name
    decrypt: vi.fn((_token: string) => NAME),
  };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const renderQueue = mockRenderQueue();
  const svc = newSvc(repo, pii, events, mockStorage(), mockConfig(), renderQueue);
  return { svc, repo, pii, events, renderQueue };
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
    expect(res).toEqual({
      full_name: NAME,
      show_photo: true,
      night_shift_ready: true,
      has_photo: false,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("has_photo is a boolean projection of the pointer — NEVER the key itself", async () => {
    const { svc } = resumeFieldsSetup({
      id: "w-1",
      fullName: null,
      resumeShowPhoto: true,
      resumeNightShiftReady: false,
      photoStorageKey: "photos/w-1/0a1b2c3d-0000-4000-8000-000000000000.jpg",
    });
    const res = await svc.getResumeFields("w-1");
    expect(res.has_photo).toBe(true);
    // the opaque key must not leak into the response in any field
    expect(JSON.stringify(res)).not.toContain("photos/w-1");
  });

  it("returns full_name null (and never decrypts) when no name is set", async () => {
    const { svc, pii } = resumeFieldsSetup({
      id: "w-1",
      fullName: null,
      resumeShowPhoto: false,
      resumeNightShiftReady: false,
    });
    const res = await svc.getResumeFields("w-1");
    expect(res).toEqual({
      full_name: null,
      show_photo: false,
      night_shift_ready: false,
      has_photo: false,
    });
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
    expect(res).toEqual({
      full_name: null,
      show_photo: true,
      night_shift_ready: false,
      has_photo: false,
    });
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

    expect(repo.updateResumePrefs).toHaveBeenCalledWith(
      "w-1",
      { resumeShowPhoto: false, resumeNightShiftReady: true },
      FAKE_TX, // #1803 — on the same transaction as the sibling emit
    );
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
    expect(repo.updateResumePrefs).toHaveBeenCalledWith(
      "w-1",
      { resumeShowPhoto: false, resumeNightShiftReady: undefined },
      FAKE_TX,
    );
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

  // TD77 — the "Photo dikhayein" toggle decides whether the photo is ON the PDF,
  // so a REAL flip has to re-render it; a no-op save must not cost a render.
  /** A worker who actually HAS a photo — the only case where the toggle changes the PDF. */
  const WORKER_WITH_PHOTO = { ...WORKER, photoStorageKey: "photos/w-1/p.jpg" };

  it("TD77: toggling show_photo OFF forces a FAIL-CLOSED re-render (face off the PDF)", async () => {
    const updated = { ...WORKER_WITH_PHOTO, resumeShowPhoto: false };
    const { svc, renderQueue } = resumeFieldsSetup(WORKER_WITH_PHOTO, updated);

    await svc.updateResumePrefs("w-1", { show_photo: false }, CTX);

    expect(renderQueue.add).toHaveBeenCalledWith("render", {
      resumeId: RESUME_ID,
      workerId: "w-1",
      force: true,
      failClosed: true,
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
  });

  it("TD77: toggling show_photo ON forces a degrade-open re-render", async () => {
    const off = { ...WORKER_WITH_PHOTO, resumeShowPhoto: false };
    const updated = { ...WORKER_WITH_PHOTO, resumeShowPhoto: true };
    const { svc, renderQueue } = resumeFieldsSetup(off, updated);

    await svc.updateResumePrefs("w-1", { show_photo: true }, CTX);

    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ force: true, failClosed: false }),
    );
  });

  it("#947: flipping night_shift_ready re-renders — it now decides PDF content", async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and asserting the opposite was correct until #947:
    // `resume_night_shift_ready` changed nothing on the page, so re-rendering for it would have
    // burned a render that could not alter a byte. Now the toggle rides the `{{availability}}`
    // line, and the old assertion had become the defect — a worker who already had a résumé has
    // `render_status: "rendered"`, `ResumeRenderProcessor` skips those without `force`, so the
    // line they had just asked for reached them never. The payer disclosure renders fresh every
    // time, so the employer would have seen it while the worker still could not.
    const updated = { ...WORKER_WITH_PHOTO, resumeNightShiftReady: true };
    const { svc, renderQueue } = resumeFieldsSetup(WORKER_WITH_PHOTO, updated);

    await svc.updateResumePrefs("w-1", { night_shift_ready: true }, CTX);

    expect(renderQueue.add).toHaveBeenCalledWith(
      expect.anything(),
      // `force`, or the processor skips an already-rendered résumé and the flip is stranded.
      // `failClosed: false` — unlike hiding a photo, nothing here erases PII from a document, so
      // a failed re-render costs a stale line and never a leak.
      expect.objectContaining({ force: true, failClosed: false }),
    );
  });

  it("TD77: a PATCH that changes neither pref does not re-render (no wasted render)", async () => {
    // The no-waste guarantee the test above used to carry, kept and made honest: both prefs are
    // byte-identical before and after, so the PDF cannot change and no render may be spent. The
    // gate compares before-vs-after rather than reading which keys the body happened to carry,
    // which is what makes a re-PATCH of the same values free.
    const { svc, renderQueue } = resumeFieldsSetup(WORKER_WITH_PHOTO, { ...WORKER_WITH_PHOTO });

    await svc.updateResumePrefs(
      "w-1",
      {
        show_photo: WORKER_WITH_PHOTO.resumeShowPhoto,
        night_shift_ready: WORKER_WITH_PHOTO.resumeNightShiftReady,
      },
      CTX,
    );

    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("TD77: flipping show_photo with NO photo on file does not re-render", async () => {
    // Nothing to show or hide → the PDF would be byte-identical.
    const updated = { ...WORKER, resumeShowPhoto: false };
    const { svc, renderQueue } = resumeFieldsSetup(WORKER, updated);

    await svc.updateResumePrefs("w-1", { show_photo: false }, CTX);

    expect(renderQueue.add).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADR-0032 — the profile-photo seam (mint / confirm / read-url / delete)
// ---------------------------------------------------------------------------

const WORKER_ID = "0a1b2c3d-1111-4111-8111-000000000001";
const MINTED_KEY = `photos/${WORKER_ID}/9f8e7d6c-2222-4222-8222-000000000002.jpg`;

function photoSetup(
  opts: {
    worker?: { id: string; photoStorageKey?: string | null; resumeShowPhoto?: boolean } | undefined;
    bucket?: string;
    info?: { contentType: string | null; sizeBytes: number | null } | null;
    /** TD77: omit for "worker has a resume"; pass undefined for "no resume yet". */
    latestResume?: { id: string; version: number } | undefined;
    /** TD77: override to prove the re-render enqueue is best-effort. */
    renderQueue?: { add: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn> };
    /** ADR-0043: OLDER rendered résumés the worker also owns — the erasure fan-out's targets. */
    olderRendered?: string[];
  } = {},
) {
  const worker =
    "worker" in opts
      ? opts.worker
      : { id: WORKER_ID, fullName: null, resumeShowPhoto: true, photoStorageKey: null };
  const latestResume = "latestResume" in opts ? opts.latestResume : { id: RESUME_ID, version: 1 };
  const repo = {
    findById: vi.fn(async (_id: string) => worker),
    withTransaction: passThroughTx(),
    updatePhotoStorageKey: vi.fn(async (_id: string, key: string | null, _tx?: unknown) =>
      worker ? { ...worker, photoStorageKey: key } : undefined,
    ),
    latestResume: vi.fn(async (_id: string) => latestResume),
    listErasureTargetIds: vi.fn(async (_id: string) => [
      ...(latestResume ? [latestResume.id] : []),
      ...(opts.olderRendered ?? []),
    ]),
  };
  const pii = { encrypt: vi.fn(), decrypt: vi.fn() };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const storage = mockStorage();
  if ("info" in opts) {
    storage.getObjectInfo = vi.fn(async () => opts.info ?? null);
  }
  const config = mockConfig(
    "bucket" in opts ? ({ WORKER_PHOTOS_BUCKET: opts.bucket } as Partial<ServerConfig>) : {},
  );
  const renderQueue = opts.renderQueue ?? mockRenderQueue();
  const svc = newSvc(repo, pii, events, storage, config, renderQueue);
  return { svc, repo, events, storage, renderQueue };
}

describe("WorkersService.createPhotoUploadUrl (ADR-0032)", () => {
  it("503s fail-closed while WORKER_PHOTOS_BUCKET is unset — storage is never touched", async () => {
    const { svc, storage } = photoSetup({ bucket: "" });
    await expect(svc.createPhotoUploadUrl(WORKER_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("mints a SERVER-chosen opaque key under the caller's own prefix; emits NO event", async () => {
    const { svc, storage, events } = photoSetup();
    const res = await svc.createPhotoUploadUrl(WORKER_ID);

    const [key, bucket] = storage.createSignedUploadUrl.mock.calls[0]!;
    expect(key).toMatch(new RegExp(`^photos/${WORKER_ID}/[0-9a-f-]{36}\\.jpg$`));
    expect(bucket).toBe("worker-profile-photos");
    expect(res).toEqual({
      storage_path: key,
      upload_url: "https://storage.example/signed-upload?token=SIGNED_UPLOAD_TOKEN",
      expires_in: 7200,
    });
    // minting is an authorization grant, not a state change (§1)
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe("WorkersService.confirmPhoto (ADR-0032)", () => {
  it("rejects a storage_path outside the caller's own minted-key shape (anti-forgery) BEFORE touching storage", async () => {
    const { svc, storage, events } = photoSetup();
    for (const forged of [
      `photos/other-worker/9f8e7d6c-2222-4222-8222-000000000002.jpg`, // someone else's prefix
      `resumes/${WORKER_ID}/sneaky.jpg`, // wrong root
      `photos/${WORKER_ID}/not-a-uuid.jpg`, // not a minted uuid
      `photos/${WORKER_ID}/9f8e7d6c-2222-4222-8222-000000000002.png`, // wrong extension
    ]) {
      await expect(
        svc.confirmPhoto(WORKER_ID, { storage_path: forged }, CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(storage.getObjectInfo).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("400s when the object was never uploaded (info 404) — no pointer write, no event", async () => {
    const { svc, repo, events } = photoSetup({ info: null });
    await expect(
      svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.updatePhotoStorageKey).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("400s + best-effort deletes an out-of-policy object (wrong mime / oversize / missing metadata)", async () => {
    for (const info of [
      { contentType: "application/pdf", sizeBytes: 1000 }, // wrong type
      { contentType: "image/jpeg", sizeBytes: 3 * 1024 * 1024 }, // oversize
      { contentType: null, sizeBytes: 1000 }, // missing mime → fail closed
      { contentType: "image/jpeg", sizeBytes: null }, // missing size → fail closed
    ]) {
      const { svc, repo, storage, events } = photoSetup({ info });
      await expect(
        svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      // the offending object is cleaned up; the pointer is never written
      expect(storage.deletePdf).toHaveBeenCalledWith(MINTED_KEY, "worker-profile-photos");
      expect(repo.updatePhotoStorageKey).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    }
  });

  it("persists the pointer + emits a PII-free worker.photo_uploaded (worker_id ONLY — never key/URL)", async () => {
    const { svc, repo, events } = photoSetup();
    const res = await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);

    expect(repo.updatePhotoStorageKey).toHaveBeenCalledWith(WORKER_ID, MINTED_KEY);
    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.event_name).toBe("worker.photo_uploaded");
    expect(emitArg.payload).toEqual({ worker_id: WORKER_ID });
    // the object key / any URL must appear NOWHERE in the event
    expect(JSON.stringify(emitArg)).not.toMatch(/photos\/|https?:|token/i);
    expect(res).toEqual({ worker_id: WORKER_ID, has_photo: true });
  });

  // TD77 — the resume PDF is rendered when the profile is confirmed, i.e. BEFORE
  // a photo exists. Without a FORCED re-render the processor's "already rendered
  // → skip" guard means the photo never reaches the PDF from either entry point.
  it("TD77: forces a re-render so the new photo lands on the existing resume PDF", async () => {
    const { svc, renderQueue } = photoSetup();
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);

    expect(renderQueue.add).toHaveBeenCalledWith("render", {
      resumeId: RESUME_ID,
      workerId: WORKER_ID,
      force: true,
      // ADD direction: a failed refresh may degrade open (keep the old PDF).
      failClosed: false,
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
    // refs only — no key/name/bytes are ever enqueued
    const jobData = JSON.stringify(renderQueue.add.mock.calls[0]![1]);
    expect(jobData).not.toMatch(/photos\/|https?:|Asha/i);
  });

  it("TD77: show_photo OFF → NO re-render (it could not change a byte of the PDF)", async () => {
    const { svc, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: null, resumeShowPhoto: false },
    });
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("TD77: no resume yet → nothing to re-render (the first generate picks the photo up)", async () => {
    const { svc, renderQueue } = photoSetup({ latestResume: undefined });
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("TD77: a re-render enqueue failure NEVER fails the photo upload (best-effort)", async () => {
    const renderQueue = {
      add: vi.fn(async () => {
        throw new Error("redis down");
      }),
      getJob: vi.fn(async () => undefined),
    };
    const { svc, repo } = photoSetup({ renderQueue });
    await expect(svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX)).resolves.toEqual({
      worker_id: WORKER_ID,
      has_photo: true,
    });
    // the pointer still persisted — the photo IS saved, only the re-render was lost
    expect(repo.updatePhotoStorageKey).toHaveBeenCalledWith(WORKER_ID, MINTED_KEY);
  });

  it("replacing a photo best-effort deletes the OLD object (and a failed delete never fails the confirm)", async () => {
    const OLD_KEY = `photos/${WORKER_ID}/00000000-3333-4333-8333-000000000003.jpg`;
    const { svc, storage } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: OLD_KEY },
    });
    storage.deletePdf = vi.fn(async () => {
      throw new Error("storage delete failed with status 500");
    });
    const res = await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(storage.deletePdf).toHaveBeenCalledWith(OLD_KEY, "worker-profile-photos");
    expect(res.has_photo).toBe(true); // the failed cleanup did not mask success
  });

  it("503s while dormant — nothing validated, nothing written", async () => {
    const { svc, repo } = photoSetup({ bucket: "" });
    await expect(
      svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(repo.updatePhotoStorageKey).not.toHaveBeenCalled();
  });
});

describe("WorkersService.getPhotoUrl (ADR-0032)", () => {
  it("returns a short-TTL signed READ url for the worker's OWN key; emits NO event", async () => {
    const { svc, storage, events } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY },
    });
    const res = await svc.getPhotoUrl(WORKER_ID);
    expect(storage.createSignedUrl).toHaveBeenCalledWith(MINTED_KEY, 900, "worker-profile-photos");
    expect(res).toEqual({
      url: "https://storage.example/signed-read?token=SIGNED_READ_TOKEN",
      expires_in: 900,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("404s when the worker has no photo (and for a missing worker — no oracle)", async () => {
    const noPhoto = photoSetup({ worker: { id: WORKER_ID, photoStorageKey: null } });
    await expect(noPhoto.svc.getPhotoUrl(WORKER_ID)).rejects.toBeInstanceOf(NotFoundException);
    const noWorker = photoSetup({ worker: undefined });
    await expect(noWorker.svc.getPhotoUrl(WORKER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("503s while dormant", async () => {
    const { svc } = photoSetup({ bucket: "" });
    await expect(svc.getPhotoUrl(WORKER_ID)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("WorkersService.deletePhoto (ADR-0032)", () => {
  it("IDEMPOTENT: no photo → 200-shape result, no write, NO event (nothing changed, §1)", async () => {
    const { svc, repo, events, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: null },
    });
    const res = await svc.deletePhoto(WORKER_ID, CTX);
    expect(res).toEqual({ worker_id: WORKER_ID, has_photo: false });
    expect(repo.updatePhotoStorageKey).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    // TD77: nothing changed → no re-render either
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("TD77: forces a FAIL-CLOSED re-render so the face comes OFF the resume PDF", async () => {
    const { svc, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY, resumeShowPhoto: true },
    });
    await svc.deletePhoto(WORKER_ID, CTX);
    expect(renderQueue.add).toHaveBeenCalledWith("render", {
      resumeId: RESUME_ID,
      workerId: WORKER_ID,
      force: true,
      // REMOVE direction: a terminal failure must NOT keep serving the erased face.
      failClosed: true,
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
  });

  // ADR-0043 — résumé history keeps every generation and serves any of them by id, so an erasure
  // that reached only the current PDF would leave the face on every older one.
  it("fans the FAIL-CLOSED erasure out: the current résumé as always, then EVERY older one, keyed", async () => {
    const OLDER = ["4d5e6f70-4444-4444-8444-000000000004", "5e6f7081-5555-4555-8555-000000000005"];
    const { svc, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY, resumeShowPhoto: true },
      olderRendered: OLDER,
    });
    await svc.deletePhoto(WORKER_ID, CTX);
    const calls = renderQueue.add.mock.calls as unknown as [
      string,
      ResumeRenderJobData,
      Record<string, unknown> | undefined,
    ][];
    // The current résumé's job first, byte-for-byte the one this path always enqueued.
    expect(calls[0]![1]).toMatchObject({ resumeId: RESUME_ID, force: true, failClosed: true });
    expect(calls[0]![2]).toBeUndefined();
    expect(calls.slice(1).map(([, data]) => data.resumeId)).toEqual(OLDER);
    for (const [name, data, opts] of calls.slice(1)) {
      expect(name).toBe("render");
      expect(data).toMatchObject({ workerId: WORKER_ID, force: true, failClosed: true });
      expect(opts).toEqual({
        jobId: `erasure-rerender:${data.resumeId}`,
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
  });

  it("COLLAPSES into a keyed job that has NOT STARTED — it will read the erased state (the load bound)", async () => {
    const OLDER = "4d5e6f70-4444-4444-8444-000000000004";
    const { svc, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY, resumeShowPhoto: true },
      olderRendered: [OLDER],
    });
    renderQueue.getJob.mockResolvedValue({ getState: async () => "waiting" });
    await svc.deletePhoto(WORKER_ID, CTX);
    // Only the current résumé's job; the older one is already waiting.
    expect(renderQueue.add).toHaveBeenCalledOnce();
  });

  it("NEVER collapses into a RUNNING job — it may have read the face before the erasure", async () => {
    const OLDER = "4d5e6f70-4444-4444-8444-000000000004";
    const { svc, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY, resumeShowPhoto: true },
      olderRendered: [OLDER],
    });
    renderQueue.getJob.mockImplementation(async (id: string) =>
      id === `erasure-rerender:${OLDER}` ? { getState: async () => "active" } : undefined,
    );
    await svc.deletePhoto(WORKER_ID, CTX);
    expect(renderQueue.add).toHaveBeenCalledTimes(2);
    expect(renderQueue.add.mock.calls[1]![2]).toMatchObject({
      jobId: `erasure-rerender:${OLDER}:next`,
    });
  });

  it("with BOTH slots running the erasure is enqueued UNKEYED — never dropped", async () => {
    const OLDER = "4d5e6f70-4444-4444-8444-000000000004";
    const { svc, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY, resumeShowPhoto: true },
      olderRendered: [OLDER],
    });
    renderQueue.getJob.mockResolvedValue({ getState: async () => "active" });
    await svc.deletePhoto(WORKER_ID, CTX);
    expect(renderQueue.add).toHaveBeenCalledTimes(2);
    expect(renderQueue.add.mock.calls[1]![1]).toMatchObject({ resumeId: OLDER, failClosed: true });
    expect(renderQueue.add.mock.calls[1]![2]).toBeUndefined();
  });

  it("a fan-out read that FAILS still leaves the current résumé's erasure enqueued", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { svc, repo, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY, resumeShowPhoto: true },
    });
    repo.listErasureTargetIds.mockRejectedValue(new Error("pg down"));
    await svc.deletePhoto(WORKER_ID, CTX);
    expect(renderQueue.add).toHaveBeenCalledOnce();
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, failClosed: true }),
    );
  });

  it("a COSMETIC re-render stays on the current résumé — history entries keep what they were made with", async () => {
    const { svc, repo, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: null, resumeShowPhoto: true },
      olderRendered: ["4d5e6f70-4444-4444-8444-000000000004"],
    });
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(repo.listErasureTargetIds).not.toHaveBeenCalled();
    expect(renderQueue.getJob).not.toHaveBeenCalled();
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, failClosed: false }),
    );
  });

  it("TD77: photo removed while show_photo was OFF → NO re-render (never was on the PDF)", async () => {
    const { svc, renderQueue } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY, resumeShowPhoto: false },
    });
    await svc.deletePhoto(WORKER_ID, CTX);
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("clears the pointer, deletes the object, and emits a PII-free worker.photo_removed", async () => {
    const { svc, repo, storage, events } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY },
    });
    const res = await svc.deletePhoto(WORKER_ID, CTX);

    expect(repo.updatePhotoStorageKey).toHaveBeenCalledWith(WORKER_ID, null, FAKE_TX);
    expect(storage.deletePdf).toHaveBeenCalledWith(MINTED_KEY, "worker-profile-photos");
    const emitArg = events.emit.mock.calls[0]![0] as Record<string, unknown>;
    expect(emitArg.event_name).toBe("worker.photo_removed");
    expect(emitArg.payload).toEqual({ worker_id: WORKER_ID });
    expect(JSON.stringify(emitArg)).not.toMatch(/photos\/|https?:/);
    expect(res).toEqual({ worker_id: WORKER_ID, has_photo: false });
  });

  it("DORMANCY never blocks data minimization: pointer clears even with the bucket unset (object delete skipped)", async () => {
    const { svc, repo, storage, events } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY },
      bucket: "",
    });
    const res = await svc.deletePhoto(WORKER_ID, CTX);
    expect(repo.updatePhotoStorageKey).toHaveBeenCalledWith(WORKER_ID, null, FAKE_TX);
    expect(storage.deletePdf).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalled(); // the pointer removal is a real state change
    expect(res.has_photo).toBe(false);
  });

  it("a failed object delete degrades (logged, prefix-sweepable) — the removal still succeeds + emits", async () => {
    const { svc, storage, events } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY },
    });
    storage.deletePdf = vi.fn(async () => {
      throw new Error("storage delete failed with status 500");
    });
    const res = await svc.deletePhoto(WORKER_ID, CTX);
    expect(res.has_photo).toBe(false);
    expect(events.emit).toHaveBeenCalled();
  });
});

/**
 * Layer A (a) / ADR-0042 D9 — the optional WhatsApp number.
 *
 * THE THREE PROPERTIES THAT MATTER: the plaintext never reaches the repository or the event;
 * the event carries only the resulting state; and clearing is fail-closed on the re-render
 * because it removes a value the worker asked to take off their sheet.
 */
describe("WorkersService.setWhatsapp / getWhatsapp (Layer A (a))", () => {
  const WHATSAPP = "+919876543210";

  function whatsappSetup(
    worker: Record<string, unknown> | null = { id: "w-1", whatsappEnc: null },
  ) {
    const repo = {
      findById: vi.fn(async (_id: string) => worker ?? undefined),
      withTransaction: passThroughTx(),
      updateWhatsapp: vi.fn(async (_id: string, _token: string | null, _tx?: unknown) => ({
        id: "w-1",
      })),
      latestResume: vi.fn(async (_id: string) => ({ id: "res-1", version: 1 })),
      listErasureTargetIds: vi.fn(async (_id: string) => ["res-1"]),
    };
    const pii = {
      encrypt: vi.fn((_plaintext: string) => "v1.encryptedwhatsapp"),
      decrypt: vi.fn((_token: string) => WHATSAPP),
    };
    const events = { emit: vi.fn(async (_e: unknown) => true) };
    const renderQueue = mockRenderQueue();
    const svc = newSvc(repo, pii, events, mockStorage(), mockConfig(), renderQueue);
    return { svc, repo, pii, events, renderQueue };
  }

  it("encrypts before storing, never persists or returns the plaintext", async () => {
    const { svc, repo, pii } = whatsappSetup();
    const res = await svc.setWhatsapp("w-1", { whatsapp: WHATSAPP }, CTX);
    expect(pii.encrypt).toHaveBeenCalledWith(WHATSAPP);
    expect(repo.updateWhatsapp).toHaveBeenCalledWith("w-1", "v1.encryptedwhatsapp", FAKE_TX);
    expect(JSON.stringify(res)).not.toContain(WHATSAPP);
    expect(res).toEqual({ worker_id: "w-1", has_whatsapp: true });
  });

  it("emits the resulting state only — never the number", async () => {
    const { svc, events } = whatsappSetup();
    await svc.setWhatsapp("w-1", { whatsapp: WHATSAPP }, CTX);
    expect(events.emit).toHaveBeenCalledTimes(1);
    const emitted = events.emit.mock.calls[0]?.[0] as { event_name: string; payload: unknown };
    expect(emitted.event_name).toBe("worker.whatsapp_recorded");
    expect(emitted.payload).toEqual({ worker_id: "w-1", has_whatsapp: true });
    expect(JSON.stringify(emitted)).not.toContain(WHATSAPP);
  });

  it("clears with null and re-renders fail-closed — the number must come off the PDF", async () => {
    const { svc, repo, events, renderQueue } = whatsappSetup({ id: "w-1", whatsappEnc: "v1.old" });
    const res = await svc.setWhatsapp("w-1", { whatsapp: null }, CTX);
    expect(repo.updateWhatsapp).toHaveBeenCalledWith("w-1", null, FAKE_TX);
    expect(res.has_whatsapp).toBe(false);
    const emitted = events.emit.mock.calls[0]?.[0] as { payload: unknown };
    expect(emitted.payload).toEqual({ worker_id: "w-1", has_whatsapp: false });
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ failClosed: true }),
    );
  });

  it("a same-state write is not an event and does not burn a re-render", async () => {
    const { svc, events, renderQueue } = whatsappSetup({ id: "w-1", whatsappEnc: "v1.same" });
    await svc.setWhatsapp("w-1", { whatsapp: WHATSAPP }, CTX);
    expect(events.emit).not.toHaveBeenCalled();
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("reads a stored number back decrypted", async () => {
    const { svc, pii } = whatsappSetup({ id: "w-1", whatsappEnc: "v1.stored" });
    await expect(svc.getWhatsapp("w-1")).resolves.toEqual({
      whatsapp: WHATSAPP,
      has_whatsapp: true,
    });
    expect(pii.decrypt).toHaveBeenCalledWith("v1.stored");
  });

  it("no number on file is an absence, not an error", async () => {
    const { svc, pii } = whatsappSetup({ id: "w-1", whatsappEnc: null });
    await expect(svc.getWhatsapp("w-1")).resolves.toEqual({
      whatsapp: null,
      has_whatsapp: false,
    });
    expect(pii.decrypt).not.toHaveBeenCalled();
  });

  it("a decrypt failure reports unreadable-on-file, never a fabricated absence", async () => {
    const { svc, pii } = whatsappSetup({ id: "w-1", whatsappEnc: "v1.rotated" });
    pii.decrypt.mockImplementation(() => {
      throw new Error("unknown kid");
    });
    await expect(svc.getWhatsapp("w-1")).resolves.toEqual({
      whatsapp: null,
      has_whatsapp: true,
    });
  });

  it("404s a missing worker on both surfaces", async () => {
    const { svc } = whatsappSetup(null);
    await expect(svc.getWhatsapp("gone")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setWhatsapp("gone", { whatsapp: null }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("WorkersService.backfillErasureRerenders (ADR-0043 launch gate)", () => {
  const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
  const T = (n: number) => ({
    resumeId: `00000000-0000-4000-8000-00000000000${n}`,
    workerId: `00000000-0000-4000-8000-0000000000a${n}`,
  });

  function backfillSetup(targets = [T(1), T(2)], stale = targets.length) {
    const repo = {
      listErasureBackfillTargets: vi.fn(async (_limit: number, _after: string | null) => targets),
      countErasureBackfillTargets: vi.fn(async () => stale),
    };
    const events = { emit: vi.fn(async (_e: unknown) => true) };
    const renderQueue = mockRenderQueue();
    const svc = newSvc(repo, {}, events, mockStorage(), mockConfig(), renderQueue);
    return { svc, repo, events, renderQueue };
  }

  it("a DRY RUN only counts — nothing queued, nothing emitted", async () => {
    const { svc, repo, events, renderQueue } = backfillSetup([T(1), T(2)], 7);
    const res = await svc.backfillErasureRerenders({ dryRun: true, limit: 100, after: null }, CTX);
    expect(res).toEqual({
      dry_run: true,
      stale: 7,
      batch: 2,
      enqueued: 0,
      failed: 0,
      next_after: null,
    });
    expect(repo.listErasureBackfillTargets).toHaveBeenCalledWith(100, null);
    expect(renderQueue.add).not.toHaveBeenCalled();
    expect(renderQueue.getJob).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("queues the ERASURE render — forced, fail-closed, in the résumé's erasure slot", async () => {
    const { svc, renderQueue } = backfillSetup([T(1)]);
    await svc.backfillErasureRerenders({ dryRun: false, limit: 100, after: null }, CTX);
    expect(renderQueue.add).toHaveBeenCalledTimes(1);
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      {
        resumeId: T(1).resumeId,
        workerId: T(1).workerId,
        force: true,
        failClosed: true,
        correlationId: "corr-1",
        requestId: "req-1",
      },
      { jobId: `erasure-rerender:${T(1).resumeId}`, removeOnComplete: true, removeOnFail: true },
    );
  });

  it("emits one ids-only audit event per queued résumé, as ops", async () => {
    const { svc, events } = backfillSetup([T(1), T(2)]);
    const res = await svc.backfillErasureRerenders({ dryRun: false, limit: 100, after: null }, CTX);
    expect(res.enqueued).toBe(2);
    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(events.emit).toHaveBeenCalledWith({
      event_name: "resume.erasure_backfill_enqueued",
      actor: { actor_type: "ops", actor_id: null },
      subject: { subject_type: "resume", subject_id: T(2).resumeId },
      payload: { worker_id: T(2).workerId, resume_id: T(2).resumeId },
      correlationId: "corr-1",
      requestId: "req-1",
    });
  });

  it("does not queue a résumé twice while its render is still waiting", async () => {
    const { svc, renderQueue } = backfillSetup([T(1)]);
    renderQueue.getJob.mockResolvedValueOnce({ getState: async () => "waiting" });
    const res = await svc.backfillErasureRerenders({ dryRun: false, limit: 100, after: null }, CTX);
    expect(renderQueue.add).not.toHaveBeenCalled();
    // Still counted: a render that starts after the erasure exists, which is the point.
    expect(res.enqueued).toBe(1);
  });

  it("one résumé that cannot be queued is counted and skipped, never the end of the page", async () => {
    const { svc, renderQueue, events } = backfillSetup([T(1), T(2)]);
    renderQueue.add.mockRejectedValueOnce(new Error("redis down"));
    const res = await svc.backfillErasureRerenders({ dryRun: false, limit: 100, after: null }, CTX);
    expect(res).toMatchObject({ enqueued: 1, failed: 1 });
    // No audit row claims a render that was never queued.
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit.mock.calls[0]![0]).toMatchObject({ subject: { subject_id: T(2).resumeId } });
  });

  it("a failed audit write never un-queues the render", async () => {
    const { svc, renderQueue, events } = backfillSetup([T(1)]);
    events.emit.mockRejectedValueOnce(new Error("events table unreachable"));
    const res = await svc.backfillErasureRerenders({ dryRun: false, limit: 100, after: null }, CTX);
    expect(renderQueue.add).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ enqueued: 1, failed: 0 });
  });

  it("hands back the last id as the cursor only when the page was full", async () => {
    const full = backfillSetup([T(1), T(2)], 5);
    expect(
      (await full.svc.backfillErasureRerenders({ dryRun: true, limit: 2, after: null }, CTX))
        .next_after,
    ).toBe(T(2).resumeId);
    const last = backfillSetup([T(3)], 5);
    const res = await last.svc.backfillErasureRerenders(
      { dryRun: true, limit: 2, after: T(2).resumeId },
      CTX,
    );
    expect(last.repo.listErasureBackfillTargets).toHaveBeenCalledWith(2, T(2).resumeId);
    expect(res.next_after).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #1318 (owner ruling 2026-09-27) — `resume.edited_v2`, the résumé SAFE-FIELD edit.
//
// One event per field that REALLY changed, only for a worker who already has a résumé, ids + a
// closed enum only. Emitted after the sibling `worker.*` event, which must stay exactly as it was.
// ---------------------------------------------------------------------------

const OLD_NAME = "Ramesh Yadav";
const OLD_TOKEN = "v1.oldopaqueciphertext";

interface EditWorker {
  id: string;
  fullName: string | null;
  resumeShowPhoto: boolean;
  resumeNightShiftReady: boolean | null;
  photoStorageKey: string | null;
}

function editSetup(
  opts: {
    worker?: Partial<EditWorker>;
    /** The row `updateResumePrefs` returns; defaults to the worker unchanged. */
    updated?: Partial<EditWorker>;
    /** Pass `undefined` for "no résumé yet". */
    latestResume?: { id: string; version: number } | undefined;
    decrypt?: (token: string) => string;
    /** Make ONLY the `resume.edited_v2` emit reject — the siblings still land. */
    failEdited?: boolean;
  } = {},
) {
  const worker: EditWorker = {
    id: WORKER_ID,
    fullName: null,
    resumeShowPhoto: true,
    resumeNightShiftReady: false,
    photoStorageKey: null,
    ...opts.worker,
  };
  const latestResume = "latestResume" in opts ? opts.latestResume : { id: RESUME_ID, version: 1 };
  const repo = {
    findById: vi.fn(async (_id: string) => worker),
    withTransaction: passThroughTx(),
    updateFullName: vi.fn(async (_id: string, _token: string) => ({ id: WORKER_ID })),
    updatePhotoStorageKey: vi.fn(async (_id: string, key: string | null, _tx?: unknown) => ({
      ...worker,
      photoStorageKey: key,
    })),
    updateResumePrefs: vi.fn(async (_id: string, _patch: unknown, _tx?: unknown) => ({
      ...worker,
      ...opts.updated,
    })),
    latestResume: vi.fn(async (_id: string) => latestResume),
    listErasureTargetIds: vi.fn(async (_id: string) => (latestResume ? [latestResume.id] : [])),
  };
  const pii = {
    encrypt: vi.fn((_plaintext: string) => TOKEN),
    decrypt: vi.fn(opts.decrypt ?? ((token: string) => (token === OLD_TOKEN ? OLD_NAME : NAME))),
  };
  const events = {
    emit: vi.fn(async (e: unknown) => {
      if (opts.failEdited && (e as { event_name: string }).event_name === "resume.edited_v2") {
        throw new Error("events table unreachable");
      }
      return true;
    }),
  };
  const renderQueue = mockRenderQueue();
  const svc = newSvc(repo, pii, events, mockStorage(), mockConfig(), renderQueue);
  return { svc, repo, pii, events, renderQueue };
}

type Emitted = { event_name: string; payload: unknown; actor: unknown; subject: unknown };
const emitted = (events: { emit: ReturnType<typeof vi.fn> }): Emitted[] =>
  events.emit.mock.calls.map((c) => c[0] as Emitted);
const editedV2 = (events: { emit: ReturnType<typeof vi.fn> }): Emitted[] =>
  emitted(events).filter((e) => e.event_name === "resume.edited_v2");

/** The whole resume.edited_v2 emit call for one field — exact, so nothing else can ride along. */
function expectedEdit(field: string) {
  return {
    event_name: "resume.edited_v2",
    actor: { actor_type: "worker", actor_id: WORKER_ID },
    subject: { subject_type: "resume", subject_id: RESUME_ID },
    payload: { worker_id: WORKER_ID, resume_id: RESUME_ID, field },
    correlationId: CTX.correlationId,
    requestId: CTX.requestId,
  };
}

describe("resume.edited_v2 — name (#1318)", () => {
  it("a worker's own name CHANGE on a worker with a résumé emits exactly one, after worker.name_recorded", async () => {
    const { svc, events } = editSetup({ worker: { fullName: OLD_TOKEN } });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);

    const all = emitted(events);
    expect(all.map((e) => e.event_name)).toEqual(["worker.name_recorded", "resume.edited_v2"]);
    // The sibling is byte-for-byte what it always was.
    expect(all[0]).toMatchObject({
      actor: { actor_type: "worker", actor_id: WORKER_ID },
      subject: { subject_type: "worker", subject_id: WORKER_ID },
      payload: { worker_id: WORKER_ID },
    });
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("name"));
  });

  it("never lets the plaintext name — old or new — or either ciphertext into an emit call", async () => {
    const { svc, events } = editSetup({ worker: { fullName: OLD_TOKEN } });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);
    const serialized = JSON.stringify(events.emit.mock.calls);
    for (const secret of [NAME, OLD_NAME, "Asha", "Ramesh", TOKEN, OLD_TOKEN, "ciphertext"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("a first name on a worker with a résumé (none stored) is a change", async () => {
    const { svc, events, pii } = editSetup({ worker: { fullName: null } });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);
    expect(editedV2(events)).toHaveLength(1);
    expect(pii.decrypt).not.toHaveBeenCalled(); // nothing stored → nothing to read
  });

  it("re-saving the SAME name emits nothing — the sibling and the re-render are unchanged", async () => {
    const { svc, events, renderQueue } = editSetup({ worker: { fullName: TOKEN } });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);
    expect(editedV2(events)).toHaveLength(0);
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.name_recorded"]);
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, force: true, failClosed: false }),
    );
  });

  it("ONBOARDING name capture (no résumé yet) emits nothing", async () => {
    const { svc, events } = editSetup({ worker: { fullName: null }, latestResume: undefined });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.name_recorded"]);
  });

  it("with NO résumé the stored name is never decrypted — PII it cannot use is not read", async () => {
    const { svc, events, pii } = editSetup({
      worker: { fullName: OLD_TOKEN },
      latestResume: undefined,
    });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);
    expect(pii.decrypt).not.toHaveBeenCalled();
    expect(editedV2(events)).toHaveLength(0);
  });

  it("an UNREADABLE stored name counts as a change and never fails the save — nor logs a value", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { svc, events } = editSetup({
        worker: { fullName: OLD_TOKEN },
        decrypt: () => {
          throw new Error("decrypt failed");
        },
      });
      await expect(svc.setFullName(WORKER_ID, NAME, CTX, SELF)).resolves.toEqual({
        worker_id: WORKER_ID,
      });
      expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("name"));
      // Not vacuous: the degrade IS logged — once, with the worker id and nothing else.
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain(WORKER_ID);
      for (const secret of [NAME, OLD_TOKEN, "Asha"]) expect(logged).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  it("if the name's resume.edited_v2 EMIT fails, the save still succeeds and still re-renders", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { svc, renderQueue } = editSetup({ worker: { fullName: OLD_TOKEN }, failEdited: true });
      await expect(svc.setFullName(WORKER_ID, NAME, CTX, SELF)).resolves.toEqual({
        worker_id: WORKER_ID,
      });
      expect(renderQueue.add).toHaveBeenCalledWith(
        "render",
        expect.objectContaining({ resumeId: RESUME_ID, failClosed: false }),
      );
      expect(error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain("(name)");
      for (const secret of [NAME, OLD_NAME, TOKEN, OLD_TOKEN]) expect(logged).not.toContain(secret);
    } finally {
      error.mockRestore();
    }
  });

  it("if the résumé LOOKUP fails on a name save, the save succeeds, nothing is decrypted, and it still re-renders", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { svc, events, pii, repo, renderQueue } = editSetup({
        worker: { fullName: OLD_TOKEN },
      });
      repo.latestResume.mockRejectedValueOnce(new Error("connection terminated"));
      await expect(svc.setFullName(WORKER_ID, NAME, CTX, SELF)).resolves.toEqual({
        worker_id: WORKER_ID,
      });
      expect(editedV2(events)).toHaveLength(0);
      expect(pii.decrypt).not.toHaveBeenCalled();
      expect(repo.latestResume).toHaveBeenCalledTimes(2); // the gate's, then the re-render's own
      expect(renderQueue.add).toHaveBeenCalledWith(
        "render",
        expect.objectContaining({ resumeId: RESUME_ID }),
      );
      expect(error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(error.mock.calls);
      for (const secret of [NAME, OLD_NAME, TOKEN, OLD_TOKEN]) expect(logged).not.toContain(secret);
    } finally {
      error.mockRestore();
    }
  });

  it("the INTERNAL ops route (PUT /workers/:id/name) is not a résumé edit: no event, no decrypt", async () => {
    const { svc, events, pii } = editSetup({ worker: { fullName: OLD_TOKEN } });
    await svc.setFullName(WORKER_ID, NAME, CTX, { origin: "internal_ops" });
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.name_recorded"]);
    // #1804 — and the sibling it does emit is attributed to ops, not to the worker.
    expect(emitted(events)[0]!.actor).toEqual({ actor_type: "ops", actor_id: null });
    expect(pii.decrypt).not.toHaveBeenCalled();
  });

  it("looks the résumé up ONCE and re-renders that one", async () => {
    const { svc, repo, renderQueue } = editSetup({ worker: { fullName: OLD_TOKEN } });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);
    expect(repo.latestResume).toHaveBeenCalledTimes(1);
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, force: true }),
    );
  });
});

describe("resume.edited_v2 — photo (#1318)", () => {
  it("a confirmed upload emits exactly one `photo`, after worker.photo_uploaded — never the key", async () => {
    const { svc, events, repo } = editSetup();
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);

    const all = emitted(events);
    expect(all.map((e) => e.event_name)).toEqual(["worker.photo_uploaded", "resume.edited_v2"]);
    expect(all[0]!.payload).toEqual({ worker_id: WORKER_ID });
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("photo"));
    expect(JSON.stringify(events.emit.mock.calls)).not.toMatch(/photos\/|https?:|\.jpg/);
    expect(repo.latestResume).toHaveBeenCalledTimes(1);
  });

  it("a REPLACEMENT is a change too — a new object is always a new photo", async () => {
    const OLD_KEY = `photos/${WORKER_ID}/00000000-3333-4333-8333-000000000003.jpg`;
    const { svc, events } = editSetup({ worker: { photoStorageKey: OLD_KEY } });
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(editedV2(events)).toHaveLength(1);
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain(OLD_KEY);
  });

  it("emits even with show_photo OFF (the photo is still the résumé's) — and still skips the re-render", async () => {
    const { svc, events, renderQueue } = editSetup({ worker: { resumeShowPhoto: false } });
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("photo"));
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("re-confirming the key ALREADY on file (a retry) is no edit — the sibling still lands", async () => {
    const { svc, events, repo } = editSetup({
      worker: { photoStorageKey: MINTED_KEY, resumeShowPhoto: false },
    });
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.photo_uploaded"]);
    expect(repo.latestResume).not.toHaveBeenCalled();
  });

  it("a PRE-RÉSUMÉ avatar upload emits nothing", async () => {
    const { svc, events } = editSetup({ latestResume: undefined });
    await svc.confirmPhoto(WORKER_ID, { storage_path: MINTED_KEY }, CTX);
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.photo_uploaded"]);
  });

  it("removing a photo emits exactly one `photo`, after worker.photo_removed", async () => {
    const { svc, events, repo, renderQueue } = editSetup({
      worker: { photoStorageKey: MINTED_KEY },
    });
    await svc.deletePhoto(WORKER_ID, CTX);

    const all = emitted(events);
    expect(all.map((e) => e.event_name)).toEqual(["worker.photo_removed", "resume.edited_v2"]);
    expect(all[0]!.payload).toEqual({ worker_id: WORKER_ID });
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("photo"));
    expect(JSON.stringify(events.emit.mock.calls)).not.toMatch(/photos\/|\.jpg/);
    // The erasure re-render still targets the same résumé, fail-closed — the SAME lookup the event
    // named, so resume_id is the résumé being erased.
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, failClosed: true }),
    );
    expect(repo.latestResume).toHaveBeenCalledTimes(1);
  });

  it("deleting when there is NO photo emits nothing at all", async () => {
    const { svc, events } = editSetup({ worker: { photoStorageKey: null } });
    await svc.deletePhoto(WORKER_ID, CTX);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("removing a photo before any résumé exists emits only the sibling", async () => {
    const { svc, events } = editSetup({
      worker: { photoStorageKey: MINTED_KEY },
      latestResume: undefined,
    });
    await svc.deletePhoto(WORKER_ID, CTX);
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.photo_removed"]);
  });

  // THE ERASURE MUST OUTLIVE THE ANALYTICS. A retry cannot repair a skipped erasure here (the
  // photo is already gone, so it takes the no-photo early return), so a failing
  // resume.edited_v2 must never stand between the removal and its fail-closed re-render.
  it("if the resume.edited_v2 EMIT fails, the removal still succeeds and the fail-closed erasure is queued", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { svc, events, renderQueue } = editSetup({
        worker: { photoStorageKey: MINTED_KEY },
        failEdited: true,
      });
      await expect(svc.deletePhoto(WORKER_ID, CTX)).resolves.toEqual({
        worker_id: WORKER_ID,
        has_photo: false,
      });
      expect(emitted(events)[0]!.event_name).toBe("worker.photo_removed");
      expect(renderQueue.add).toHaveBeenCalledWith(
        "render",
        expect.objectContaining({ resumeId: RESUME_ID, failClosed: true }),
      );
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toMatch(/photos\/|\.jpg/);
    } finally {
      error.mockRestore();
    }
  });

  it("if the résumé LOOKUP for the gate fails, the removal still succeeds and the erasure is queued", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { svc, events, repo, renderQueue } = editSetup({
        worker: { photoStorageKey: MINTED_KEY },
      });
      repo.latestResume.mockRejectedValueOnce(new Error("connection terminated"));
      await expect(svc.deletePhoto(WORKER_ID, CTX)).resolves.toEqual({
        worker_id: WORKER_ID,
        has_photo: false,
      });
      expect(editedV2(events)).toHaveLength(0);
      // The gate's lookup failed, so the re-render made its own — exactly as before #1318.
      expect(repo.latestResume).toHaveBeenCalledTimes(2);
      expect(renderQueue.add).toHaveBeenCalledWith(
        "render",
        expect.objectContaining({ resumeId: RESUME_ID, failClosed: true }),
      );
      // Loud, not silent — and without the key.
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.mock.calls)).not.toMatch(/photos\/|\.jpg/);
    } finally {
      error.mockRestore();
    }
  });
});

describe("resume.edited_v2 — show_photo / night_shift_ready (#1318)", () => {
  const WITH_PHOTO = { photoStorageKey: MINTED_KEY };

  it("a show_photo flip emits exactly one `show_photo`; the sibling carries the same flags as before", async () => {
    const { svc, events } = editSetup({ worker: WITH_PHOTO, updated: { resumeShowPhoto: false } });
    await svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX);

    const all = emitted(events);
    expect(all.map((e) => e.event_name)).toEqual([
      "worker.resume_prefs_updated",
      "resume.edited_v2",
    ]);
    expect(all[0]!.payload).toEqual({
      worker_id: WORKER_ID,
      show_photo: false,
      night_shift_ready: false,
    });
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("show_photo"));
  });

  it("flipping BOTH emits one per field, and no value of either", async () => {
    const { svc, events } = editSetup({
      worker: WITH_PHOTO,
      updated: { resumeShowPhoto: false, resumeNightShiftReady: true },
    });
    await svc.updateResumePrefs(WORKER_ID, { show_photo: false, night_shift_ready: true }, CTX);
    expect(events.emit.mock.calls.slice(1).map((c) => c[0])).toEqual([
      expectedEdit("show_photo"),
      expectedEdit("night_shift_ready"),
    ]);
  });

  it("a night_shift_ready flip emits exactly one `night_shift_ready`", async () => {
    const { svc, events } = editSetup({ updated: { resumeNightShiftReady: true } });
    await svc.updateResumePrefs(WORKER_ID, { night_shift_ready: true }, CTX);
    expect(editedV2(events)).toHaveLength(1);
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("night_shift_ready"));
  });

  it("a same-value PATCH emits nothing and looks nothing up — the sibling still lands", async () => {
    const { svc, events, repo } = editSetup({ worker: WITH_PHOTO });
    await svc.updateResumePrefs(WORKER_ID, { show_photo: true, night_shift_ready: false }, CTX);
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.resume_prefs_updated"]);
    expect(repo.latestResume).not.toHaveBeenCalled();
  });

  it("turning show_photo OFF still queues the fail-closed erasure when resume.edited_v2 fails", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { svc, renderQueue } = editSetup({
        worker: WITH_PHOTO,
        updated: { resumeShowPhoto: false },
        failEdited: true,
      });
      await expect(svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX)).resolves.toEqual({
        worker_id: WORKER_ID,
      });
      expect(renderQueue.add).toHaveBeenCalledWith(
        "render",
        expect.objectContaining({ resumeId: RESUME_ID, failClosed: true }),
      );
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("a PARTIAL PATCH names only the field that moved, never the one it left alone", async () => {
    const { svc, events } = editSetup({ updated: { resumeShowPhoto: false } });
    await svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX);
    expect(editedV2(events).map((e) => (e.payload as { field: string }).field)).toEqual([
      "show_photo",
    ]);
  });

  it("night_shift_ready null → false is NO edit (null ≡ false, as the sibling payload reports it)", async () => {
    const { svc, events, repo, renderQueue } = editSetup({
      worker: { resumeNightShiftReady: null },
      updated: { resumeNightShiftReady: false },
    });
    await svc.updateResumePrefs(WORKER_ID, { night_shift_ready: false }, CTX);
    expect(editedV2(events)).toHaveLength(0);
    // …but the re-render gate compares RAW values (null !== false) and is untouched by #1318: it
    // still re-renders, making its own lookup because the edit gate never looked.
    expect(repo.latestResume).toHaveBeenCalledTimes(1);
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID }),
    );
  });

  it("if the résumé LOOKUP fails as show_photo turns OFF, the fail-closed erasure is still queued", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const { svc, events, repo, renderQueue } = editSetup({
        worker: WITH_PHOTO,
        updated: { resumeShowPhoto: false },
      });
      repo.latestResume.mockRejectedValueOnce(new Error("connection terminated"));
      await expect(svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX)).resolves.toEqual({
        worker_id: WORKER_ID,
      });
      expect(editedV2(events)).toHaveLength(0);
      expect(renderQueue.add).toHaveBeenCalledWith(
        "render",
        expect.objectContaining({ resumeId: RESUME_ID, failClosed: true }),
      );
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("night_shift_ready null → true IS an edit", async () => {
    const { svc, events } = editSetup({
      worker: { resumeNightShiftReady: null },
      updated: { resumeNightShiftReady: true },
    });
    await svc.updateResumePrefs(WORKER_ID, { night_shift_ready: true }, CTX);
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("night_shift_ready"));
  });

  it("a show_photo flip with NO photo on file is still the worker's edit (no re-render, as before)", async () => {
    const { svc, events, renderQueue } = editSetup({ updated: { resumeShowPhoto: false } });
    await svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX);
    expect(events.emit.mock.calls[1]![0]).toEqual(expectedEdit("show_photo"));
    expect(renderQueue.add).not.toHaveBeenCalled();
  });

  it("a flip before any résumé exists emits nothing", async () => {
    const { svc, events } = editSetup({
      updated: { resumeShowPhoto: false, resumeNightShiftReady: true },
      latestResume: undefined,
    });
    await svc.updateResumePrefs(WORKER_ID, { show_photo: false, night_shift_ready: true }, CTX);
    expect(emitted(events).map((e) => e.event_name)).toEqual(["worker.resume_prefs_updated"]);
  });

  it("a real flip looks the résumé up ONCE and re-renders that one", async () => {
    const { svc, repo, renderQueue } = editSetup({
      worker: WITH_PHOTO,
      updated: { resumeShowPhoto: false },
    });
    await svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX);
    expect(repo.latestResume).toHaveBeenCalledTimes(1);
    expect(renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, failClosed: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// #1804 — the ops-only name route is attributed to ops, never to the worker
// ---------------------------------------------------------------------------

describe("worker.name_recorded actor follows the write's origin (#1804)", () => {
  /** The real envelope requires a uuid correlation id; the file-wide CTX is a placeholder. */
  const UUID_CTX = {
    correlationId: "6f7a8b9c-6666-4666-8666-000000000006",
    requestId: "req-1804",
  } as RequestContext;

  /** A REAL EventsService over a capturing repository, so the envelope itself is validated. */
  function realEventsSetup() {
    const inserted: BadaBhaiEvent[] = [];
    const eventsRepo = {
      insert: vi.fn(async (event: BadaBhaiEvent) => {
        inserted.push(event);
        return true;
      }),
    };
    const events = new EventsService(
      eventsRepo as unknown as EventsRepository,
      mockConfig({ NODE_ENV: "test" } as Partial<ServerConfig>),
    );
    const { repo } = editSetup({ worker: { fullName: OLD_TOKEN } });
    const pii = { encrypt: vi.fn(() => TOKEN), decrypt: vi.fn(() => OLD_NAME) };
    const svc = newSvc(repo, pii, events);
    return { svc, inserted };
  }

  it("the INTERNAL ops route emits it with the ops actor { actor_type: 'ops', actor_id: null }", async () => {
    const { svc, events } = editSetup({ worker: { fullName: OLD_TOKEN } });
    await svc.setFullName(WORKER_ID, NAME, CTX, { origin: "internal_ops" });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit.mock.calls[0]![0]).toEqual({
      event_name: "worker.name_recorded",
      actor: { actor_type: "ops", actor_id: null },
      // Subject and payload are UNCHANGED — only the attribution moved.
      subject: { subject_type: "worker", subject_id: WORKER_ID },
      payload: { worker_id: WORKER_ID },
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
  });

  it("the worker's OWN route keeps the worker actor", async () => {
    const { svc, events } = editSetup({ worker: { fullName: OLD_TOKEN } });
    await svc.setFullName(WORKER_ID, NAME, CTX, SELF);
    expect(emitted(events)[0]).toMatchObject({
      event_name: "worker.name_recorded",
      actor: { actor_type: "worker", actor_id: WORKER_ID },
      payload: { worker_id: WORKER_ID },
    });
  });

  it("the ops actor passes the REAL envelope validation, and the stored event carries no PII", async () => {
    const { svc, inserted } = realEventsSetup();
    await svc.setFullName(WORKER_ID, NAME, UUID_CTX, { origin: "internal_ops" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.event_name).toBe("worker.name_recorded");
    expect(inserted[0]!.actor).toMatchObject({ actor_type: "ops", actor_id: null });
    expect(inserted[0]!.payload).toEqual({ worker_id: WORKER_ID });
    for (const secret of [NAME, OLD_NAME, TOKEN, OLD_TOKEN]) {
      expect(JSON.stringify(inserted)).not.toContain(secret);
    }
  });

  it("the worker actor still passes the real envelope validation too", async () => {
    const { svc, inserted } = realEventsSetup();
    await svc.setFullName(WORKER_ID, NAME, UUID_CTX, SELF);
    const recorded = inserted.find((e) => e.event_name === "worker.name_recorded");
    expect(recorded?.actor).toMatchObject({ actor_type: "worker", actor_id: WORKER_ID });
  });
});

// ---------------------------------------------------------------------------
// #1803 — write + audit in ONE transaction on every erasure path (owner ruling 2026-09-28)
// ---------------------------------------------------------------------------

/**
 * A STAGING-WORLD transaction (the `admin-actions.atomicity.test.ts` technique): inside
 * `withTransaction` every write and every tx-bound emit mutates a deep copy, which is committed
 * to the canonical world only if the callback resolves and DISCARDED if it throws. A write or an
 * emit made WITHOUT the tx lands on the canonical world directly — exactly what a standalone
 * statement does — so a write that escaped the transaction survives the rollback and the tests
 * below go red.
 *
 * `log` records the observable order: begin/commit/rollback, the write, every emit, the object
 * delete and every render enqueue.
 */
interface ErasureWorld {
  photoStorageKey: string | null;
  resumeShowPhoto: boolean;
  resumeNightShiftReady: boolean | null;
  whatsappEnc: string | null;
  events: string[];
}

function erasureHarness(initial: Partial<ErasureWorld>) {
  const world: ErasureWorld = {
    photoStorageKey: null,
    resumeShowPhoto: true,
    resumeNightShiftReady: false,
    whatsappEnc: null,
    events: [],
    ...initial,
  };
  const log: string[] = [];
  /** Event names whose NEXT emit throws once (the "sibling audit emit fails" injection). */
  const failOnce = new Set<string>();
  const on = (tx: unknown): ErasureWorld => (tx as ErasureWorld | undefined) ?? world;
  const row = (w: ErasureWorld) => ({
    id: WORKER_ID,
    fullName: null,
    photoStorageKey: w.photoStorageKey,
    resumeShowPhoto: w.resumeShowPhoto,
    resumeNightShiftReady: w.resumeNightShiftReady,
    whatsappEnc: w.whatsappEnc,
  });

  const repo = {
    findById: vi.fn(async (_id: string) => row(world)),
    withTransaction: vi.fn(async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => {
      log.push("tx:begin");
      const staged = structuredClone(world);
      let result: T;
      try {
        result = await cb(staged);
      } catch (err) {
        log.push("tx:rollback");
        throw err;
      }
      Object.assign(world, staged);
      log.push("tx:commit");
      return result;
    }),
    updatePhotoStorageKey: vi.fn(async (_id: string, key: string | null, tx?: unknown) => {
      log.push("write");
      on(tx).photoStorageKey = key;
      return row(on(tx));
    }),
    updateResumePrefs: vi.fn(
      async (
        _id: string,
        patch: { resumeShowPhoto?: boolean; resumeNightShiftReady?: boolean },
        tx?: unknown,
      ) => {
        log.push("write");
        const w = on(tx);
        if (patch.resumeShowPhoto !== undefined) w.resumeShowPhoto = patch.resumeShowPhoto;
        if (patch.resumeNightShiftReady !== undefined) {
          w.resumeNightShiftReady = patch.resumeNightShiftReady;
        }
        return row(w);
      },
    ),
    updateWhatsapp: vi.fn(async (_id: string, token: string | null, tx?: unknown) => {
      log.push("write");
      on(tx).whatsappEnc = token;
      return row(on(tx));
    }),
    latestResume: vi.fn(async (_id: string) => ({ id: RESUME_ID, version: 1 })),
    listErasureTargetIds: vi.fn(async (_id: string) => [RESUME_ID]),
  };
  const events = {
    emit: vi.fn(async (p: { event_name: string; tx?: unknown }) => {
      if (failOnce.delete(p.event_name)) {
        log.push(`emit-failed:${p.event_name}`);
        throw new Error("events table unreachable");
      }
      log.push(`emit:${p.event_name}`);
      on(p.tx).events.push(p.event_name);
      return true;
    }),
  };
  const storage = mockStorage();
  storage.deletePdf = vi.fn(async (_key: string, _bucket?: string) => {
    log.push("storage:delete");
    return undefined;
  });
  const renderQueue = mockRenderQueue();
  renderQueue.add.mockImplementation(async (_name: string, data: ResumeRenderJobData) => {
    log.push(`render:${data.resumeId}:failClosed=${String(data.failClosed)}`);
    return { id: "job-1" };
  });
  const pii = {
    encrypt: vi.fn((_plaintext: string) => "v1.encryptedwhatsapp"),
    decrypt: vi.fn(),
  };
  const svc = newSvc(repo, pii, events, storage, mockConfig(), renderQueue);
  const emittedNames = () =>
    events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
  return { svc, world, log, failOnce, repo, events, storage, renderQueue, emittedNames };
}

/** The tx the named event's emit was handed (`undefined` when it was emitted standalone). */
function txOfEmit(events: { emit: ReturnType<typeof vi.fn> }, name: string): unknown {
  const call = events.emit.mock.calls.find(
    (c) => (c[0] as { event_name: string }).event_name === name,
  );
  return (call?.[0] as { tx?: unknown } | undefined)?.tx;
}

describe("#1803 deletePhoto — pointer clear + worker.photo_removed in ONE transaction", () => {
  const START = { photoStorageKey: MINTED_KEY, resumeShowPhoto: true };

  it("(a) the write and the sibling emit ride the SAME transaction", async () => {
    const h = erasureHarness(START);
    await h.svc.deletePhoto(WORKER_ID, CTX);
    const writeTx = h.repo.updatePhotoStorageKey.mock.calls[0]![2];
    expect(writeTx).toBeDefined();
    expect(writeTx).not.toBe(h.world); // a staged transaction, not the pool
    expect(txOfEmit(h.events, "worker.photo_removed")).toBe(writeTx);
    expect(h.repo.withTransaction).toHaveBeenCalledTimes(1);
  });

  it("(b) a failing sibling emit rejects the request and rolls the clear back — no delete, no edit, no render", async () => {
    const h = erasureHarness(START);
    h.failOnce.add("worker.photo_removed");
    await expect(h.svc.deletePhoto(WORKER_ID, CTX)).rejects.toThrow("events table unreachable");

    expect(h.world.photoStorageKey).toBe(MINTED_KEY); // rolled back
    expect(h.world.events).toEqual([]);
    expect(h.storage.deletePdf).not.toHaveBeenCalled(); // the bytes survive with their pointer
    expect(h.emittedNames()).not.toContain("resume.edited_v2");
    expect(h.renderQueue.add).not.toHaveBeenCalled();
    expect(h.log).toEqual(["tx:begin", "write", "emit-failed:worker.photo_removed", "tx:rollback"]);
  });

  it("(c) the worker's retry after that failure succeeds and queues the fail-closed erasure", async () => {
    const h = erasureHarness(START);
    h.failOnce.add("worker.photo_removed");
    await expect(h.svc.deletePhoto(WORKER_ID, CTX)).rejects.toThrow();

    await expect(h.svc.deletePhoto(WORKER_ID, CTX)).resolves.toEqual({
      worker_id: WORKER_ID,
      has_photo: false,
    });
    expect(h.world.photoStorageKey).toBeNull();
    expect(h.world.events).toEqual(["worker.photo_removed", "resume.edited_v2"]);
    expect(h.storage.deletePdf).toHaveBeenCalledOnce();
    expect(h.storage.deletePdf).toHaveBeenCalledWith(MINTED_KEY, "worker-profile-photos");
    expect(h.renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, force: true, failClosed: true }),
    );
  });

  it("(d) the happy path: commit, THEN the object delete, THEN resume.edited_v2 (no tx), THEN the erasure", async () => {
    const h = erasureHarness(START);
    await h.svc.deletePhoto(WORKER_ID, CTX);
    expect(h.log).toEqual([
      "tx:begin",
      "write",
      "emit:worker.photo_removed",
      "tx:commit",
      "storage:delete",
      "emit:resume.edited_v2",
      `render:${RESUME_ID}:failClosed=true`,
    ]);
    // #1318's measurement signal stays OUTSIDE the transaction — it can never roll back an erasure.
    expect(txOfEmit(h.events, "resume.edited_v2")).toBeUndefined();
  });

  it("a failing resume.edited_v2 never touches the committed removal (it is outside the tx)", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const h = erasureHarness(START);
      h.failOnce.add("resume.edited_v2");
      await expect(h.svc.deletePhoto(WORKER_ID, CTX)).resolves.toMatchObject({ has_photo: false });
      expect(h.world.photoStorageKey).toBeNull();
      expect(h.world.events).toEqual(["worker.photo_removed"]);
      expect(h.log.at(-1)).toBe(`render:${RESUME_ID}:failClosed=true`);
    } finally {
      error.mockRestore();
    }
  });
});

describe("#1803 updateResumePrefs — prefs write + worker.resume_prefs_updated in ONE transaction", () => {
  const START = { photoStorageKey: MINTED_KEY, resumeShowPhoto: true };

  it("(a) the write and the sibling emit ride the SAME transaction", async () => {
    const h = erasureHarness(START);
    await h.svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX);
    const writeTx = h.repo.updateResumePrefs.mock.calls[0]![2];
    expect(writeTx).toBeDefined();
    expect(writeTx).not.toBe(h.world);
    expect(txOfEmit(h.events, "worker.resume_prefs_updated")).toBe(writeTx);
  });

  it("(b) show_photo OFF with a failing sibling emit: rejects, rolls back, no edit, no render", async () => {
    const h = erasureHarness(START);
    h.failOnce.add("worker.resume_prefs_updated");
    await expect(h.svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX)).rejects.toThrow(
      "events table unreachable",
    );
    expect(h.world.resumeShowPhoto).toBe(true); // rolled back
    expect(h.world.events).toEqual([]);
    expect(h.emittedNames()).not.toContain("resume.edited_v2");
    expect(h.renderQueue.add).not.toHaveBeenCalled();
    expect(h.storage.deletePdf).not.toHaveBeenCalled();
  });

  it("(c) the retry sees the flip again and queues the fail-closed erasure", async () => {
    const h = erasureHarness(START);
    h.failOnce.add("worker.resume_prefs_updated");
    await expect(h.svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX)).rejects.toThrow();

    await expect(h.svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX)).resolves.toEqual({
      worker_id: WORKER_ID,
    });
    expect(h.world.resumeShowPhoto).toBe(false);
    expect(h.world.events).toEqual(["worker.resume_prefs_updated", "resume.edited_v2"]);
    expect(h.renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, force: true, failClosed: true }),
    );
  });

  it("(d) the happy path: commit, THEN resume.edited_v2 (no tx), THEN the gated re-render", async () => {
    const h = erasureHarness(START);
    await h.svc.updateResumePrefs(WORKER_ID, { show_photo: false }, CTX);
    expect(h.log).toEqual([
      "tx:begin",
      "write",
      "emit:worker.resume_prefs_updated",
      "tx:commit",
      "emit:resume.edited_v2",
      `render:${RESUME_ID}:failClosed=true`,
    ]);
    expect(txOfEmit(h.events, "resume.edited_v2")).toBeUndefined();
  });

  it("the re-render gating is unchanged: a same-value PATCH commits the audit row and renders nothing", async () => {
    const h = erasureHarness(START);
    await h.svc.updateResumePrefs(WORKER_ID, { show_photo: true }, CTX);
    expect(h.log).toEqual(["tx:begin", "write", "emit:worker.resume_prefs_updated", "tx:commit"]);
  });
});

describe("#1803 setWhatsapp (clear) — number write + worker.whatsapp_recorded in ONE transaction", () => {
  const START = { whatsappEnc: "v1.old" };

  it("(a) the write and the sibling emit ride the SAME transaction", async () => {
    const h = erasureHarness(START);
    await h.svc.setWhatsapp(WORKER_ID, { whatsapp: null }, CTX);
    const writeTx = h.repo.updateWhatsapp.mock.calls[0]![2];
    expect(writeTx).toBeDefined();
    expect(writeTx).not.toBe(h.world);
    expect(txOfEmit(h.events, "worker.whatsapp_recorded")).toBe(writeTx);
  });

  it("(b) a failing sibling emit on a CLEAR rejects and rolls the clear back — no render", async () => {
    const h = erasureHarness(START);
    h.failOnce.add("worker.whatsapp_recorded");
    await expect(h.svc.setWhatsapp(WORKER_ID, { whatsapp: null }, CTX)).rejects.toThrow(
      "events table unreachable",
    );
    expect(h.world.whatsappEnc).toBe("v1.old"); // rolled back
    expect(h.world.events).toEqual([]);
    expect(h.renderQueue.add).not.toHaveBeenCalled();
  });

  it("(c) the retry sees the number again and queues the fail-closed erasure", async () => {
    const h = erasureHarness(START);
    h.failOnce.add("worker.whatsapp_recorded");
    await expect(h.svc.setWhatsapp(WORKER_ID, { whatsapp: null }, CTX)).rejects.toThrow();

    await expect(h.svc.setWhatsapp(WORKER_ID, { whatsapp: null }, CTX)).resolves.toEqual({
      worker_id: WORKER_ID,
      has_whatsapp: false,
    });
    expect(h.world.whatsappEnc).toBeNull();
    expect(h.world.events).toEqual(["worker.whatsapp_recorded"]);
    expect(h.renderQueue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, force: true, failClosed: true }),
    );
  });

  it("(d) the happy path: commit, THEN the fail-closed erasure", async () => {
    const h = erasureHarness(START);
    await h.svc.setWhatsapp(WORKER_ID, { whatsapp: null }, CTX);
    expect(h.log).toEqual([
      "tx:begin",
      "write",
      "emit:worker.whatsapp_recorded",
      "tx:commit",
      `render:${RESUME_ID}:failClosed=true`,
    ]);
  });
});
