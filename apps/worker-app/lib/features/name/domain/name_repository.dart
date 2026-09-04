/// Name-capture boundary. Submits the worker's real name to the API
/// (PATCH /workers/me/name), which encrypts it at rest and never echoes it back.
///
/// [city]/[state] ride along on the SAME call (coarse location, not PII —
/// see the "cities are not PII" ruling this product already applies to job
/// search). The current API schema (`SetMyNameSchema`, a plain non-`.strict()`
/// zod object) silently drops unknown keys, so sending them today is a
/// harmless no-op — this is forward-compatible with zero app update needed
/// once the backend adds the columns + widens the schema (tracked in #1428).
///
/// PRIVACY: the name is PII. It is held only transiently (the text field +
/// this call) — never stored in app state, an event, or a log. Implementations
/// throw a [Failure] on error.
abstract interface class NameRepository {
  Future<void> submitName(String fullName, {String? city, String? state});
}
