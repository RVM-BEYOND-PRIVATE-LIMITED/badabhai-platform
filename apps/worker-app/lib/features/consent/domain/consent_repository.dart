/// DPDP consent boundary. Records the worker's consent for the given purposes.
/// Implementations throw a [Failure] on error and take the worker from the
/// session (never from the widget).
abstract interface class ConsentRepository {
  Future<void> acceptConsent({required List<String> purposes});
}
