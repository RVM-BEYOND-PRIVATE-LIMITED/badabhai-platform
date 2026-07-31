import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  inviteApiBaseUrl,
  isWellFormedInviteCode,
  pingInviteClick,
  playStoreUrl,
  workerAppId,
} from "./invite-landing";

const CODE = "abcdef012345";

describe("playStoreUrl — the Play Install Referrer payload (blocker B4)", () => {
  it("attaches the referral code as a URL-ENCODED referrer (how a fresh install is attributed)", () => {
    const url = playStoreUrl(CODE);
    // Firebase Dynamic Links is gone; `referrer` is the ONLY channel that survives the
    // Play Store round-trip for a device that does not have the app yet.
    expect(url).toContain(`referrer=${encodeURIComponent(`bb_code=${CODE}`)}`);
    expect(url).toContain("bb_code%3D"); // the `=` MUST be encoded, or Play truncates it
    expect(url.startsWith("https://play.google.com/store/apps/details?id=")).toBe(true);
  });

  it("reads the app id from config, not a literal (test track vs production differ)", () => {
    process.env.NEXT_PUBLIC_WORKER_APP_ID = "in.badabhai.worker.staging";
    expect(workerAppId()).toBe("in.badabhai.worker.staging");
    expect(playStoreUrl(CODE)).toContain("id=in.badabhai.worker.staging");
    delete process.env.NEXT_PUBLIC_WORKER_APP_ID;
    expect(workerAppId()).toBe("in.badabhai.worker");
  });

  it("treats a BLANK env value as unset rather than building an id-less store URL", () => {
    process.env.NEXT_PUBLIC_WORKER_APP_ID = "   ";
    expect(workerAppId()).toBe("in.badabhai.worker");
    delete process.env.NEXT_PUBLIC_WORKER_APP_ID;
  });
});

describe("isWellFormedInviteCode — shape only, never an existence check", () => {
  it("accepts the 12-lowercase-hex shape both funnels mint", () => {
    expect(isWellFormedInviteCode(CODE)).toBe(true);
    expect(isWellFormedInviteCode("000000000000")).toBe(true);
  });

  it("rejects wrong length, uppercase, and anything path-ish", () => {
    for (const bad of ["abc", "ABCDEF012345", "abcdef0123456", "../../etc/passwd", ""]) {
      expect(isWellFormedInviteCode(bad)).toBe(false);
    }
  });
});

describe("pingInviteClick — best-effort, never blocks or breaks the render", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.PAYER_API_URL = "https://api.example.test";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PAYER_API_URL;
  });

  it("POSTs the PUBLIC click endpoint for a well-formed code", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await pingInviteClick(CODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.example.test/invites/${CODE}/click`);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
  });

  it("does not even call the API for a malformed code (nothing to attribute)", async () => {
    await pingInviteClick("not-a-code");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SWALLOWS a network failure — a funnel signal is never worth a broken landing page", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(pingInviteClick(CODE)).resolves.toBeUndefined();
  });

  it("SWALLOWS a non-2xx too (the response is ignored by contract — no oracle)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(pingInviteClick(CODE)).resolves.toBeUndefined();
  });

  it("bounds a hanging API with an abort signal so a slow backend cannot stall a 3G page", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(pingInviteClick(CODE, 5)).resolves.toBeUndefined();
  });

  it("falls back through PAYER_API_URL -> NEXT_PUBLIC_API_URL (no new deploy variable)", () => {
    expect(inviteApiBaseUrl()).toBe("https://api.example.test");
    delete process.env.PAYER_API_URL;
    process.env.NEXT_PUBLIC_API_URL = "https://public.example.test";
    expect(inviteApiBaseUrl()).toBe("https://public.example.test");
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(inviteApiBaseUrl()).toBe("http://localhost:3001");
  });
});
