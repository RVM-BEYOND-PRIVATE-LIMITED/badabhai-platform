import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { createEvent } from "@badabhai/event-schema";
import { AccountDeletionService } from "./account-deletion.service";
import type { WorkersRepository } from "../workers/workers.repository";
import type { SessionService } from "./session.service";
import type { StorageService } from "../storage/storage.service";
import type { EventsService } from "../events/events.service";
import type { Queue } from "bullmq";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const PHONE_HASH = "ph_hash_abc";

// Sentinel raw-PII values that the no-PII assertion (#5) hunts for across the emitted
// event AND every logger call. NONE of these may ever surface in the deletion record.
const RAW_PHONE = "+919876512345";
const FULL_NAME = "Ramesh Kumar Yadav";
const OTP_CODE = "482915";
const RESUME_KEY = "a1b2c3d4-resume-object-key.pdf";
// A worker-scoped audio object path (PII-adjacent) — must never reach a log/event either.
const VOICE_KEY = "worker9876512345/sess-7/voice-note-v1.ogg";

interface Harness {
  svc: AccountDeletionService;
  workers: {
    findById: ReturnType<typeof vi.fn>;
    listResumeStorageKeys: ReturnType<typeof vi.fn>;
    listVoiceStorageKeys: ReturnType<typeof vi.fn>;
    hasCredentials: ReturnType<typeof vi.fn>;
    countDevices: ReturnType<typeof vi.fn>;
    hardDelete: ReturnType<typeof vi.fn>;
  };
  sessions: { revokeAll: ReturnType<typeof vi.fn> };
  storage: { deletePdf: ReturnType<typeof vi.fn>; deleteByPrefix: ReturnType<typeof vi.fn> };
  events: { emit: ReturnType<typeof vi.fn> };
  redisSet: ReturnType<typeof vi.fn>;
}

function make(
  opts: {
    missingWorker?: boolean;
    resumeKeys?: string[];
    voiceKeys?: string[];
    voiceBucket?: string;
    photoBucket?: string;
    hadPin?: boolean;
    devices?: number;
    sessions?: number;
    cooldown?: number;
  } = {},
): Harness {
  const redisSet = vi.fn(async () => "OK");
  const workerRow = opts.missingWorker
    ? undefined
    : { id: WORKER_ID, phoneHash: PHONE_HASH, status: "active" };
  const workers = {
    findById: vi.fn(async (): Promise<Record<string, unknown> | undefined> => workerRow),
    listResumeStorageKeys: vi.fn(async () => opts.resumeKeys ?? []),
    listVoiceStorageKeys: vi.fn(async () => opts.voiceKeys ?? []),
    hasCredentials: vi.fn(async () => opts.hadPin ?? false),
    countDevices: vi.fn(async () => opts.devices ?? 0),
    hardDelete: vi.fn(async () => true),
  };

  const sessions = { revokeAll: vi.fn(async () => opts.sessions ?? 0) };
  const storage = {
    deletePdf: vi.fn(async () => undefined),
    deleteByPrefix: vi.fn(async () => 0),
  };
  const events = { emit: vi.fn(async () => undefined) };
  const queue = { client: Promise.resolve({ set: redisSet }) } as unknown as Queue;
  const config = {
    RESUMES_BUCKET: "worker-resumes",
    CONVERSATIONS_BUCKET: "worker-conversations",
    // Default "" mirrors the real default: voice upload is a Phase-1 placeholder with no
    // backend audio bucket, so audio erasure is DORMANT until VOICE_NOTES_BUCKET is set.
    VOICE_NOTES_BUCKET: opts.voiceBucket ?? "",
    // ADR-0032: same dormant default; setting it arms the photo prefix-sweep leg.
    WORKER_PHOTOS_BUCKET: opts.photoBucket ?? "",
    ACCOUNT_DELETION_COOLDOWN_SECONDS: opts.cooldown ?? 604800,
  } as ServerConfig;

  const svc = new AccountDeletionService(
    config,
    workers as unknown as WorkersRepository,
    sessions as unknown as SessionService,
    storage as unknown as StorageService,
    events as unknown as EventsService,
    queue,
  );
  return { svc, workers, sessions, storage, events, redisSet };
}

describe("AccountDeletionService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path: revoke → capture → erase storage → hard-delete → tombstone → PII-free event", async () => {
    const h = make({
      resumeKeys: ["k1.pdf", "k2.pdf"],
      hadPin: true,
      devices: 2,
      sessions: 3,
    });
    h.storage.deleteByPrefix.mockResolvedValueOnce(1); // one archived conversation object

    await h.svc.execute(WORKER_ID);

    // Order-critical: revoke BEFORE the hard-delete (never half-auth a deleted worker).
    expect(h.sessions.revokeAll).toHaveBeenCalledWith(WORKER_ID);
    expect(h.workers.hardDelete).toHaveBeenCalledWith(WORKER_ID);
    // Resume keys captured + each PDF deleted in the resumes bucket.
    expect(h.storage.deletePdf).toHaveBeenCalledTimes(2);
    expect(h.storage.deletePdf).toHaveBeenCalledWith("k1.pdf", "worker-resumes");
    // Conversations erased by the worker prefix.
    expect(h.storage.deleteByPrefix).toHaveBeenCalledWith(`${WORKER_ID}/`, "worker-conversations");
    // Tombstone set on the PII-free phone_hash with the cool-down TTL.
    expect(h.redisSet).toHaveBeenCalledWith(`deleted_phone:${PHONE_HASH}`, "1", "EX", 604800);

    // The event is PII-free: counts/flags + opaque worker id only.
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.event_name).toBe("worker.account_deleted");
    expect(emitted.payload).toEqual({
      worker_id: WORKER_ID,
      sessions_revoked: 3,
      devices_revoked: 2,
      storage_objects_deleted: 3, // 2 resume + 1 conversation
      storage_objects_failed: 0,
      had_pin: true,
    });
    // No phone, phone_hash, name, or resume key in the event payload.
    expect(JSON.stringify(emitted.payload)).not.toContain(PHONE_HASH);
    expect(JSON.stringify(emitted.payload)).not.toMatch(/\.pdf/);
  });

  it("idempotent: a missing worker is a clean no-op (no revoke, no delete, no event)", async () => {
    const h = make({ missingWorker: true });
    await h.svc.execute(WORKER_ID);
    expect(h.sessions.revokeAll).not.toHaveBeenCalled();
    expect(h.workers.hardDelete).not.toHaveBeenCalled();
    expect(h.storage.deletePdf).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.redisSet).not.toHaveBeenCalled();
  });

  it("a storage hiccup increments storage_objects_failed and STILL completes the DB erasure", async () => {
    const h = make({ resumeKeys: ["good.pdf", "bad.pdf"], sessions: 1 });
    h.storage.deletePdf
      .mockResolvedValueOnce(undefined) // good.pdf
      .mockRejectedValueOnce(new Error("storage delete failed with status 500")); // bad.pdf

    await h.svc.execute(WORKER_ID);

    // The DB delete + event STILL ran despite the storage failure (best-effort-complete).
    expect(h.workers.hardDelete).toHaveBeenCalledWith(WORKER_ID);
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.storage_objects_deleted).toBe(1);
    expect(emitted.payload.storage_objects_failed).toBe(1);
  });

  it("tombstone is fail-OPEN: a Redis error does NOT abort the already-completed erasure", async () => {
    const h = make({ sessions: 0 });
    h.redisSet.mockRejectedValueOnce(new Error("redis down"));
    await expect(h.svc.execute(WORKER_ID)).resolves.toBeUndefined();
    expect(h.workers.hardDelete).toHaveBeenCalledWith(WORKER_ID);
    expect(h.events.emit).toHaveBeenCalledTimes(1); // event still emitted
  });

  it("skips the tombstone when the cool-down is disabled (0)", async () => {
    const h = make({ cooldown: 0 });
    await h.svc.execute(WORKER_ID);
    expect(h.redisSet).not.toHaveBeenCalled();
    expect(h.workers.hardDelete).toHaveBeenCalled();
  });

  // ---- ADR-0026 Phase 5 — added coverage (QA gap-closure) ----

  it("STRICT ORDER: revokeAll fires BEFORE hardDelete which fires BEFORE the event emit (D4)", async () => {
    // The class doc mandates: revoke FIRST (never half-auth a deleted worker), then capture +
    // erase, then the atomic DB delete, then tombstone, then the durable event. Assert the
    // wall-clock invocation order via vitest's per-mock invocationCallOrder, not just "called".
    const h = make({ resumeKeys: ["k1.pdf"], sessions: 1, devices: 1, hadPin: true });
    await h.svc.execute(WORKER_ID);

    const revokeOrder = h.sessions.revokeAll.mock.invocationCallOrder[0]!;
    const deletePdfOrder = h.storage.deletePdf.mock.invocationCallOrder[0]!;
    const hardDeleteOrder = h.workers.hardDelete.mock.invocationCallOrder[0]!;
    const tombstoneOrder = h.redisSet.mock.invocationCallOrder[0]!;
    const emitOrder = h.events.emit.mock.invocationCallOrder[0]!;

    // revoke is the very first side-effecting step; the storage erase + DB delete + tombstone
    // + event all follow it, in that order.
    expect(revokeOrder).toBeLessThan(deletePdfOrder);
    expect(deletePdfOrder).toBeLessThan(hardDeleteOrder);
    expect(hardDeleteOrder).toBeLessThan(tombstoneOrder);
    expect(tombstoneOrder).toBeLessThan(emitOrder);
  });

  it("had_pin=false variant: a worker with no PIN reports had_pin:false in the event", async () => {
    const h = make({ hadPin: false, sessions: 2, devices: 1 });
    await h.svc.execute(WORKER_ID);
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.had_pin).toBe(false);
    expect(emitted.payload.sessions_revoked).toBe(2);
    expect(emitted.payload.devices_revoked).toBe(1);
  });

  it("devices_revoked + had_pin are SOURCED PRE-DELETE (counted before hardDelete erases them)", async () => {
    // The cascade erases worker_devices + worker_credentials, so the counts must be read
    // BEFORE hardDelete or they would always be 0/false. Assert both reads precede hardDelete.
    const h = make({ devices: 3, hadPin: true, sessions: 1 });
    await h.svc.execute(WORKER_ID);

    const countDevicesOrder = h.workers.countDevices.mock.invocationCallOrder[0]!;
    const hasCredentialsOrder = h.workers.hasCredentials.mock.invocationCallOrder[0]!;
    const listKeysOrder = h.workers.listResumeStorageKeys.mock.invocationCallOrder[0]!;
    const hardDeleteOrder = h.workers.hardDelete.mock.invocationCallOrder[0]!;

    expect(countDevicesOrder).toBeLessThan(hardDeleteOrder);
    expect(hasCredentialsOrder).toBeLessThan(hardDeleteOrder);
    // Resume keys must be captured pre-cascade too (D4 — the cascade erases generated_resumes).
    expect(listKeysOrder).toBeLessThan(hardDeleteOrder);

    // And the captured values reach the event verbatim.
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.devices_revoked).toBe(3);
    expect(emitted.payload.had_pin).toBe(true);
  });

  it("the conversation-prefix delete failing increments storage_objects_failed but STILL completes", async () => {
    // Companion to the resume-PDF failure case: the SECOND storage leg (deleteByPrefix) can
    // also throw; it must be counted and never abort the DB erasure.
    const h = make({ resumeKeys: ["ok.pdf"], sessions: 1 });
    h.storage.deleteByPrefix.mockRejectedValueOnce(new Error("storage batch-delete failed with status 503"));
    await h.svc.execute(WORKER_ID);

    expect(h.workers.hardDelete).toHaveBeenCalledWith(WORKER_ID);
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.storage_objects_deleted).toBe(1); // the one good resume pdf
    expect(emitted.payload.storage_objects_failed).toBe(1); // the failed prefix leg
  });

  // ---- ADR-0026 Phase 5 — security Finding 1: voice-note AUDIO erasure (launch-gate seam) ----

  it("VOICE BUCKET SET: voice keys are captured pre-delete + erased per key in VOICE_NOTES_BUCKET", async () => {
    const h = make({
      resumeKeys: ["r1.pdf"],
      voiceKeys: ["worker/sess/v1.ogg", "worker/sess/v2.ogg"],
      voiceBucket: "worker-audio",
      sessions: 1,
    });
    h.storage.deleteByPrefix.mockResolvedValueOnce(0);

    await h.svc.execute(WORKER_ID);

    // Voice keys captured BEFORE the cascade erases voice_notes.
    const listVoiceOrder = h.workers.listVoiceStorageKeys.mock.invocationCallOrder[0]!;
    const hardDeleteOrder = h.workers.hardDelete.mock.invocationCallOrder[0]!;
    expect(listVoiceOrder).toBeLessThan(hardDeleteOrder);

    // Each audio blob deleted in the configured audio bucket (NOT the resumes bucket).
    expect(h.storage.deletePdf).toHaveBeenCalledWith("worker/sess/v1.ogg", "worker-audio");
    expect(h.storage.deletePdf).toHaveBeenCalledWith("worker/sess/v2.ogg", "worker-audio");

    // 1 resume + 2 audio = 3 storage objects deleted, all counted.
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.storage_objects_deleted).toBe(3);
    expect(emitted.payload.storage_objects_failed).toBe(0);
  });

  it("VOICE BUCKET UNSET (default ''): audio erase is DORMANT — deletePdf NOT called for voice keys", async () => {
    // The dormant seam: voiceKeys exist on rows but with no backend audio bucket today the erase
    // is skipped (no speculative behavior). Only the resume PDF leg deletes.
    const h = make({
      resumeKeys: ["r1.pdf"],
      voiceKeys: ["worker/sess/v1.ogg", "worker/sess/v2.ogg"],
      sessions: 1,
    });
    h.storage.deleteByPrefix.mockResolvedValueOnce(0);

    await h.svc.execute(WORKER_ID);

    // deletePdf was called ONLY for the resume key, never for an audio key (dormant).
    expect(h.storage.deletePdf).toHaveBeenCalledTimes(1);
    expect(h.storage.deletePdf).toHaveBeenCalledWith("r1.pdf", "worker-resumes");
    expect(h.storage.deletePdf).not.toHaveBeenCalledWith("worker/sess/v1.ogg", expect.anything());

    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.storage_objects_deleted).toBe(1); // resume only
  });

  it("PHOTO BUCKET SET (ADR-0032): the worker's photo prefix is swept BEFORE hardDelete and counted", async () => {
    const h = make({
      resumeKeys: ["r1.pdf"],
      photoBucket: "worker-profile-photos",
      sessions: 1,
    });
    // conversations sweep finds nothing; the photo sweep finds the live photo + one orphan.
    h.storage.deleteByPrefix.mockImplementation(async (prefix: string) =>
      prefix.startsWith("photos/") ? 2 : 0,
    );

    await h.svc.execute(WORKER_ID);

    // PREFIX sweep (catches orphans + superseded objects), in the photos bucket,
    // scoped to exactly this worker's own prefix.
    expect(h.storage.deleteByPrefix).toHaveBeenCalledWith(
      `photos/${WORKER_ID}/`,
      "worker-profile-photos",
    );
    // Erase-before-delete ordering holds for the photo leg too.
    const photoCall = h.storage.deleteByPrefix.mock.calls.findIndex((c) =>
      String(c[0]).startsWith("photos/"),
    );
    const photoOrder = h.storage.deleteByPrefix.mock.invocationCallOrder[photoCall]!;
    expect(photoOrder).toBeLessThan(h.workers.hardDelete.mock.invocationCallOrder[0]!);

    // 1 resume + 2 photo objects, folded into the EXISTING counters (payload unchanged, v1 strict).
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.storage_objects_deleted).toBe(3);
    expect(emitted.payload.storage_objects_failed).toBe(0);
  });

  it("PHOTO BUCKET UNSET (default ''): the photo sweep is DORMANT — no photos/ prefix delete", async () => {
    const h = make({ resumeKeys: ["r1.pdf"], sessions: 1 });
    h.storage.deleteByPrefix.mockResolvedValue(0);

    await h.svc.execute(WORKER_ID);

    const photoCalls = h.storage.deleteByPrefix.mock.calls.filter((c) =>
      String(c[0]).startsWith("photos/"),
    );
    expect(photoCalls).toHaveLength(0); // only the conversations prefix ran
  });

  it("PHOTO sweep failure increments storage_objects_failed and STILL completes the erasure", async () => {
    const h = make({ photoBucket: "worker-profile-photos", sessions: 1 });
    h.storage.deleteByPrefix.mockImplementation(async (prefix: string) => {
      if (prefix.startsWith("photos/")) throw new Error("storage list failed with status 500");
      return 0;
    });

    await h.svc.execute(WORKER_ID);

    expect(h.workers.hardDelete).toHaveBeenCalled(); // erasure never aborted
    const emitted = h.events.emit.mock.calls[0]![0];
    expect(emitted.payload.storage_objects_failed).toBe(1);
  });

  it("CRITICAL no-PII: NO raw phone / name / OTP / resume key in the event OR any logger call", async () => {
    // Capture EVERY Logger.prototype call (log + warn + error) across the whole run, then assert
    // none of the sentinel raw-PII values appear there or in the emitted event payload. We seed
    // the run with raw-PII-looking RESUME keys and force a failure so the warn path also fires.
    const logged: string[] = [];
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      }),
    );

    try {
      const h = make({
        resumeKeys: [RESUME_KEY, "second.pdf"],
        // Seed the VOICE path too (bucket SET) so the audio-delete loop + its warn fire and the
        // no-PII assertion covers the voice leg. The audio storage_path is worker-scoped (PII-
        // adjacent) and must never reach a log/event.
        voiceKeys: [VOICE_KEY],
        voiceBucket: "worker-audio",
        hadPin: true,
        devices: 2,
        sessions: 3,
      });
      // Force a storage failure whose Error message embeds the raw PII (worst case: a provider
      // error string carrying the object key). The service must log only the reason CLASS,
      // never the key/phone. Order: resume[0] ok, resume[1] fail, voice[0] fail.
      h.storage.deletePdf
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("storage delete failed with status 500"))
        .mockRejectedValueOnce(new Error("storage delete failed with status 500"));

      await h.svc.execute(WORKER_ID);

      const emitted = h.events.emit.mock.calls[0]![0];
      const eventJson = JSON.stringify(emitted);
      const logJson = logged.join("\n");

      // 1) The event payload carries ONLY the opaque worker_id + numeric counts + had_pin.
      expect(Object.keys(emitted.payload).sort()).toEqual(
        [
          "worker_id",
          "sessions_revoked",
          "devices_revoked",
          "storage_objects_deleted",
          "storage_objects_failed",
          "had_pin",
        ].sort(),
      );

      // 2) NO raw PII anywhere in the event or the logs (incl. the voice audio path).
      for (const secret of [RAW_PHONE, FULL_NAME, OTP_CODE, RESUME_KEY, VOICE_KEY, PHONE_HASH]) {
        expect(eventJson, `event must not contain ${secret}`).not.toContain(secret);
        expect(logJson, `logs must not contain ${secret}`).not.toContain(secret);
      }
      // 3) No resume object key (*.pdf) or audio object key (*.ogg) in event or logs.
      expect(eventJson).not.toMatch(/\.pdf|\.ogg/);
      expect(logJson).not.toMatch(/\.pdf|\.ogg/);
      // 4) No phone-looking digit run — EXCLUDING the opaque worker_id, which is permitted (§2)
      // and legitimately contains digits. Strip every occurrence of the worker_id first, then
      // assert no 10+ contiguous-digit (phone-shaped) run remains.
      const stripWorkerId = (s: string): string => s.split(WORKER_ID).join("");
      expect(stripWorkerId(eventJson)).not.toMatch(/\d{10}/);
      expect(stripWorkerId(logJson)).not.toMatch(/\d{10}/);

      // 5) The emitted PAYLOAD validates against worker.account_deleted v1 (.strict()): pass the
      // captured emit input through createEvent (which calls assertValidEvent + applies the
      // registry version). A strict-schema violation (any smuggled extra/PII field) would throw.
      expect(() =>
        createEvent({
          event_name: "worker.account_deleted",
          actor: emitted.actor,
          subject: emitted.subject,
          payload: emitted.payload,
          source: "api",
          metadata: { environment: "test", service: "api" },
        }),
      ).not.toThrow();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
