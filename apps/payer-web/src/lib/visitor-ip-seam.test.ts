import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * THE SEAMS CARRY THE VISITOR IP (#2542) — `payerFetch` (every payer API call) and the `/i/<code>`
 * click ping, through the REAL helper (lib/visitor-ip.ts); only the incoming request headers,
 * the httpOnly cookie reader and `fetch` are stubbed.
 *
 * Pinned: the call carries ONE `x-forwarded-for` (the last incoming entry) when the helper
 * returns one, none otherwise, and the call proceeds either way; the incoming chain, `x-real-ip`
 * and `forwarded` never ride along, and neither does an internal-service token.
 */

const headersImpl = vi.fn<() => Promise<Headers>>();
vi.mock("next/headers", () => ({ headers: () => headersImpl(), cookies: vi.fn() }));
vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => "payer.jwt.token"),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

vi.stubEnv("PAYER_API_URL", "http://api.test");
vi.stubEnv("INTERNAL_SERVICE_TOKEN", "internal-secret-must-never-leave");
const { payerFetch } = await import("./payer-http");
const { pingInviteClick } = await import("./invite-click");

/** What nginx + a forging client hand payer-web: a chain, x-real-ip and forwarded. */
const INCOMING = {
  "x-forwarded-for": "6.6.6.6, 203.0.113.7",
  "x-real-ip": "203.0.113.7",
  forwarded: "for=6.6.6.6;proto=https",
};

beforeEach(() => {
  headersImpl.mockReset().mockResolvedValue(new Headers(INCOMING));
  fetchMock.mockReset().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The outgoing headers of the one fetch call, keys lowercased. */
function sentHeaders(): Record<string, string> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0]![1]!;
  return Object.fromEntries(
    Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

/** Nothing but the plain header set — no chain, no x-real-ip/forwarded, no internal token. */
function expectNoLeak(sent: Record<string, string>) {
  expect(sent).not.toHaveProperty("x-real-ip");
  expect(sent).not.toHaveProperty("forwarded");
  for (const [key, value] of Object.entries(sent)) {
    expect(key).not.toMatch(/internal|service-token/i);
    expect(value).not.toContain("internal-secret-must-never-leave");
    expect(value).not.toContain("6.6.6.6");
  }
}

describe("payerFetch carries the visitor IP", () => {
  it("an authed call: the last entry as x-forwarded-for, beside the Bearer — nothing else", async () => {
    await payerFetch("/payer/me", { schema: z.unknown() });
    const sent = sentHeaders();
    expect(sent).toStrictEqual({
      "x-forwarded-for": "203.0.113.7",
      "content-type": "application/json",
      authorization: "Bearer payer.jwt.token",
    });
    expectNoLeak(sent);
  });

  it("a public call (sign-in) carries it too — the per-IP OTP cap's key", async () => {
    await payerFetch("/payer/login/request", {
      method: "POST",
      public: true,
      body: { email: "a@b.test" },
      schema: z.unknown(),
    });
    const sent = sentHeaders();
    expect(sent).toStrictEqual({
      "x-forwarded-for": "203.0.113.7",
      "content-type": "application/json",
    });
    expectNoLeak(sent);
  });

  it("a non-public visitor sends no x-forwarded-for, and the call still goes out", async () => {
    headersImpl.mockResolvedValue(
      new Headers({ "x-forwarded-for": "172.18.0.1", "x-real-ip": "1.1.1.1" }),
    );
    await payerFetch("/payer/me", { schema: z.unknown() });
    const sent = sentHeaders();
    expect(sent).not.toHaveProperty("x-forwarded-for");
    expectNoLeak(sent);
  });

  it("headers() throwing sends no x-forwarded-for, and the API call still proceeds", async () => {
    headersImpl.mockImplementation(() => {
      throw new Error("`headers` was called outside a request scope.");
    });
    await expect(payerFetch("/payer/me", { schema: z.unknown() })).resolves.toEqual({ ok: true });
    expect(sentHeaders()).not.toHaveProperty("x-forwarded-for");
  });
});

describe("the invite click ping goes through the seam (server-only) and carries it", () => {
  it("POSTs PAYER_API_URL's click endpoint with the visitor IP and NO session token", async () => {
    await pingInviteClick("abcdef012345");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/invites/abcdef012345/click");
    expect(init!.method).toBe("POST");
    const sent = sentHeaders();
    expect(sent).toStrictEqual({
      "x-forwarded-for": "203.0.113.7",
      "content-type": "application/json",
    });
    expectNoLeak(sent);
  });

  it("with headers() throwing it still pings — without the header", async () => {
    headersImpl.mockRejectedValue(new Error("no request scope"));
    await pingInviteClick("abcdef012345");
    expect(sentHeaders()).not.toHaveProperty("x-forwarded-for");
  });
});
