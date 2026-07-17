import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CATALOG } from "@badabhai/pricing";

/**
 * LIVE-catalog seam tests (context-drift D-6) — the fix's core contract:
 *  - a healthy `GET /payer/pricing/catalog` returns the WIRE products with live:true
 *    (an ops price edit reaches the portal with NO rebuild);
 *  - ANY failure (HTTP error / network reject / malformed body) fails OPEN to the
 *    compile-time DEFAULT_CATALOG products with live:false — the pages render the
 *    "cached pricing" note instead of a blank page (the server still enforces real
 *    prices at charge time, XT5).
 *
 * Exercises the REAL transport (`payerFetch`) with a mocked global fetch + a mocked
 * payer-JWT cookie, exactly like payer-api.test.ts.
 */

const TOKEN = "payer.jwt.token";

vi.mock("./auth/session-cookie", () => ({
  readApiToken: vi.fn(async () => TOKEN),
  API_TOKEN_COOKIE_NAME: "bb_payer_token",
  sessionCookieOptions: () => ({}),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.PAYER_API_URL = "http://api.test";
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A LIVE catalog wire body: the DEFAULT products with the unlock pack re-priced by ops. */
function livePriceEditedProducts() {
  return DEFAULT_CATALOG.products.map((p) =>
    p.kind === "credit_pack" && p.code === "contact_unlock"
      ? { ...p, tiers: p.tiers.map((t) => ({ ...t, priceInr: t.priceInr + 500 })) }
      : p,
  );
}

describe("getLiveCatalog — LIVE read of GET /payer/pricing/catalog (Bearer, D-6)", () => {
  it("returns the WIRE products (an ops edit, not the compile-time default) with live:true", async () => {
    const products = livePriceEditedProducts();
    fetchMock.mockResolvedValue(jsonResponse({ revision: 7, source: "db", products }));
    const { getLiveCatalog } = await import("./live-catalog");
    const res = await getLiveCatalog();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/payer/pricing/catalog");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBeUndefined(); // a GET carries no body — no place for a payer_id

    expect(res.live).toBe(true);
    // The edited price came through — NOT the compile-time DEFAULT_CATALOG figure.
    const pack = res.products.find((p) => p.kind === "credit_pack");
    const defaultPack = DEFAULT_CATALOG.products.find((p) => p.kind === "credit_pack");
    expect(pack).toBeDefined();
    expect(pack!.tiers[0]!.priceInr).toBe(defaultPack!.tiers[0]!.priceInr + 500);
  });

  it("a server 'default' provenance still renders as live (it IS what the server charges)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ revision: 0, source: "default", products: DEFAULT_CATALOG.products }),
    );
    const { getLiveCatalog } = await import("./live-catalog");
    const res = await getLiveCatalog();
    expect(res.live).toBe(true);
  });

  it("an HTTP failure fails OPEN to DEFAULT_CATALOG products with live:false (cached-pricing note)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "boom" }, 503));
    const { getLiveCatalog } = await import("./live-catalog");
    const res = await getLiveCatalog();
    expect(res.live).toBe(false);
    expect(res.products).toBe(DEFAULT_CATALOG.products);
  });

  it("a network reject fails OPEN the same way (never a thrown/blank page)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { getLiveCatalog } = await import("./live-catalog");
    await expect(getLiveCatalog()).resolves.toEqual({
      products: DEFAULT_CATALOG.products,
      live: false,
    });
  });

  it("a malformed wire body (schema drift) fails OPEN — never renders unvalidated prices", async () => {
    // `products` present but not the pricing shape — Zod must reject → fallback.
    fetchMock.mockResolvedValue(
      jsonResponse({ revision: 1, source: "db", products: [{ kind: "credit_pack", tiers: "?" }] }),
    );
    const { getLiveCatalog } = await import("./live-catalog");
    const res = await getLiveCatalog();
    expect(res.live).toBe(false);
    expect(res.products).toBe(DEFAULT_CATALOG.products);
  });
});
