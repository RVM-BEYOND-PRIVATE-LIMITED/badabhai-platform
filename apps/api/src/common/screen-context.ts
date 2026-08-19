import {
  SCREEN_ID_RUN_SOURCES,
  WORKER_FEEDBACK_SCREEN_MAX,
  WORKER_FEEDBACK_SCREEN_PATTERN,
} from "@badabhai/types";

/**
 * An identifier appearing ANYWHERE in a segment, not only as the whole of one.
 *
 * ⚠ THIS WAS THE BUG, AND IT IS THE REASON THIS IS A RUN RATHER THAN AN ANCHORED MATCH. The
 * first version of this file tested `^<uuid>$` and `^\d+$` per segment. An id sharing its
 * segment with one other character therefore survived untouched, and the value it survived
 * into is stored, evented and logged — measured, not reasoned:
 * `/jobs/id-6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply` came back verbatim, as did the
 * dash-less uuid form and `/w/9876543210-ravi`.
 *
 * The shapes come from `SCREEN_ID_RUN_SOURCES` in `@badabhai/types` — the SAME source strings
 * the spine's backstop pattern is built from, imported rather than re-typed, because the two
 * recognising different things is precisely how the hole opened. Substitution is GLOBAL: two
 * ids in one segment are two `:id`s.
 *
 * ⚠ The uuid arm deliberately does NOT pin the version/variant nibbles (`[89ab]`): a client
 * sending a v7 or a non-conforming uuid is still sending an IDENTIFIER, and a normalizer that
 * only recognises the ids we happen to mint today would let tomorrow's through verbatim.
 */
const ID_RUN = new RegExp(SCREEN_ID_RUN_SOURCES.join("|"), "g");

/**
 * A segment that is ENTIRELY numeric, however short.
 *
 * Kept ALONGSIDE the run above rather than folded into it: `/orders/12` is an identifier and
 * `12` is under the run's digit bound, while a bare `2` inside `/v2/jobs` is a route word. The
 * distinction is whether the digits are the whole segment.
 */
const NUMERIC_SEGMENT = /^\d+$/;

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
 * ── THE CLIENT WILL NORMALIZE TOO, AND THAT IS NOT A REASON TO SKIP THIS ────────────────
 * DEFENCE IN DEPTH. The Flutter overlay knows its own route table and can produce a better
 * pattern than any server-side guess, so it is meant to normalize before sending. ⚠ NO SHIPPED
 * CLIENT SENDS THE FIELD YET — `ApiClient.submitFeedback` gained its `screen` argument on the
 * worker-app branch and nothing on `main` posts one, so every row this server writes today has
 * `screen_context: null`. Nothing here may be written as though a producer already existed.
 *
 * The client is also an UNTRUSTED caller: the shipped app is not the only thing that can post
 * to this endpoint, and the one that does not normalize is precisely the one whose value would
 * carry an id — which is why this runs regardless of what the client did.
 *
 * ⚠ AND IT IS A DENYLIST, WHICH IS THE WEAKER POSTURE. It recognises id SHAPES (uuid, long hex,
 * long digit runs, all-numeric segments) and cannot recognise an opaque token that looks like a
 * word. The durable design is an ALLOWLIST of the client's own finite route table, matched
 * server-side, with anything unrecognised becoming `null`. That needs the route table this
 * server does not yet have; until it does, neither this function nor anything downstream may
 * claim that "no identifier can land here" is absolute.
 *
 * `raw` is `unknown` because the DTO deliberately does not type it — see `feedback.dto.ts`.
 */
export function sanitizeScreenContext(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // A cheap upper bound BEFORE the split, so a hostile megabyte-long body field is one length
  // comparison rather than a megabyte of segment work.
  //
  // ⚠ IT IS A DoS BOUND, NOT A LOSSLESS ONE, and an earlier comment here claimed otherwise
  // ("cannot discard anything the check below would have kept: substitution shrinks a segment
  // at most 37→4"). Substitution shrinks WITHOUT BOUND — a numeric segment is `\d+` — so
  // `"/orders/" + "9".repeat(1300)` normalizes to `/orders/:id`, eleven characters, and is
  // discarded here anyway. Measured. That loss is accepted: `null` reads as "unknown screen",
  // which is the safe direction for telemetry, and no reader may lean on the old invariant to
  // raise this multiplier or drop the post-normalization check below.
  if (raw.length > WORKER_FEEDBACK_SCREEN_MAX * 10) return null;

  // Query and fragment both go. The ORDER of the two cuts is immaterial — each keeps the prefix
  // before its own delimiter, so either order yields the prefix before whichever comes first —
  // and an earlier comment here claimed `#` had to precede `?`, which is not true and is not
  // what the test below proves.
  const withoutFragment = raw.split("#")[0]!;
  const path = withoutFragment.split("?")[0]!.trim();
  if (path.length === 0 || !path.startsWith("/")) return null;

  // `/a/b` → ["", "a", "b"]; the leading empty element is the root and is preserved by the
  // join, so a trailing slash survives as a trailing slash rather than being silently trimmed.
  //
  // An all-numeric segment collapses whole; anything else has every id-shaped RUN inside it
  // substituted, so `/jobs/id-<uuid>/apply` becomes `/jobs/id-:id/apply` rather than passing
  // through as an identifier. `lastIndex` is reset because `ID_RUN` is a global regex reused
  // across calls and `.replace` leaves it at 0 only by convention.
  const normalized = path
    .split("/")
    .map((segment) => {
      if (NUMERIC_SEGMENT.test(segment)) return ":id";
      ID_RUN.lastIndex = 0;
      return segment.replace(ID_RUN, ":id");
    })
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
