import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { StorageService } from "./storage.service";

const SUPABASE_URL = "https://project.supabase.co";
const SERVICE_KEY = "service-role-key";
const KEY = "voice-notes/11111111-1111-4111-8111-111111111111/aaaa.m4a";

const config = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  RESUMES_BUCKET: "worker-resumes",
} as unknown as ServerConfig;

describe("StorageService.createSignedUploadUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("POSTs the upload-sign endpoint with the service-role key and returns the absolute URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: `/object/upload/sign/voice-notes/${KEY}?token=tok` }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService(config);
    const res = await svc.createSignedUploadUrl(KEY, "voice-notes");

    const target = fetchMock.mock.calls[0]![0] as string;
    const init = fetchMock.mock.calls[0]![1] as { method: string; headers: Record<string, string> };
    expect(target).toBe(`${SUPABASE_URL}/storage/v1/object/upload/sign/voice-notes/${KEY}`);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer service-role-key");
    expect(res).toEqual({
      url: `${SUPABASE_URL}/storage/v1/object/upload/sign/voice-notes/${KEY}?token=tok`,
      expiresIn: 7200,
    });
  });

  it("accepts the legacy `signedURL` response key", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ signedURL: "/object/upload/sign/voice-notes/k?token=tok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService(config);
    const res = await svc.createSignedUploadUrl("k", "voice-notes");
    expect(res.url).toBe(`${SUPABASE_URL}/storage/v1/object/upload/sign/voice-notes/k?token=tok`);
  });

  it("a 403 names the CAUSE (rejected credentials) and stays PII-free — 503, not a blanket 500", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, json: async () => ({}), text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService(config);
    await svc.createSignedUploadUrl(KEY, "voice-notes").catch((e: Error) => {
      // The CAUSE, not just a status. A 401/403 from Storage means the
      // service-role key is missing/wrong/from another project — a server
      // CONFIG fault, so it must not masquerade as a 500 ("we crashed").
      expect(e.message).toBe("storage credentials rejected by Supabase");
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      // Still PII-free / secret-free: never the key, the signed URL, or the host.
      expect(e.message).not.toContain(SERVICE_KEY);
      expect(e.message).not.toContain(SUPABASE_URL);
      expect(e.message).not.toContain(KEY);
    });
    expect.assertions(5);
  });

  it("REGRESSION: a BARE 400 (no body) from sign-upload-url is a bucket problem, not a 500", async () => {
    // MEASURED IN PRODUCTION. WORKER_PHOTOS_BUCKET was set to "worker_profile_photos"
    // (underscores) with no such bucket in the project. Supabase answered
    // object/upload/sign/<bucket>/<key> with a BARE 400 — no "bucket" word, no
    // not_found body, nothing to pattern-match — so it fell through to a plain Error
    // and every photo upload became an opaque HTTP 500 for the worker.
    //
    // The object key cannot be at fault here: the server mints it itself (opaque UUID
    // under the worker's own prefix, ADR-0032), so a 400 leaves only the bucket.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService(config);
    await svc.createSignedUploadUrl(KEY, "worker_profile_photos").catch((e: Error) => {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      // Names the bucket — that is what makes it a one-line env fix.
      expect(e.message).toContain("worker_profile_photos");
      expect(e.message).toContain("does not exist");
      // Never the key or the credential.
      expect(e.message).not.toContain(SERVICE_KEY);
      expect(e.message).not.toContain(SUPABASE_URL);
    });
    expect.assertions(5);
  });

  it("a missing BUCKET is a 503 that names the bucket, so devops knows what to create", async () => {
    // Supabase answers an unknown bucket with a not-found body mentioning it.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => '{"statusCode":"404","error":"not_found","message":"Bucket not found"}',
    });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService(config);
    await svc.createSignedUploadUrl(KEY, "worker-profile-photos").catch((e: Error) => {
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect(e.message).toContain("worker-profile-photos");
      expect(e.message).toContain("does not exist");
    });
    expect.assertions(3);
  });

  it("throws when the response carries neither url nor signedURL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService(config);
    await expect(svc.createSignedUploadUrl(KEY, "voice-notes")).rejects.toThrow(
      "storage sign-upload-url response missing url",
    );
  });

  it("fails closed when Supabase Storage is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService({ RESUMES_BUCKET: "worker-resumes" } as unknown as ServerConfig);
    await expect(svc.createSignedUploadUrl(KEY, "voice-notes")).rejects.toThrow(
      "Supabase Storage is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// The current Supabase build answers a MISSING object on `object/info` with HTTP 400 +
// body {statusCode:"404", error:"not_found"} — not a plain 404. A status-only 404 check
// mis-read that as a hard error, so the interview-kit render-once cache probe threw on
// every uncached kit → 503, and photo-confirm read null → 400. These lock the fix.
describe("StorageService.objectExists — Supabase 'absent' shapes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("treats the current-build 400 + not_found body as ABSENT (false), not an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.objectExists("interview-kits/cnc_operator/v1/x.pdf", "interview-kits")).resolves.toBe(false);
  });

  it("treats a plain 404 as ABSENT (false) — older builds / other endpoints", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.objectExists("k", "interview-kits")).resolves.toBe(false);
  });

  it("returns true when the object is present (200)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ size: 10 }) });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.objectExists("k", "interview-kits")).resolves.toBe(true);
  });

  it("THROWS on a real 400 that is NOT a not-found (a bad request must not read as absent)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "InvalidRequest", message: "bad key" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.objectExists("k", "interview-kits")).rejects.toThrow(
      "storage object-info failed with status 400",
    );
  });

  it("THROWS on a transport 500 (must not silently re-render forever)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.objectExists("k", "interview-kits")).rejects.toThrow(
      "storage object-info failed with status 500",
    );
  });
});

describe("StorageService.getObjectInfo — field-shape + absent handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads the CURRENT build's snake_case `content_type` + top-level `size`", async () => {
    // Exactly the body observed from Supabase for a PUT'd image/jpeg object.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "x",
        name: "photos/w/uuid.jpg",
        size: 159,
        content_type: "image/jpeg",
        metadata: {},
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.getObjectInfo("photos/w/uuid.jpg", "worker-profile-photos")).resolves.toEqual({
      contentType: "image/jpeg",
      sizeBytes: 159,
    });
  });

  it("still reads the LEGACY `contentType` / `metadata.mimetype` shapes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ contentType: "image/png", metadata: { size: 42 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.getObjectInfo("k", "worker-profile-photos")).resolves.toEqual({
      contentType: "image/png",
      sizeBytes: 42,
    });
  });

  it("returns null (absent) on the current-build 400 + not_found body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ statusCode: "404", error: "not_found" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.getObjectInfo("k", "worker-profile-photos")).resolves.toBeNull();
  });

  it("returns null (absent) on a plain 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.getObjectInfo("k", "worker-profile-photos")).resolves.toBeNull();
  });

  it("THROWS on a non-not-found failure (503) rather than guessing absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.getObjectInfo("k", "worker-profile-photos")).rejects.toThrow(
      "storage object-info failed with status 503",
    );
  });
});

describe("StorageService.downloadObject — absent handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns null on 400 + not_found (worker has no photo yet)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "not_found" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    await expect(svc.downloadObject("photos/w/uuid.jpg", "worker-profile-photos")).resolves.toBeNull();
  });

  it("returns bytes on 200", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => bytes });
    vi.stubGlobal("fetch", fetchMock);
    const svc = new StorageService(config);
    const out = await svc.downloadObject("k", "worker-profile-photos");
    expect(out).toEqual(Buffer.from([1, 2, 3]));
  });
});
