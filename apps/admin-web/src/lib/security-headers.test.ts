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
 *
 * ── WHAT THIS FILE STRUCTURALLY CANNOT SEE, AND WHY THE SECOND RULE EXISTS ──────────────
 * It asserts on the CONFIG OBJECT, never on a served response, so it verifies what the rules
 * SAY and not what they DO. That gap was real and not theoretical: with `no-store` on `/:path*`
 * alone, a `curl -I` against a built server returned `Cache-Control: no-store` for
 * `/_next/static/chunks/<hash>.js`. Next applies `headers()` output first and only then decides
 * its own static caching, behind `if (!res.getHeader('cache-control') && ... nextStaticFolder)`
 * — a guard the `/:path*` rule makes permanently false, so `public, max-age=31536000, immutable`
 * never ran and every content-hashed chunk was re-downloaded on every navigation.
 *
 * The fix is the second rule, and the assertions below pin the property that makes it work:
 * `_next/static` must come AFTER `/:path*`, because Next's `resolve-routes` assembles matches
 * with `resHeaders[key] = value` and the last matching rule wins for a non-`set-cookie` key.
 * Reordering them silently restores the bug, so the ORDER is asserted, not just the contents.
 */

interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

const config = nextConfig as { headers: () => Promise<HeaderRule[]> };

/** The catch-all rule that carries the security headers and the page cache directive. */
async function catchAllRule(): Promise<HeaderRule> {
  const rules = await config.headers();
  return rules.find((r) => r.source === "/:path*")!;
}

describe("the portal's own security headers", () => {
  it("applies two rules: the catch-all, then the build-output override", async () => {
    const rules = await config.headers();
    expect(rules.map((r) => r.source)).toEqual(["/:path*", "/_next/static/:path*"]);
  });

  it("the static rule comes AFTER the catch-all, which is the only reason it wins", async () => {
    // Next merges every matching rule into one header bag with `resHeaders[key] = value`, so for
    // `Cache-Control` the LAST match is what ships. Swap these two and `_next/static` silently
    // goes back to `no-store` with every other assertion in this file still green — which is
    // exactly how the original bug looked.
    const rules = await config.headers();
    const catchAll = rules.findIndex((r) => r.source === "/:path*");
    const staticRule = rules.findIndex((r) => r.source === "/_next/static/:path*");
    expect(catchAll).toBeGreaterThanOrEqual(0);
    expect(staticRule).toBeGreaterThan(catchAll);
  });

  it("sets Cache-Control: no-store — a cached page is a name disclosed without an audit row", async () => {
    const rule = await catchAllRule();
    expect(rule.headers).toContainEqual({ key: "Cache-Control", value: "no-store" });
  });

  it("keeps the four headers that were already there", async () => {
    // Named individually rather than compared as a set, so a regression reads as "X went
    // missing" instead of "the array changed".
    const rule = await catchAllRule();
    expect(rule.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(rule.headers).toContainEqual({ key: "X-Content-Type-Options", value: "nosniff" });
    expect(rule.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    expect(rule.headers).toContainEqual({
      key: "X-Robots-Tag",
      value: "noindex, nofollow, noarchive",
    });
  });

  it("declares each header exactly once", async () => {
    // Two `Cache-Control` entries is not a doubled guarantee — Next emits both and the weaker
    // one can win at whatever sits in front. This is also the anti-vacuity check on the
    // `toContainEqual`s above: they cannot be satisfied by a duplicate-laden array.
    const rule = await catchAllRule();
    const keys = rule.headers.map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(5);
  });

  it("no PAGE header is set to a CACHEABLE directive by another name", async () => {
    // The failure mode this catches is `Cache-Control` staying put while someone adds a
    // `max-age` alongside it, or swaps `no-store` for the much weaker `no-cache` (which
    // permits storing the response and only requires revalidation).
    const rule = await catchAllRule();
    const cacheControl = rule.headers.find((h) => h.key === "Cache-Control")!.value;
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).not.toMatch(/max-age|public|immutable/);
  });

  it("the cacheable rule is scoped to `_next/static` ONLY, and sets nothing but Cache-Control", async () => {
    // The whole risk of adding a `public, immutable` rule to a portal that renders names is that
    // its SOURCE later widens. `_next/static` is safe because every file under it is named by a
    // content hash of itself and is compiled build output — no session, no operator data, no
    // name has ever been in one. `public/` is deliberately NOT included: those files are not
    // content-hashed, so an immutable directive there would pin a stale asset until the browser
    // cache is cleared.
    const rules = await config.headers();
    const staticRule = rules.find((r) => r.source === "/_next/static/:path*")!;
    expect(staticRule.source).toBe("/_next/static/:path*");
    expect(staticRule.headers).toEqual([
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ]);
  });

  it("no rule outside `_next/static` may permit caching", async () => {
    // Stated over ALL rules rather than over the two we know about, so a third rule added later
    // cannot introduce a cacheable page without failing here.
    const rules = await config.headers();
    for (const rule of rules) {
      if (rule.source === "/_next/static/:path*") continue;
      for (const header of rule.headers) {
        if (header.key !== "Cache-Control") continue;
        expect(header.value, `${rule.source} must not be cacheable`).toContain("no-store");
      }
    }
  });
});
