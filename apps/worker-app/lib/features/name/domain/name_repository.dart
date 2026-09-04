/// Name-capture boundary. Submits the worker's real name to the API
/// (PATCH /workers/me/name), which encrypts it at rest and never echoes it back.
///
/// Location rides along on the SAME call, as ONE of two shapes (never both):
///  - [city]/[state] — the clean, matchable pair the GPS/network path
///    resolves (coarse location, not PII — see the "cities are not PII"
///    ruling this product already applies to job search).
///  - [address] — the manual-entry fallback: a single free-text line the
///    worker types their whole address into (house/plot, locality, road,
///    city, state), deliberately NOT parsed into city/state client-side —
///    that parsing needs either a geocoder call or the LLM extraction the
///    chat step already does, neither of which belongs in this onboarding
///    step.
///
/// The current API schema (`SetMyNameSchema`, a plain non-`.strict()` zod
/// object) silently drops unknown keys, so sending any of these today is a
/// harmless no-op — this is forward-compatible with zero app update needed
/// once the backend adds the columns + widens the schema (tracked in #1428).
///
/// PRIVACY: the name is PII. It is held only transiently (the text field +
/// this call) — never stored in app state, an event, or a log. Implementations
/// throw a [Failure] on error.
abstract interface class NameRepository {
  Future<void> submitName(
    String fullName, {
    String? city,
    String? state,
    String? address,
  });
}
