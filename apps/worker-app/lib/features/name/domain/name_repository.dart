/// Name-capture boundary. Submits the worker's real name to the API
/// (PATCH /workers/me/name), which encrypts it at rest and never echoes it back.
///
/// Location rides along on the SAME call as [city]/[state] — REAL, persisted
/// fields (#1428, `SetMyNameSchema`): `workers.current_city`/`current_state`,
/// plaintext (owner ruling: cities are a matching input, not PII), free text
/// (NOT resolved against the preferred-cities gazetteer — this is the first
/// screen a worker meets, which must never refuse the name of the place they
/// actually live in).
///
/// BOTH capture paths produce this same pair: the GPS/network geocoder
/// resolves them, and the manual fallback asks for them as two boxes. There
/// is deliberately no free-text `address` — `workers` has no column for one
/// ("City + state only — never an address, never a coordinate",
/// `packages/db/src/schema/worker.ts`), so sending one only looked like it
/// worked while the API's zod object dropped it.
///
/// PRIVACY: the name is PII. It is held only transiently (the text field +
/// this call) — never stored in app state, an event, or a log. Implementations
/// throw a [Failure] on error.
abstract interface class NameRepository {
  Future<void> submitName(
    String fullName, {
    String? city,
    String? state,
  });
}
