/// DPDP consent boundary. Records the worker's consent for the given purposes.
/// Implementations throw a [Failure] on error and take the worker from the
/// session (never from the widget).
abstract interface class ConsentRepository {
  Future<void> acceptConsent({required List<String> purposes});

  /// Withdraws the session worker's DPDP consent (POST /consent/withdraw).
  /// Implementations throw a [Failure] on error and take the worker from the
  /// session bearer (never from the widget). On success the SERVER has revoked
  /// every session — the caller must hard-log-out locally.
  Future<void> withdrawConsent();
}
