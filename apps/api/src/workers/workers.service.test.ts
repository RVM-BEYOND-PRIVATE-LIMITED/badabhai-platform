import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Queue } from "bullmq";
import { WorkersService } from "./workers.service";
import type { WorkersRepository } from "./workers.repository";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { StorageService } from "../storage/storage.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "corr-1", requestId: "req-1" } as RequestContext;
const NAME = "Asha Kumari";
const TOKEN = "v1.opaqueciphertext"; // encrypt() output — must NOT contain the name

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
    // ADR-0032 A1: rendering ON by default so the re-render path is exercised;
    // a test flips it off to prove a good PDF is NOT stripped when nothing could
    // rebuild it.
    RESUME_RENDER_ENABLED: true,
    ...overrides,
  } as ServerConfig;
}

/** ADR-0032 A1 — the resume-render queue the photo change points enqueue onto. */
function mockQueue() {
  return { add: vi.fn(async () => ({ id: "job-1" })) };
}

function newSvc(
  repo: unknown,
  pii: unknown,
  events: unknown,
  storage: unknown = mockStorage(),
  config: ServerConfig = mockConfig(),
  queue: unknown = mockQueue(),
) {
  return new WorkersService(
    repo as WorkersRepository,
    pii as PiiCryptoService,
    events as EventsService,
    storage as StorageService,
    config,
    queue as Queue,
  );
}

function setup(workerExists = true) {
  const repo = {
    findById: vi.fn(async (_id: string) => (workerExists ? { id: "w-1", fullName: null } : undefined)),
    updateFullName: vi.fn(async (_id: string, _token: string) => ({ id: "w-1" })),
  };
  const pii = { encrypt: vi.fn((_plaintext: string) => TOKEN) };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const svc = newSvc(repo, pii, events);
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
  const svc = newSvc(repo, pii, events);
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
    updateResumePrefs: vi.fn(async (_id: string, _patch: unknown) => updatedRow),
  };
  const pii = {
    encrypt: vi.fn(),
    // decrypt maps the stored ciphertext token back to a readable name
    decrypt: vi.fn((_token: string) => NAME),
  };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const svc = newSvc(repo, pii, events);
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

// ---------------------------------------------------------------------------
// ADR-0032 — the profile-photo seam (mint / confirm / read-url / delete)
// ---------------------------------------------------------------------------

const WORKER_ID = "0a1b2c3d-1111-4111-8111-000000000001";
const MINTED_KEY = `photos/${WORKER_ID}/9f8e7d6c-2222-4222-8222-000000000002.jpg`;

/** ADR-0032 A1 — the worker's latest generated resume. */
const RESUME_ID = "res-1";

function photoSetup(opts: {
  worker?: { id: string; photoStorageKey?: string | null } | undefined;
  bucket?: string;
  info?: { contentType: string | null; sizeBytes: number | null } | null;
  /** ADR-0032 A1: the worker's latest resume, or undefined for "never generated". */
  latestResume?: { id: string } | undefined;
  renderEnabled?: boolean;
  queue?: { add: ReturnType<typeof vi.fn> };
} = {}) {
  const worker =
    "worker" in opts
      ? opts.worker
      : { id: WORKER_ID, fullName: null, resumeShowPhoto: true, photoStorageKey: null };
  const repo = {
    findById: vi.fn(async (_id: string) => worker),
    updatePhotoStorageKey: vi.fn(async (_id: string, key: string | null) =>
      worker ? { ...worker, photoStorageKey: key } : undefined,
    ),
    // A1: the re-render path reads the latest resume and flips it out of
    // 'rendered' before enqueueing.
    latestResume: vi.fn(async (_id: string) =>
      "latestResume" in opts ? opts.latestResume : { id: RESUME_ID },
    ),
    markResumePendingForRerender: vi.fn(async (_id: string) => undefined),
    updateResumePrefs: vi.fn(async (_id: string, prefs: Record<string, unknown>) => ({
      ...worker,
      ...prefs,
    })),
  };
  const pii = { encrypt: vi.fn(), decrypt: vi.fn() };
  const events = { emit: vi.fn(async (_e: unknown) => true) };
  const storage = mockStorage();
  if ("info" in opts) {
    storage.getObjectInfo = vi.fn(async () => opts.info ?? null);
  }
  const config = mockConfig({
    ...("bucket" in opts ? { WORKER_PHOTOS_BUCKET: opts.bucket } : {}),
    ...("renderEnabled" in opts ? { RESUME_RENDER_ENABLED: opts.renderEnabled } : {}),
  } as Partial<ServerConfig>);
  const queue = opts.queue ?? mockQueue();
  const svc = newSvc(repo, pii, events, storage, config, queue);
  return { svc, repo, events, storage, queue };
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
    expect(key).toMatch(
      new RegExp(`^photos/${WORKER_ID}/[0-9a-f-]{36}\\.jpg$`),
    );
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
    const { svc, repo, events } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: null },
    });
    const res = await svc.deletePhoto(WORKER_ID, CTX);
    expect(res).toEqual({ worker_id: WORKER_ID, has_photo: false });
    expect(repo.updatePhotoStorageKey).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("clears the pointer, deletes the object, and emits a PII-free worker.photo_removed", async () => {
    const { svc, repo, storage, events } = photoSetup({
      worker: { id: WORKER_ID, photoStorageKey: MINTED_KEY },
    });
    const res = await svc.deletePhoto(WORKER_ID, CTX);

    expect(repo.updatePhotoStorageKey).toHaveBeenCalledWith(WORKER_ID, null);
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
    expect(repo.updatePhotoStorageKey).toHaveBeenCalledWith(WORKER_ID, null);
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
 * ADR-0032 A1 — the photo/show_photo change points must re-render the resume.
 *
 * worker.photo_uploaded / worker.photo_removed already existed but had NO
 * consumers (the `events` table is the audit spine, not a bus), so nothing ever
 * rebuilt the PDF: "your photo appears on your resume automatically" was simply
 * untrue. The PDF kept whatever photo it was first built with.
 */
describe("WorkersService — resume re-render on photo change (ADR-0032 A1)", () => {
  const VALID_KEY = `photos/${WORKER_ID}/0a1b2c3d-0000-4000-8000-000000000000.jpg`;
  const okInfo = { contentType: "image/jpeg", sizeBytes: 1024 };

  it("confirmPhoto flips the row OUT of 'rendered' and enqueues — in that order", async () => {
    const { svc, repo, queue } = photoSetup({ info: okInfo });

    await svc.confirmPhoto(WORKER_ID, { storage_path: VALID_KEY }, CTX);

    // The reset is the whole point: the processor early-returns on a 'rendered'
    // row, so enqueueing WITHOUT it is a silent no-op.
    expect(repo.markResumePendingForRerender).toHaveBeenCalledWith(RESUME_ID);
    expect(queue.add).toHaveBeenCalledWith(
      "render",
      expect.objectContaining({ resumeId: RESUME_ID, workerId: WORKER_ID }),
    );
    expect(repo.markResumePendingForRerender.mock.invocationCallOrder[0]!).toBeLessThan(
      queue.add.mock.invocationCallOrder[0]!,
    );
  });

  it("deletePhoto re-renders so the deleted photo leaves the PDF", async () => {
    const { svc, repo, queue } = photoSetup({
      worker: {
        id: WORKER_ID,
        fullName: null,
        resumeShowPhoto: true,
        photoStorageKey: VALID_KEY,
      } as never,
    });

    await svc.deletePhoto(WORKER_ID, CTX);

    expect(repo.markResumePendingForRerender).toHaveBeenCalledWith(RESUME_ID);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-render when the worker has no resume yet", async () => {
    const { svc, repo, queue } = photoSetup({ info: okInfo, latestResume: undefined });

    await svc.confirmPhoto(WORKER_ID, { storage_path: VALID_KEY }, CTX);

    expect(repo.markResumePendingForRerender).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does NOT re-render when show_photo is off — the PDF would be identical", async () => {
    const { svc, queue } = photoSetup({
      info: okInfo,
      worker: {
        id: WORKER_ID,
        fullName: null,
        resumeShowPhoto: false,
        photoStorageKey: null,
      } as never,
    });

    await svc.confirmPhoto(WORKER_ID, { storage_path: VALID_KEY }, CTX);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does NOT strip a good PDF when rendering is DISABLED", async () => {
    // The reset nulls pdf_storage_key. With the kill-switch off nothing would
    // ever rebuild it, so the worker would silently LOSE a downloadable PDF and
    // be left on a permanently 'pending' row. A stale photo beats no PDF.
    const { svc, repo, queue } = photoSetup({ info: okInfo, renderEnabled: false });

    await svc.confirmPhoto(WORKER_ID, { storage_path: VALID_KEY }, CTX);

    expect(repo.markResumePendingForRerender).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("a queue failure does NOT fail the photo request", async () => {
    const queue = { add: vi.fn(async () => { throw new Error("redis down"); }) };
    const { svc, events } = photoSetup({ info: okInfo, queue });

    // The photo was saved; a stale PDF is a far smaller problem than a 500 on
    // upload (mirrors ResumeService.enqueueRender's fail-soft contract).
    const res = await svc.confirmPhoto(WORKER_ID, { storage_path: VALID_KEY }, CTX);

    expect(res).toEqual({ worker_id: WORKER_ID, has_photo: true });
    expect(events.emit).toHaveBeenCalled();
  });

  it("the photo events stay PII-free — worker_id only, never a key or url", async () => {
    const { svc, events } = photoSetup({ info: okInfo });

    await svc.confirmPhoto(WORKER_ID, { storage_path: VALID_KEY }, CTX);

    const emitted = events.emit.mock.calls[0]![0] as {
      event_name: string;
      payload: Record<string, unknown>;
    };
    expect(emitted.event_name).toBe("worker.photo_uploaded");
    expect(emitted.payload).toEqual({ worker_id: WORKER_ID });
    // The storage key is a pointer to a face photo — it must never ride an event.
    expect(JSON.stringify(emitted.payload)).not.toContain("photos/");
  });
});

describe("WorkersService.updateResumePrefs — re-render when show_photo flips (A1)", () => {
  const KEY = `photos/${WORKER_ID}/0a1b2c3d-0000-4000-8000-000000000000.jpg`;

  it("re-renders when show_photo CHANGES and a photo exists", async () => {
    const { svc, repo, queue } = photoSetup({
      worker: {
        id: WORKER_ID,
        fullName: null,
        resumeShowPhoto: false,
        photoStorageKey: KEY,
      } as never,
    });
    repo.updateResumePrefs = vi.fn(async () => ({
      id: WORKER_ID,
      resumeShowPhoto: true,
      resumeNightShiftReady: false,
      photoStorageKey: KEY,
    })) as never;

    await svc.updateResumePrefs(WORKER_ID, { show_photo: true }, CTX);

    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-render when show_photo is UNCHANGED", async () => {
    const { svc, repo, queue } = photoSetup({
      worker: {
        id: WORKER_ID,
        fullName: null,
        resumeShowPhoto: true,
        photoStorageKey: KEY,
      } as never,
    });
    repo.updateResumePrefs = vi.fn(async () => ({
      id: WORKER_ID,
      resumeShowPhoto: true,
      resumeNightShiftReady: true,
      photoStorageKey: KEY,
    })) as never;

    await svc.updateResumePrefs(WORKER_ID, { night_shift_ready: true }, CTX);

    expect(queue.add).not.toHaveBeenCalled();
  });

  it("does NOT re-render when the flip changes nothing (no photo on file)", async () => {
    const { svc, repo, queue } = photoSetup({
      worker: {
        id: WORKER_ID,
        fullName: null,
        resumeShowPhoto: false,
        photoStorageKey: null,
      } as never,
    });
    repo.updateResumePrefs = vi.fn(async () => ({
      id: WORKER_ID,
      resumeShowPhoto: true,
      resumeNightShiftReady: false,
      photoStorageKey: null,
    })) as never;

    await svc.updateResumePrefs(WORKER_ID, { show_photo: true }, CTX);

    expect(queue.add).not.toHaveBeenCalled();
  });
});
