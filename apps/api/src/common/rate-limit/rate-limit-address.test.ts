import { describe, expect, it } from "vitest";
import { rateLimitAddress } from "./rate-limit-address";

/**
 * #2542 — what a per-IP rate limit counts against. The property that matters is that one IPv6
 * subscriber (a /64) is ONE bucket, however many of its addresses it rotates through, while IPv4
 * keys are untouched (so live buckets keep counting across the deploy).
 */
describe("rateLimitAddress", () => {
  it("leaves IPv4 and non-addresses exactly as they were", () => {
    expect(rateLimitAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitAddress("unknown")).toBe("unknown");
    expect(rateLimitAddress("")).toBe("");
  });

  it("an IPv4-mapped IPv6 peer counts as the IPv4 address it carries", () => {
    expect(rateLimitAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitAddress("::FFFF:172.18.0.1")).toBe("172.18.0.1");
  });

  it("every address in one /64 lands in ONE bucket, whatever its spelling", () => {
    const a = rateLimitAddress("2001:db8:abcd:12::1");
    expect(a).toBe("2001:db8:abcd:12::/64");
    for (const same of [
      "2001:db8:abcd:12:ffff:ffff:ffff:ffff",
      "2001:0DB8:ABCD:0012:0000:0000:0000:0042",
      "2001:db8:abcd:12:1:2:3:4",
      "2001:db8:abcd:12::1%eth0",
    ]) {
      expect(rateLimitAddress(same), same).toBe(a);
    }
  });

  it("a different /64 is a different bucket", () => {
    expect(rateLimitAddress("2001:db8:abcd:13::1")).not.toBe(rateLimitAddress("2001:db8:abcd:12::1"));
    expect(rateLimitAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });

  it("expands '::' at the start and an embedded IPv4 tail", () => {
    expect(rateLimitAddress("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitAddress("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });
});
