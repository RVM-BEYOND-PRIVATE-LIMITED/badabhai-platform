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
