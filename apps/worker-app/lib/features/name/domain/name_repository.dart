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
/// [city]/[state] are REAL, persisted fields (#1428, `SetMyNameSchema`) —
/// `workers.current_city`/`current_state`, plaintext (owner ruling: cities
/// are a matching input, not PII), free text (NOT resolved against the
/// preferred-cities gazetteer — this is the first screen a worker meets,
/// which must never refuse the name of the place they actually live in).
/// [address] has NO matching backend column; the same non-`.strict()` zod
/// object silently drops it, so sending it today stays a harmless no-op.
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
