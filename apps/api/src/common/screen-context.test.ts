import { describe, it, expect } from "vitest";
import {
  WORKER_APP_SCREEN_TEMPLATES,
  WORKER_FEEDBACK_SCREEN_MAX,
  isWorkerAppScreenTemplate,
} from "@badabhai/types";

import { resolveScreenTemplate } from "./screen-context";

/**
 * `resolveScreenTemplate` is the ONLY thing standing between an untrusted client and three sinks
 * that must never hold anything the caller composed: the `worker_feedback` row, the
 * `feedback.submitted` event, and the API log line.
 *
 * ── WHY THIS SUITE IS SHAPED THE WAY IT IS ───────────────────────────────────────────────
 * The two predecessors of this function were DENYLISTS, and each was measured leaking. The first
 * anchored its id checks to whole segments and let `/jobs/id-<uuid>/apply` and `/w/9876543210-ravi`
 * through verbatim. The second matched id runs anywhere and closed those — and still let
 * `/u/dGVzdEBleGFtcGxlLmNvbQ` (base64url of an email address) and `/x/AKIAIOSFODNN7EXAMPLE`
 * through, because no structural rule tells an opaque token from a route word. Both suites were
 * green. What made them green was that they only ever asked "is THIS shape caught?", which a
 * denylist can always answer yes to for one more shape.
 *
 * So this file asks three questions instead, in this order:
 *
 *  1. IS THE OUTPUT ALWAYS OURS? Every non-null result must be a member of
 *     `WORKER_APP_SCREEN_TEMPLATES`. That is the §2 property, and unlike "does it strip ids" it
 *     is decidable for inputs nobody wrote a case for — including the two residuals above, which
 *     appear here as assertions rather than as a documented gap.
 *
 *  2. DOES IT PERMIT THE REAL ROUTES? An allowlist tightened past the app's own route table
 *     breaks telemetry silently: every screen reports "unknown" and every test stays green. So
 *     each of the app's screens is asserted to resolve, in both the concrete and the templated
 *     form a client can send.
 *
 *  3. DOES IT REFUSE RATHER THAN THROW? Every rejection must be a `null`, because the caller is
 *     on the request path of a worker's typed feedback and a throw would cost them a paragraph
 *     over a field they never filled in.
 */

/** The §2 property, as one assertion: ours, or nothing. */
function expectFromOurTable(out: string | null, input: unknown): void {
  if (out === null) return;
  expect(isWorkerAppScreenTemplate(out), `${String(input)} → ${out}`).toBe(true);
}

describe("resolveScreenTemplate — the output is one of OUR constants or null, never the caller's", () => {
  /**
   * ⚠ THE RESIDUAL THE PREVIOUS IMPLEMENTATION DOCUMENTED AS UNFIXABLE. Its suite asserted
   * `resolve("/u/dGVzdEBleGFtcGxlLmNvbQ") === "/u/dGVzdEBleGFtcGxlLmNvbQ"` — the leak, pinned as
   * a fact so it would not be mistaken for a guarantee. It is now null: not because the
   * recogniser got better at spotting base64, but because nothing outside the table can be
   * returned at all.
   */
  it.each([
    ["base64url of an email address", "/u/dGVzdEBleGFtcGxlLmNvbQ"],
    ["an AWS-key-shaped token", "/x/AKIAIOSFODNN7EXAMPLE"],
    ["a uuid behind a prefix", "/jobs/id-6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply"],
    ["a uuid with a trailing character", "/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301x/apply"],
    ["the dash-less uuid form", "/jobs/6f2c04e04f8941d39a0c0305e82c3301/apply"],
    ["a phone number and a name", "/w/9876543210-ravi"],
    ["a name and a phone number", "/support/ravi-kumar-9876543210"],
    ["a grouped 12-digit number", "/AADHAAR/1234-5678-9012"],
    ["a phone after a scheme-ish colon", "/tel:919876543210"],
    ["dot-separated worker detail", "/ramesh.kumar.9876543210"],
    ["an alphanumeric id", "/chat/AbCdEf123456/msg"],
    ["a long hex-lettered word", "/deadbeefdeadbeef/edit"],
    ["an all-numeric segment", "/orders/91723"],
    ["a uuid alone", "/workers/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/profile"],
    ["two ids in one path", "/workers/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/sessions/1111"],
    ["a query carrying what the worker searched", "/search?q=welder%20mumbai&page=2"],
  ])("never echoes %s", (_label, raw) => {
    const out = resolveScreenTemplate(raw);
    // The old suite's assertions were "the OUTPUT contains no uuid / no digit run" — a denylist
    // check on a denylist. This is the whole property instead, and it needs no shape vocabulary.
    expectFromOurTable(out, raw);
    expect(out, raw).not.toBe(raw);
  });

  /**
   * The structural form, over a corpus that mixes real routes, near-misses and hostile values.
   * It is what keeps holding for shapes nobody has written a case for — the assertion the two
   * previous designs could not make.
   */
  it("holds for every input in a mixed corpus, real and hostile alike", () => {
    const corpus: unknown[] = [
      ...WORKER_APP_SCREEN_TEMPLATES,
      "/jobs/detail/6f2c04e0-4f89-41d3-9a0c-0305e82c3301",
      "/profile/kit/detail/welder",
      "/i/A1B2C3D4E5F6",
      "/u/dGVzdEBleGFtcGxlLmNvbQ",
      "/x/AKIAIOSFODNN7EXAMPLE",
      "/jobs/../../etc/passwd",
      "/jobs/%2e%2e%2fadmin",
      "//evil.example/jobs",
      "/jobs/<script>alert(1)</script>",
      "/नौकरी/आवेदन",
      "/jobs\n/admin",
      "/JOBS",
      "/jobs/detail/",
      "/jobs/detail",
      "/profile/kit/detail",
      42,
      null,
      undefined,
      { path: "/jobs" },
      ["/jobs", "/home"],
      "",
      "   ",
      "/",
      "//",
      "/".repeat(500),
    ];
    for (const input of corpus) expectFromOurTable(resolveScreenTemplate(input), input);
  });
});

describe("resolveScreenTemplate — every screen the app has still resolves", () => {
  /**
   * ⚠ THE FAILURE AN ALLOWLIST INTRODUCES, and the reason half this suite is about what the
   * resolver PERMITS. A table that refuses a real route does not look broken: the submission
   * still succeeds, the column holds null, and the admin list says "unknown screen" for a
   * screen the worker was demonstrably on. Nothing goes red. So every template is asserted to
   * round-trip, and `screen-template-table.contract.test.ts` asserts the table matches the app.
   */
  it.each(WORKER_APP_SCREEN_TEMPLATES.map((t) => [t] as const))(
    "resolves %s to itself",
    (template) => {
      expect(resolveScreenTemplate(template)).toBe(template);
    },
  );

  /**
   * THE CONCRETE FORM, WHICH IS WHAT THE CLIENT ACTUALLY SENDS. `FeedbackFabOverlay` reads
   * `router.routerDelegate.currentConfiguration.uri.path` — a real path with real segments in it
   * — and the Dart normalizer only collapses the ones it recognises as ids. A trade key
   * (`welder`) is not one, so it arrives verbatim and MUST still land on the kit-detail screen.
   */
  it.each([
    ["a job id", "/jobs/detail/6f2c04e0-4f89-41d3-9a0c-0305e82c3301", "/jobs/detail/:id"],
    ["a numeric job id", "/jobs/detail/91723", "/jobs/detail/:id"],
    ["a trade key, which is not an id at all", "/profile/kit/detail/welder", "/profile/kit/detail/:id"],
    ["a referral code", "/i/A1B2C3D4E5F6", "/i/:id"],
  ])("resolves a concrete %s to its screen", (_label, raw, expected) => {
    expect(resolveScreenTemplate(raw)).toBe(expected);
  });

  /**
   * THE ALREADY-TEMPLATED FORM. The client normalizes too, and go_router's own parameter names
   * (`:jobId`, `:tradeKey`, `:code`) differ from the `:id` this table writes. All of them are
   * just "one segment" to the matcher, so every form a client can plausibly send converges on
   * the same constant — which is what stops the admin list splitting one screen across three
   * spellings.
   */
  it.each([
    ["/jobs/detail/:id", "/jobs/detail/:id"],
    ["/jobs/detail/:jobId", "/jobs/detail/:id"],
    ["/profile/kit/detail/:tradeKey", "/profile/kit/detail/:id"],
    ["/i/:code", "/i/:id"],
  ])("resolves the templated form %s to the same constant", (raw, expected) => {
    expect(resolveScreenTemplate(raw)).toBe(expected);
  });

  /**
   * NO INPUT CAN SATISFY TWO TEMPLATES, so the table's ORDER carries no meaning and the
   * resolver's first-match loop is not quietly load-bearing. Pinned because a future route like
   * `/jobs/:id` would overlap `/jobs/search` and make the order decide which screen a report is
   * filed under — a bug whose only symptom is one screen's feedback appearing under another's.
   *
   * The matcher below is a SECOND, deliberately independent implementation. Asking the resolver
   * itself which templates match would answer "one" by construction (it returns after the first)
   * and prove nothing.
   */
  it("never resolves ambiguously — no two templates can match the same path", () => {
    const matchesIndependently = (template: string, path: string): boolean => {
      const t = template.split("/");
      const p = path.split("/");
      return (
        t.length === p.length &&
        t.every((seg, i) => (seg === ":id" ? p[i]!.length > 0 : seg === p[i]))
      );
    };
    for (const template of WORKER_APP_SCREEN_TEMPLATES) {
      // A probe of the SHAPE this template accepts: its own literals, a plausible segment in
      // each wildcard position.
      const probe = template.split(":id").join("probe-segment");
      const matching = WORKER_APP_SCREEN_TEMPLATES.filter((candidate) =>
        matchesIndependently(candidate, probe),
      );
      expect(matching, probe).toEqual([template]);
      expect(resolveScreenTemplate(probe), probe).toBe(template);
    }
  });
});

describe("resolveScreenTemplate — refuse, never reject the feedback, never throw", () => {
  it.each([
    ["a non-string", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { path: "/jobs" }],
    ["an array (a repeated field)", ["/jobs", "/home"]],
    // ⚠ THE ARRAY THAT COERCES INTO A REAL ROUTE, and the only input that makes the `typeof`
    // guard falsifiable: `String(["/jobs"])` is exactly `"/jobs"`. Replacing the refusal with a
    // coercion passes every other case in this file — measured — and would let a caller reach a
    // screen name through a shape the DTO never contemplated. A JSON body is not a query string;
    // a repeated field is a client we do not ship, so it is `null` here as it is for
    // `sanitizeAppBuild`.
    ["a ONE-element array, which String() would turn into a real route", ["/jobs"]],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["an unrooted path", "jobs/apply"],
    ["a full URL", "https://badabhai.ai/jobs"],
    // A rooted path by every naive check, and a SCHEME-RELATIVE URL to a host we do not control
    // — rendered as a link on the admin screen it is an outbound navigation an attacker chose.
    ["a scheme-relative URL", "//evil.example/jobs"],
    ["a doubled slash inside a real route", "/jobs//search"],
    ["markup", "/jobs/<script>alert(1)</script>"],
    ["whitespace inside", "/jobs/my job"],
    ["percent-encoding", "/jobs/%2e%2e%2fadmin"],
    ["a newline", "/jobs\n/admin"],
    ["non-ASCII", "/नौकरी/आवेदन"],
    ["a route from a DIFFERENT app", "/admin/workers"],
    ["a real route with the wrong case", "/JOBS"],
    ["a real route with an extra segment", "/jobs/search/extra"],
    ["a dynamic route missing its segment", "/jobs/detail"],
    ["a dynamic route with an EMPTY segment", "/jobs/detail/"],
    ["a prefix of a real route", "/prof"],
    ["a real route with a suffix", "/jobsy"],
  ])("returns null for %s", (_label, raw) => {
    expect(resolveScreenTemplate(raw)).toBeNull();
  });

  it("NEVER throws, for any of these", () => {
    for (const raw of [undefined, null, 0, NaN, {}, [], "/", "/".repeat(5000), "?", "#"]) {
      expect(() => resolveScreenTemplate(raw)).not.toThrow();
    }
  });

  /**
   * The bound is a DoS guard and it is LOSSY — deliberately. A megabyte body field costs one
   * length comparison rather than a megabyte of splitting, and the price is that a real route
   * buried behind 1300 characters of query string reports as "unknown screen" instead of as
   * itself. Pinned in BOTH directions so nobody raises the multiplier on the theory that the
   * check cannot change a result: it can, and this is the input where it does.
   */
  it("discards a value past the raw DoS bound even though its path alone would resolve", () => {
    const raw = `/jobs?${"9".repeat(1300)}`;
    expect(raw.length).toBeGreaterThan(WORKER_FEEDBACK_SCREEN_MAX * 10);
    expect(resolveScreenTemplate(raw)).toBeNull();
    // The same route just inside the bound still resolves, so the bound is what refused it.
    expect(resolveScreenTemplate(`/jobs?${"9".repeat(100)}`)).toBe("/jobs");
  });
});

describe("resolveScreenTemplate — the shapes a real client sends", () => {
  it("drops the query string — the likeliest place a client parks worker input", () => {
    // And it DROPS rather than refuses, so a worker complaining from the search screen is not
    // filed under "unknown". Safe because the value returned is the table's constant, not the
    // trimmed path: `q=welder mumbai` cannot survive into anything.
    expect(resolveScreenTemplate("/jobs/search?q=welder%20mumbai&page=2")).toBe("/jobs/search");
  });

  it("drops the fragment as well as the query, in whichever order they appear", () => {
    // ⚠ NOT AN ORDER ASSERTION. Each cut keeps the prefix before its own delimiter, so `#`-then-
    // `?` and `?`-then-`#` produce the same string for every input. What is worth pinning is
    // that neither delimiter survives whichever comes first.
    expect(resolveScreenTemplate("/profile#section?tab=skills")).toBe("/profile");
    expect(resolveScreenTemplate("/profile?tab=skills#section")).toBe("/profile");
  });

  it("tolerates surrounding whitespace and ONE trailing slash", () => {
    expect(resolveScreenTemplate("  /profile/settings  ")).toBe("/profile/settings");
    expect(resolveScreenTemplate("/jobs/")).toBe("/jobs");
    expect(resolveScreenTemplate("/")).toBe("/");
    // A second slash is an empty segment, not a trailing slash, and it matches nothing.
    expect(resolveScreenTemplate("/jobs//")).toBeNull();
  });

  /**
   * ⚠ THE CASE THE `//` CHECK EXISTS FOR, and the reason it is not dead code under an allowlist.
   * Every other doubled slash already fails to match — an empty segment equals no literal in the
   * table. `"//"` is the exception: the trailing-slash trim would fold it into `"/"` and answer a
   * hostile value with a real screen. Deleting the check turns this assertion red, which is the
   * only reason it is still there.
   */
  it("refuses a bare doubled slash rather than folding it into the root", () => {
    expect(resolveScreenTemplate("//")).toBeNull();
    expect(resolveScreenTemplate("/")).toBe("/");
  });
});
