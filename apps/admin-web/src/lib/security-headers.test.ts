import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config.mjs";

/**
 * The response headers this ORIGIN asserts for itself.
 *
 * ── WHY THIS IS TESTED AND NOT JUST WRITTEN DOWN ────────────────────────────────────────
 * The box is nginx-fronted and that nginx config is NOT in this repo. So every guarantee this
 * portal makes about its own responses has to be made by the origin: a header the proxy happens
 * to add today is one box change away from being gone, and nothing in this repository would
 * notice. The five below are the whole set, and `Cache-Control` is the one that changed on
 * 2026-08-18 — since the name ruling these pages carry decrypted worker, organisation and admin
 * names, and a shared cache holding one is a disclosure with no audit row and no budget charged.
 *
 * The config is imported and CALLED rather than grepped: `headers()` is an async function Next
 * invokes, and a test that read the file as text would keep passing if the return were wrapped
 * in a condition that is false in production.
 */

interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

const config = nextConfig as { headers: () => Promise<HeaderRule[]> };

describe("the portal's own security headers", () => {
  it("applies one rule, to every path", async () => {
    const rules = await config.headers();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe("/:path*");
  });

  it("sets Cache-Control: no-store — a cached page is a name disclosed without an audit row", async () => {
    const [rule] = await config.headers();
    expect(rule!.headers).toContainEqual({ key: "Cache-Control", value: "no-store" });
  });

  it("keeps the four headers that were already there", async () => {
    // Named individually rather than compared as a set, so a regression reads as "X went
    // missing" instead of "the array changed".
    const [rule] = await config.headers();
    expect(rule!.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(rule!.headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    expect(rule!.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    expect(rule!.headers).toContainEqual({
      key: "X-Robots-Tag",
      value: "noindex, nofollow, noarchive",
    });
  });

  it("declares each header exactly once", async () => {
    // Two `Cache-Control` entries is not a doubled guarantee — Next emits both and the weaker
    // one can win at whatever sits in front. This is also the anti-vacuity check on the
    // `toContainEqual`s above: they cannot be satisfied by a duplicate-laden array.
    const [rule] = await config.headers();
    const keys = rule!.headers.map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(5);
  });

  it("no header is set to a CACHEABLE directive by another name", async () => {
    // The failure mode this catches is `Cache-Control` staying put while someone adds a
    // `max-age` alongside it, or swaps `no-store` for the much weaker `no-cache` (which
    // permits storing the response and only requires revalidation).
    const [rule] = await config.headers();
    const cacheControl = rule!.headers.find((h) => h.key === "Cache-Control")!.value;
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).not.toMatch(/max-age|public|immutable/);
  });
});
