import { WORKER_FEEDBACK_SCREEN_MAX, WORKER_FEEDBACK_SCREEN_PATTERN } from "@badabhai/types";

/**
 * Path segments that are IDENTIFIERS rather than route structure.
 *
 * Two shapes, and both are what the worker app actually puts in a path: a uuid (every entity id
 * on this platform) and an all-numeric segment (a page index, a legacy numeric id). Anything
 * matching becomes `:id`, so `/jobs/6f2c…/apply` and `/jobs/9a71…/apply` collapse onto the one
 * pattern an operator wants to group by.
 *
 * ⚠ The uuid arm deliberately does NOT pin the version/variant nibbles (`[89ab]`): a client
 * sending a v7 or a non-conforming uuid is still sending an IDENTIFIER, and a normalizer that
 * only recognises the ids we happen to mint today would let tomorrow's through verbatim.
 */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;

/**
 * The wire field name. A constant for the same reason header names are: one edit to rename, and
 * a typo is a compile error rather than a field that silently never arrives.
 */
export const SCREEN_CONTEXT_FIELD = "screen";

/**
 * Normalise a client-supplied screen/route value into a ROUTE PATTERN safe to store, to show an
 * admin, and to put on the event spine.
 *
 * ── WHY A PATTERN AND NEVER A PATH ──────────────────────────────────────────────────────
 * THIS IS THE WHOLE DESIGN, not a tidying step. `/jobs/6f2c…-uuid` is an IDENTIFIER: it links a
 * feedback row to one specific job, application or chat session, which is a fact about the
 * worker that nobody asked them to disclose and that the `feedback.submitted` event is
 * explicitly forbidden from carrying (CLAUDE.md §2 — the events spine is where raw personal
 * data must not land). `/jobs/:id/apply` answers the question this feature exists for — WHICH
 * SCREEN was the "button kaam nahi kar raha" about — and answers nothing else. So every
 * id-shaped segment is replaced before anything else looks at the value.
 *
 * The query string and the fragment go for the same reason and one more: they are the two parts
 * of a route a client is most likely to stuff state into (`?q=<what the worker searched>`), and
 * neither carries any information about which screen it was.
 *
 * ── SANITIZE, NEVER REJECT — AND NEVER THROW ────────────────────────────────────────────
 * The posture of {@link import("./app-build").sanitizeAppBuild}, and the reasoning transfers
 * exactly: this is TELEMETRY the worker never filled in, no business decision reads it, and it
 * is not part of any request contract. A malformed value becomes `null`, which reads on the
 * admin screen as "unknown screen" — the honest answer. Losing a worker's typed feedback over a
 * route string their client got wrong is the wrong failure direction. Fail-closed governs
 * validation, privacy, auth and AI safety (CLAUDE.md §3); a route label is none of those.
 *
 * ── THE CLIENT NORMALIZES TOO, AND THAT IS NOT A REASON TO SKIP THIS ────────────────────
 * DEFENCE IN DEPTH. The Flutter overlay knows its own route table and can produce a better
 * pattern than any server-side guess, so it normalizes before sending. It is also an untrusted
 * caller: the shipped client is not the only thing that can post to this endpoint, and the one
 * that does not normalize is precisely the one whose value would carry an id.
 *
 * `raw` is `unknown` because the DTO deliberately does not type it — see `feedback.dto.ts`.
 */
export function sanitizeScreenContext(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // A cheap upper bound BEFORE the split, so a hostile megabyte-long body field is one length
  // comparison rather than a megabyte of segment work. It cannot discard anything the check
  // below would have kept: substitution shrinks a segment at most 37→4 (a uuid plus its
  // separator becoming `:id`), so a value that normalizes to ≤128 cannot have started above
  // ~1184, and 128×10 is comfortably past that.
  if (raw.length > WORKER_FEEDBACK_SCREEN_MAX * 10) return null;

  // Query and fragment first, and `#` before `?`: a fragment may itself contain a `?`, so
  // cutting the query first on `/a#b?c` would leave `/a#b` — a fragment that survived.
  const withoutFragment = raw.split("#")[0]!;
  const path = withoutFragment.split("?")[0]!.trim();
  if (path.length === 0 || !path.startsWith("/")) return null;

  // `/a/b` → ["", "a", "b"]; the leading empty element is the root and is preserved by the
  // join, so a trailing slash survives as a trailing slash rather than being silently trimmed.
  const normalized = path
    .split("/")
    .map((segment) =>
      UUID_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment) ? ":id" : segment,
    )
    .join("/");

  // Length is checked on the NORMALIZED value: substitution can only shrink a segment, so a
  // path that was over-long solely because of its ids is still recorded rather than discarded.
  if (normalized.length > WORKER_FEEDBACK_SCREEN_MAX) return null;
  // The SHARED pattern — the same object `FeedbackSubmittedPayload` validates against, so the
  // normalizer and the spine's structural backstop cannot drift apart. It rejects both the
  // wrong charset AND any surviving id-shaped segment, which is the arm that matters: a uuid is
  // made entirely of legal path characters, so a charset check alone would pass one straight
  // through. Reaching that arm means the substitution above missed a shape, and the honest
  // answer is then `null` rather than an identifier on the audit spine.
  return WORKER_FEEDBACK_SCREEN_PATTERN.test(normalized) ? normalized : null;
}
