import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { StorageService } from "./storage.service";

const SUPABASE_URL = "https://project.supabase.co";
const KEY = "voice-notes/11111111-1111-4111-8111-111111111111/aaaa.m4a";

const config = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
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

  it("throws a PII-free error on a non-2xx response (no key/URL in the message)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const svc = new StorageService(config);
    await svc.createSignedUploadUrl(KEY, "voice-notes").catch((e: Error) => {
      expect(e.message).toBe("storage sign-upload-url failed with status 403");
    });
    expect.assertions(1);
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
