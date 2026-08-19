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

  it("drops the fragment as well as the query, in whichever order they appear", () => {
    // ⚠ NOT AN ORDER ASSERTION, and it used to claim to be one. Each cut keeps the prefix
    // before its own delimiter, so `#`-then-`?` and `?`-then-`#` produce the same string for
    // every input — swapping the two lines in the implementation reddens nothing, measured.
    // What IS worth pinning is that neither delimiter survives whichever comes first.
    expect(sanitizeScreenContext("/profile#section?tab=skills")).toBe("/profile");
    expect(sanitizeScreenContext("/profile?tab=skills#section")).toBe("/profile");
  });

  /**
   * ⚠ THE BUG THIS SUITE MISSED, AND THE REASON IT MISSED IT.
   *
   * Every case above puts the identifier alone in its segment. The first implementation tested
   * `^<uuid>$` / `^\d+$` PER SEGMENT, so all of them passed while an id sharing its segment
   * with one other character went through verbatim — into the row, onto `feedback.submitted`,
   * and into the API log line. Each input below was executed against the shipped code and came
   * back unchanged; each is a §2 violation on three sinks at once.
   */
  describe("an identifier does not have to be the WHOLE segment", () => {
    it.each([
      ["a uuid behind a prefix", "/jobs/id-6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply"],
      ["a uuid with a trailing character", "/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301x/apply"],
      ["the dash-less uuid form", "/jobs/6f2c04e04f8941d39a0c0305e82c3301/apply"],
      ["a phone number and a name", "/w/9876543210-ravi"],
      ["a name and a phone number", "/support/ravi-kumar-9876543210"],
      ["a grouped 12-digit number", "/AADHAAR/1234-5678-9012"],
      ["a phone after a scheme-ish colon", "/tel:919876543210"],
      ["dot-separated worker detail", "/ramesh.kumar.9876543210"],
      ["an alphanumeric id", "/chat/AbCdEf123456/msg"],
    ])("substitutes %s", (_label, raw) => {
      const out = sanitizeScreenContext(raw);
      expect(out, raw).not.toBeNull();
      // No uuid, no dash-less hex id, and no digit run long enough to be a number about a
      // person. The assertion is on the OUTPUT so it keeps holding for shapes nobody has
      // written a case for.
      expect(out!, raw).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      expect(out!, raw).not.toMatch(/[0-9]{4,}/);
      expect(out!, raw).not.toMatch(/(?=[0-9a-fA-F]*[0-9])[0-9a-fA-F]{16,}/);
    });

    it("substitutes EVERY run in one segment, not only the first", () => {
      expect(sanitizeScreenContext("/x/9876543210-and-1234567890")).toBe("/x/:id-and-:id");
    });

    /**
     * ⚠ THE RESIDUAL, ASSERTED SO IT IS NOT MISTAKEN FOR A GUARANTEE. An opaque token that is
     * neither hex nor digits is indistinguishable from a route word by any structural rule, so
     * it survives — and no comment on this field may claim otherwise. Closing this needs an
     * ALLOWLIST of the client's finite route table, not a longer denylist.
     */
    it("does NOT catch an opaque non-hex token — a denylist cannot", () => {
      expect(sanitizeScreenContext("/u/dGVzdEBleGFtcGxlLmNvbQ")).toBe(
        "/u/dGVzdEBleGFtcGxlLmNvbQ",
      );
    });

    /** A long lowercase word made only of `a`–`f` is hex by charset and is not an id. */
    it("does not mistake a long hex-lettered WORD for an id", () => {
      expect(sanitizeScreenContext("/deadbeefdeadbeef/edit")).toBe("/deadbeefdeadbeef/edit");
    });
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

  /**
   * The pre-split DoS bound is LOSSY, and the comment that used to sit on it claimed it was
   * not ("cannot discard anything the check below would have kept"). Pinned here so the false
   * invariant cannot come back as a justification for raising the multiplier.
   */
  it("discards a value past the raw DoS bound even though it would normalize small", () => {
    const raw = `/orders/${"9".repeat(1300)}`;
    expect(raw.length).toBeGreaterThan(WORKER_FEEDBACK_SCREEN_MAX * 10);
    // Its normalized form would be `/orders/:id` — eleven characters, well inside the bound.
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
