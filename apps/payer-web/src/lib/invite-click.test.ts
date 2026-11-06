import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `/i/<code>` CLICK PING — best-effort, never blocks or breaks the render (blocker B4), now
 * server-only and through the API seam (#2542). The transport is the real `payerFetch`; only
 * `fetch` is stubbed. The visitor-IP header itself is pinned in visitor-ip-seam.test.ts.
 */

const CODE = "abcdef012345";
const fetchMock = vi.fn();

async function load() {
  return import("./invite-click");
}

beforeEach(() => {
  vi.resetModules(); // the API base is read once per module instance
  vi.stubEnv("PAYER_API_URL", "https://api.example.test");
  fetchMock.mockReset().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pingInviteClick — best-effort, never blocks or breaks the render", () => {
  it("POSTs the PUBLIC click endpoint for a well-formed code — no session token", async () => {
    const { pingInviteClick } = await load();
    await pingInviteClick(CODE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.example.test/invites/${CODE}/click`);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("authorization");
  });

  it("does not even call the API for a malformed code (nothing to attribute)", async () => {
    const { pingInviteClick } = await load();
    await pingInviteClick("not-a-code");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SWALLOWS a network failure — a funnel signal is never worth a broken landing page", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { pingInviteClick } = await load();
    await expect(pingInviteClick(CODE)).resolves.toBeUndefined();
  });

  it("SWALLOWS a non-2xx too (the response is ignored by contract — no oracle)", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const { pingInviteClick } = await load();
    await expect(pingInviteClick(CODE)).resolves.toBeUndefined();
  });

  it("bounds a hanging API with an abort signal so a slow backend cannot stall a 3G page", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { pingInviteClick } = await load();
    await expect(pingInviteClick(CODE, 5)).resolves.toBeUndefined();
  });

  it("calls the SERVER-side API base only — never a NEXT_PUBLIC_API_URL", async () => {
    vi.stubEnv("PAYER_API_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://public.example.test");
    const { pingInviteClick } = await load();
    await pingInviteClick(CODE);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`http://localhost:3001/invites/${CODE}/click`);
  });
});
