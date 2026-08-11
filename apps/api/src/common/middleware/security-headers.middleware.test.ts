import { describe, it, expect, vi } from "vitest";
import { securityHeadersMiddleware } from "./security-headers.middleware";

/**
 * PAY-SEC-08. These assertions pin the VALUES, not merely the presence of a header — a
 * `Content-Security-Policy: default-src *` would satisfy "has a CSP" while protecting nothing.
 */
function run() {
  const headers = new Map<string, string>();
  const removed: string[] = [];
  const res = {
    setHeader: vi.fn((k: string, v: string) => headers.set(k, v)),
    removeHeader: vi.fn((k: string) => removed.push(k)),
  };
  const next = vi.fn();
  securityHeadersMiddleware({} as never, res as never, next as never);
  return { headers, removed, next };
}

describe("securityHeadersMiddleware", () => {
  it("locks a JSON API down to no subresources and no framing", () => {
    const { headers } = run();
    expect(headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets nosniff, no-referrer, CORP and the crossdomain kill-switch", () => {
    const { headers } = run();
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-site");
    expect(headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
  });

  it("removes x-powered-by rather than overwriting it", () => {
    const { removed } = run();
    expect(removed).toContain("X-Powered-By");
  });

  /**
   * HSTS from behind a TLS-terminating proxy is a footgun: a local or staging deployment that
   * emits it pins the developer's browser to https for the entire domain. This asserts the
   * OMISSION is deliberate, so re-adding it is a conscious decision at the terminator.
   */
  it("does NOT emit Strict-Transport-Security (that belongs on the TLS terminator)", () => {
    const { headers } = run();
    expect(headers.has("Strict-Transport-Security")).toBe(false);
  });

  it("always continues the chain", () => {
    const { next } = run();
    expect(next).toHaveBeenCalledOnce();
  });
});
