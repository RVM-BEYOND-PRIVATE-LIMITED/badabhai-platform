import {
  WORKER_APP_SCREEN_TEMPLATES,
  WORKER_FEEDBACK_SCREEN_MAX,
  type WorkerAppScreenTemplate,
} from "@badabhai/types";

/**
 * The wildcard position in a template. Matches any ONE segment.
 *
 * It is spelled `:id` in every entry, including `/profile/kit/detail/:id`, where the real
 * parameter is a trade key and not an identifier at all. That is not sloppiness: the marker says
 * "one segment, whose value is discarded", and having one spelling is what lets a client's own
 * `:jobId` / `:tradeKey` / `:code` converge on the same constant.
 */
const ID_PLACEHOLDER = ":id";

/**
 * The table, pre-split, paired with the constant it resolves to.
 *
 * Split ONCE at module load rather than per call: this runs on the request path of a worker's
 * feedback, and re-splitting 28 templates per submission is work with no result.
 *
 * ⚠ THE SECOND ELEMENT OF EACH PAIR IS WHAT THE FUNCTION RETURNS, and that is the entire
 * privacy design rather than a convenience. See {@link resolveScreenTemplate}.
 */
const TEMPLATE_TABLE: readonly (readonly [WorkerAppScreenTemplate, readonly string[]])[] =
  WORKER_APP_SCREEN_TEMPLATES.map((template) => [template, template.split("/")] as const);

/**
 * Whether one already-split path is the concrete (or already-templated) form of one template.
 *
 * A `:id` position matches ANY single segment. There is deliberately NO "…except an empty one"
 * arm: the caller refuses a doubled slash outright and strips at most one trailing slash, so a
 * path reaching here cannot carry an empty segment anywhere but index 0 (the root, which every
 * template has as a literal). A guard that cannot fire is not a guard — it is a line that makes
 * the next reader believe a check happened.
 */
function matchesTemplate(templateSegments: readonly string[], segments: readonly string[]): boolean {
  if (templateSegments.length !== segments.length) return false;
  for (let i = 0; i < templateSegments.length; i += 1) {
    const expected = templateSegments[i]!;
    if (expected === ID_PLACEHOLDER) continue;
    if (expected !== segments[i]) return false;
  }
  return true;
}

/**
 * Resolve a client-supplied screen/route value to ONE OF THE WORKER APP'S OWN SCREENS, or null.
 *
 * ── THE GUARANTEE, AND WHY IT IS A GUARANTEE THIS TIME ───────────────────────────────────
 * The return value is ALWAYS a constant taken from `WORKER_APP_SCREEN_TEMPLATES` or `null`. It
 * is never derived from `raw`, never a substring of `raw`, never `raw` itself — the matching
 * arms only ever COMPARE against the caller's bytes and then return the table's own string. So
 * the value that reaches the `worker_feedback` row, the `feedback.submitted` event and the API
 * log line cannot contain a byte the caller chose, whatever the caller sent. That is what
 * CLAUDE.md §2 requires of those three sinks, and it holds by construction rather than by a
 * recogniser being good enough.
 *
 * The return TYPE is what enforces it mechanically: `WorkerAppScreenTemplate` is the union of
 * the table's literals, so `return raw` — or returning anything computed from it — does not
 * compile. The property is checked by the type system, not by review.
 *
 * ── WHAT THIS REPLACED, AND WHY THE REPLACEMENT WAS NECESSARY ────────────────────────────
 * `sanitizeScreenContext` DENYLISTED id shapes: it substituted uuids, long hex runs and long
 * digit runs with `:id` and stored whatever was left. Two rounds of that were measured leaking.
 * The first anchored its checks to whole segments, so an id sharing a segment with one other
 * character survived (`/jobs/id-<uuid>/apply`, `/w/9876543210-ravi`, `/AADHAAR/1234-5678-9012`).
 * The second matched runs anywhere and closed those — and still could not touch an opaque token
 * that is neither hex nor digits, because no structural rule distinguishes one from a route
 * word: `/u/dGVzdEBleGFtcGxlLmNvbQ` (base64url of an email address) and
 * `/x/AKIAIOSFODNN7EXAMPLE` both came back verbatim. A denylist over attacker-controlled text
 * cannot make a §2 guarantee; only a closed set can. Those exact inputs are now test cases
 * asserting they yield a template or null, never themselves.
 *
 * ── SANITIZE, NEVER REJECT — AND NEVER THROW ────────────────────────────────────────────
 * Unchanged, and it is the reason an unmatched value is `null` rather than a 400. This is
 * TELEMETRY the worker never filled in, no business decision reads it, and it is not part of any
 * request contract. `null` reads on the admin screen as "unknown screen" — the honest answer.
 * Losing a worker's typed paragraph over a route string their client got wrong is the wrong
 * failure direction. Fail-closed governs validation, privacy, auth and AI safety (CLAUDE.md §3);
 * a route label is none of those.
 *
 * ── THE FAILURE MODE OF AN ALLOWLIST, NAMED ─────────────────────────────────────────────
 * The app adds a screen, this table does not know it, and that screen reports `null` forever
 * while everything stays green. TWO things make that visible rather than silent:
 *   1. `screen-template-table.contract.test.ts` reads `apps/worker-app/lib/router.dart` and
 *      fails when the app declares a route the table cannot resolve — in the PR that adds it.
 *   2. `WorkerFeedbackController` logs a WARN (with NO client bytes) when a submission carried a
 *      screen that resolved to nothing, which is the signal for a client that shipped ahead of
 *      the server, or one we do not build.
 *
 * ── BOTH FORMS RESOLVE THE SAME ─────────────────────────────────────────────────────────
 * The Flutter client normalizes too (`normalizeScreenContext`), so a value can arrive concrete
 * (`/jobs/detail/6f2c…`) or already templated (`/jobs/detail/:id`, or `/jobs/detail/:jobId` if a
 * client sends go_router's own parameter name). All three match the `:id` position and all three
 * return the same constant. That is not a compromise — the client's normalization is defence in
 * depth in the other direction, and this function is what makes it unnecessary for correctness.
 *
 * `raw` is `unknown` because the DTO deliberately does not type it — see `feedback.dto.ts`.
 */
export function resolveScreenTemplate(raw: unknown): WorkerAppScreenTemplate | null {
  if (typeof raw !== "string") return null;
  // A cheap upper bound BEFORE any string work, so a hostile megabyte-long body field costs one
  // length comparison rather than a megabyte of splitting.
  //
  // ⚠ IT IS LOSSY, and observably so: `/jobs?` + 1300 characters of junk would otherwise resolve
  // to `/jobs` once the query is cut. That loss is deliberate and the safe direction — `null`
  // reads as "unknown screen" — and it is pinned by a test so nobody raises the multiplier on
  // the theory that the bound cannot change a result.
  if (raw.length > WORKER_FEEDBACK_SCREEN_MAX * 10) return null;

  // Query and fragment both go. They are the two parts of a route a client is likeliest to park
  // state in (`?q=<what the worker searched>`), and neither says anything about WHICH SCREEN it
  // was. The ORDER of the two cuts is immaterial — each keeps the prefix before its own
  // delimiter, so either order yields the prefix before whichever comes first.
  //
  // Cutting rather than refusing is what keeps `/jobs/search?q=welder` reporting as
  // `/jobs/search` instead of as "unknown screen", and it is safe for the same reason everything
  // here is: the value returned is the table's constant, not the trimmed path.
  const withoutFragment = raw.split("#")[0]!;
  const trimmed = withoutFragment.split("?")[0]!.trim();

  // ⚠ THE ONE EDGE REJECTION THAT SURVIVED AS CODE. Every other one the previous implementation
  // made — the charset, control characters, non-ASCII, markup, an unrooted path, an id-shaped
  // segment — is now STRUCTURAL rather than checked: such a value simply matches no template,
  // and re-asserting any of them would be a second mechanism guarding a property membership
  // already makes impossible. Two things keep this one:
  //   * the degenerate `"//"`, which the trailing-slash trim below would otherwise fold into
  //     `"/"` and report as the splash screen — a hostile value answered with a real screen;
  //   * and it is what lets `matchesTemplate` drop its own empty-segment arm honestly. With no
  //     doubled slash and at most one trailing slash trimmed, no empty segment can reach a
  //     `:id` position, today or when a future route puts `:id` anywhere but last.
  if (trimmed.includes("//")) return null;

  // ONE trailing slash is tolerated — `/jobs/` is the Jobs feed and reporting it as "unknown
  // screen" would be a lie about a real route. The root is exempt: `"/"` IS the splash screen,
  // not a trailing slash. Anything further (`/jobs//`) keeps an empty segment and matches
  // nothing, which is correct.
  const path = trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;

  const segments = path.split("/");
  for (const [template, templateSegments] of TEMPLATE_TABLE) {
    // THE RETURN IS `template` — the table's own constant — and never `path`, `segments` or
    // anything else reachable from `raw`.
    if (matchesTemplate(templateSegments, segments)) return template;
  }
  return null;
}
