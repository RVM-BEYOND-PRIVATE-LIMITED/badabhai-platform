/// Name-capture boundary. Submits the worker's real name to the API
/// (PATCH /workers/me/name), which encrypts it at rest and never echoes it back.
///
/// PRIVACY: the name is PII. It is held only transiently (the text field +
/// this call) — never stored in app state, an event, or a log. Implementations
/// throw a [Failure] on error.
abstract interface class NameRepository {
  Future<void> submitName(String fullName);
}
