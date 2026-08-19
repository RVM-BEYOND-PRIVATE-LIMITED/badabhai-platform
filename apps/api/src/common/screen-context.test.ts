import { describe, it, expect } from "vitest";
import { WORKER_FEEDBACK_SCREEN_MAX } from "@badabhai/types";

import { sanitizeScreenContext } from "./screen-context";

/**
 * `sanitizeScreenContext` is the ONLY thing standing between an untrusted client and three
 * sinks that must never hold an identifier: the `worker_feedback` row, the `feedback.submitted`
 * event, and the API log line. So this file is written around two questions, in this order.
 *
 *  1. DOES IT STRIP IDENTIFIERS? A path is the natural carrier for one — every entity on this
 *     platform is a uuid in a URL — and the whole reason the column stores a PATTERN is that
 *     `/jobs/<uuid>` links a feedback row to one specific job. A normalizer that missed a shape
 *     would put that link on the event spine, where §2 forbids it, and nothing downstream would
 *     notice because the value would still look like a route.
 *
 *  2. DOES IT REFUSE RATHER THAN THROW? Every rejection here must be a `null`, because the
 *     caller is on the request path of a worker's typed feedback and a throw would cost them a
 *     paragraph over a field they never filled in.
 */

describe("sanitizeScreenContext — identifiers never survive", () => {
  it("replaces a uuid segment with :id", () => {
    expect(sanitizeScreenContext("/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply")).toBe(
      "/jobs/:id/apply",
    );
  });

  it("replaces EVERY id in a path, not only the first", () => {
    // A single-substitution implementation (a non-global replace over the whole string) passes
    // the test above and leaks the second id — which on this platform is the session id.
    expect(
      sanitizeScreenContext(
        "/workers/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/sessions/11111111-2222-4333-8444-555555555555",
      ),
    ).toBe("/workers/:id/sessions/:id");
  });

  it("replaces an all-numeric segment", () => {
    // Not every id on a screen is a uuid: page indices and legacy numeric ids are both real,
    // and `/orders/91723` identifies exactly one thing.
    expect(sanitizeScreenContext("/orders/91723")).toBe("/orders/:id");
  });

  it("substitutes a uuid whose version nibble is not one we mint today", () => {
    // The regex deliberately does not pin `[89ab]`/`4`: a v7 uuid, or one from a client that
    // generated it loosely, is still an IDENTIFIER. Recognising only today's shapes is how a
    // normalizer quietly stops working.
    expect(sanitizeScreenContext("/jobs/018f4c7a-9b21-7c3d-0e5f-0a1b2c3d4e5f")).toBe("/jobs/:id");
  });

  it("drops the query string — the likeliest place a client parks worker input", () => {
    expect(sanitizeScreenContext("/search?q=welder%20mumbai&page=2")).toBe("/search");
  });

  it("drops the fragment, and does so BEFORE the query split", () => {
    // `#` first is load-bearing: a fragment may itself contain a `?`, so cutting the query
    // first on `/a#b?c` leaves `/a#b` — a fragment that survived and a value that then fails
    // the charset check, turning a perfectly good route into a null.
    expect(sanitizeScreenContext("/profile#section?tab=skills")).toBe("/profile");
  });

  it("never returns a value containing a uuid or a bare digit run", () => {
    // The structural version of the assertions above, so it keeps holding for an input shape
    // nobody has written a case for yet.
    const inputs = [
      "/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301",
      "/a/1/b/22/c/333",
      "/chat/6f2c04e0-4f89-41d3-9a0c-0305e82c3301?from=/jobs/9",
      "/workers/6F2C04E0-4F89-41D3-9A0C-0305E82C3301/profile",
    ];
    for (const input of inputs) {
      const out = sanitizeScreenContext(input);
      expect(out, input).not.toBeNull();
      expect(out!, input).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(out!.split("/"), input).not.toContainEqual(expect.stringMatching(/^\d+$/));
    }
  });
});

describe("sanitizeScreenContext — sanitize, never reject, never throw", () => {
  it.each([
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { path: "/jobs" }],
    ["an array (a repeated field)", ["/jobs", "/home"]],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["an unrooted path", "jobs/apply"],
    ["a full URL", "https://badabhai.ai/jobs"],
    // A rooted path by every naive check, and a SCHEME-RELATIVE URL to a host we do not
    // control — rendered as a link on the admin screen it is an outbound navigation an
    // attacker chose. The `//` arm of the shared pattern is what refuses it.
    ["a scheme-relative URL", "//evil.example/jobs"],
    ["a doubled slash anywhere", "/jobs//apply"],
    ["markup", "/jobs/<script>alert(1)</script>"],
    ["whitespace inside", "/jobs/my job"],
    ["percent-encoding", "/jobs/%2e%2e%2fadmin"],
    ["a newline", "/jobs\n/admin"],
    ["non-ASCII", "/नौकरी/आवेदन"],
  ])("returns null for %s", (_label, raw) => {
    expect(sanitizeScreenContext(raw)).toBeNull();
  });

  it("returns null past the bound rather than truncating", () => {
    // Truncating would produce a route pattern that names a screen nobody can navigate to, and
    // it would look authoritative on the admin list. Null reads as "unknown screen", which is
    // the honest answer.
    expect(sanitizeScreenContext(`/${"a".repeat(WORKER_FEEDBACK_SCREEN_MAX)}`)).toBeNull();
    expect(sanitizeScreenContext(`/${"a".repeat(WORKER_FEEDBACK_SCREEN_MAX - 1)}`)).not.toBeNull();
  });

  it("measures the bound AFTER substitution, so an id-heavy path is not lost to its ids", () => {
    // Four uuid segments is 148 raw characters — over the bound — and 20 once normalized. The
    // deep screens are exactly the ones a "button kaam nahi kar raha" report is about, so
    // measuring before substitution would discard the reports that matter most.
    const raw = "/a/6f2c04e0-4f89-41d3-9a0c-0305e82c3301".repeat(4);
    expect(raw.length).toBeGreaterThan(WORKER_FEEDBACK_SCREEN_MAX);
    expect(sanitizeScreenContext(raw)).toBe("/a/:id/a/:id/a/:id/a/:id");
  });

  it("NEVER throws, for any of these", () => {
    for (const raw of [undefined, null, 0, NaN, {}, [], "/", "/".repeat(5000), "?", "#"]) {
      expect(() => sanitizeScreenContext(raw)).not.toThrow();
    }
  });

  it("keeps a plain route unchanged, including its root and a trailing slash", () => {
    expect(sanitizeScreenContext("/")).toBe("/");
    expect(sanitizeScreenContext("/home")).toBe("/home");
    expect(sanitizeScreenContext("/jobs/")).toBe("/jobs/");
    expect(sanitizeScreenContext("  /settings/notifications  ")).toBe("/settings/notifications");
  });
});
