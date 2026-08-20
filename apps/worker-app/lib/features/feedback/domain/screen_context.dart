/// Ceiling on the normalized screen context, in characters.
///
/// MIRRORS `WORKER_FEEDBACK_SCREEN_MAX` in `packages/types` — the server pins the
/// same 128 at the DTO layer and at the `worker_feedback_screen_context_len_chk`
/// CHECK. Dart cannot import that TypeScript constant, so this is a hand copy and
/// the tests pin the SAME number and the SAME example strings the server's
/// `screen-context.test.ts` uses. That is the only thing standing between the two
/// halves of a cross-language contract and a silent drift.
const int kWorkerFeedbackScreenMax = 128;

/// A path SEGMENT that is a uuid — every entity id on this platform.
///
/// Deliberately does NOT pin the version/variant nibbles: a v7 uuid, or one a
/// client generated loosely, is still an IDENTIFIER, and a normalizer that only
/// recognises the shapes we mint today is one that quietly stops working.
final RegExp _kUuidSegment = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);

/// A path SEGMENT that is an all-numeric id (a page index, a legacy numeric id).
///
/// `[0-9]` rather than `\d` ON PURPOSE. Dart and JS agree that `\d` is ASCII-only
/// today, but this file's whole job is to be byte-for-byte the same decision as a
/// regex written in another language, and a class that cannot be reinterpreted by
/// a flag is one less way for the two halves to drift.
final RegExp _kNumericSegment = RegExp(r'^[0-9]+$');

/// The CHARSET a normalized screen context may be made of, rooted.
///
/// Deliberately no whitespace, no `%`, no `?`, no `#`, no `<`, no non-ASCII. `:`
/// is admitted only because `:id` is the substitution marker itself.
///
/// This is the third arm of `WORKER_FEEDBACK_SCREEN_PATTERN` in `packages/types`.
/// The other two arms of that pattern are negative lookaheads, and they are
/// spelled out as plain checks in [normalizeScreenContext] rather than folded in
/// here — see [_isIdSegment] and the doubled-slash check. Same three decisions,
/// in the same order, each one independently readable and independently
/// falsifiable. (A `!` inside a Dart string literal under `lib/` also trips the
/// persona-neutrality scanner, which cannot tell regex source from bot copy.)
final RegExp _kScreenCharset = RegExp(r'^/[A-Za-z0-9._:/-]*$');

/// A doubled slash — refused ANYWHERE in the value, and not for tidiness.
///
/// `//evil.example/jobs` is a rooted path by every naive check AND a
/// scheme-relative URL to a host nobody here controls; rendered as a link on the
/// admin Feedback screen it is an outbound navigation an attacker chose. `/a//b`
/// is meaningless besides.
const String _kDoubledSlash = '//';

/// Whether one path SEGMENT is an identifier rather than route structure.
bool _isIdSegment(String segment) =>
    _kUuidSegment.hasMatch(segment) || _kNumericSegment.hasMatch(segment);

/// Turn the route the worker was on into a ROUTE PATTERN safe to send, store and
/// show an admin — or null when it cannot be made safe.
///
/// ── WHY A PATTERN AND NEVER A PATH ─────────────────────────────────────────
/// THIS IS THE WHOLE DESIGN, not a tidying step. `/jobs/<uuid>/apply` is an
/// IDENTIFIER: it ties a feedback row to one specific job or chat session — a
/// fact about the worker nobody asked them to disclose, and one the
/// `feedback.submitted` event is forbidden to carry. `/jobs/:id/apply` answers
/// the only question this field exists for — WHICH SCREEN was "button kaam nahi
/// kar raha" about — and answers nothing else.
///
/// ── WHERE THIS INTENTIONALLY LEADS THE SERVER TWIN ─────────────────────────
/// The pre-bound below is measured against the CUT path; the server's
/// `screen-context.ts` measures it against the RAW value and so still turns
/// `/jobs?<1275 chars>` into "unknown screen". That is a bug on that side and the
/// backend change must mirror this. It costs nothing today — every value this
/// app produces is already cut, short, and accepted by the server verbatim
/// (round-tripped, no client output is ever nulled server-side) — but a
/// non-Flutter caller POSTing a full location string hits it.
///
/// ── THE SERVER NORMALIZES AGAIN, AND THAT IS NOT A REASON TO SKIP THIS ──────
/// DEFENCE IN DEPTH, in both directions. This app knows its own route table and
/// can produce a better pattern than any server-side guess; the server treats
/// every client as untrusted because the shipped app is not the only thing that
/// can POST to that endpoint.
///
/// ── SANITIZE, NEVER REJECT ─────────────────────────────────────────────────
/// A value this cannot normalize becomes null and the key is simply omitted — the
/// worker's feedback still sends. This is TELEMETRY they never filled in; losing
/// a typed paragraph to a route string the client got wrong is the wrong failure
/// direction, and the server takes the identical posture (a value it rejects is
/// stored as NULL, never a 400).
String? normalizeScreenContext(String? raw) {
  if (raw == null) return null;

  // BOTH the fragment and the query go, and both cuts have to exist. They are the
  // two parts of a route a client is likeliest to park state in (`?q=<what the
  // worker searched>`), and neither says anything about WHICH SCREEN it was.
  // Cutting only the query leaves `/profile#section` — a fragment that survived,
  // which then fails the charset check and turns a perfectly good route into a
  // null. (The server takes them in this same order; with both cuts present the
  // order itself does not change any result, since whichever marker comes first
  // truncates the value either way.)
  //
  // `indexOf` + `substring` rather than `split`, so a hostile megabyte-long value
  // is one scan and one copy of the part we keep, never a list of every segment
  // between the separators.
  final int hash = raw.indexOf('#');
  final String withoutFragment = hash < 0 ? raw : raw.substring(0, hash);
  final int query = withoutFragment.indexOf('?');
  final String path =
      (query < 0 ? withoutFragment : withoutFragment.substring(0, query)).trim();

  // A cheap upper bound BEFORE the per-segment work, so a hostile value is one
  // length comparison rather than a megabyte of substitution.
  //
  // Applied to the CUT path and not to `raw`, which is what makes the claim below
  // true. Against `raw` it was not a performance guard at all: the query cut and
  // the trim are unbounded shrinks that happen after it, so `/jobs?<1275 chars>`
  // — an ordinary short route with a long query string — was discarded as an
  // unknown screen while `/jobs` was the answer. Measured, both directions.
  //
  // From here it cannot discard anything the checks below would keep: substitution
  // only ever SHRINKS a segment (37 → 4 for a uuid plus its separator), so a value
  // that normalizes to <= 128 cannot have started above ~1184 — comfortably inside
  // 128 * 10.
  if (path.length > kWorkerFeedbackScreenMax * 10) return null;
  // An EARLY EXIT, not the guarantee: the charset arm below anchors on `^/`, so
  // an empty or unrooted value ends as null with or without this line (measured —
  // deleting it leaves the suite green). It stays because it mirrors the server's
  // shape and says the intent where a reader looks for it.
  if (path.isEmpty || !path.startsWith('/')) return null;

  // `/a/b` → ['', 'a', 'b']; the leading empty element is the root and survives the
  // join, so a trailing slash stays a trailing slash rather than being silently
  // trimmed away.
  final List<String> segments = path
      .split('/')
      .map((String segment) => _isIdSegment(segment) ? ':id' : segment)
      .toList();
  final String normalized = segments.join('/');

  // Measured AFTER substitution, so a deep id-heavy path is not lost to its own
  // ids — those are exactly the screens a "button kaam nahi kar raha" report is
  // about. Over the bound is a null, never a truncation: a truncated route pattern
  // names a screen nobody can navigate to and looks authoritative on the admin list.
  if (normalized.length > kWorkerFeedbackScreenMax) return null;

  if (normalized.contains(_kDoubledSlash)) return null;
  // The shared pattern's remaining arm. Its THIRD arm — "no surviving id-shaped
  // segment" — is the substitution above rather than a re-check here: the two
  // would consult the same [_isIdSegment], so a re-check could never fire and a
  // line that cannot fail is not a guard. What actually holds this property is
  // `screen_context_test.dart`'s structural case, which asserts no OUTPUT ever
  // contains a uuid or a bare digit run, for inputs nobody wrote a case for.
  return _kScreenCharset.hasMatch(normalized) ? normalized : null;
}
