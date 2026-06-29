import '../../../core/api/api_models.dart';

/// Worker-facing "Applied jobs" boundary. Implementations read the worker's
/// session token (never a widget-supplied id) and return only APPLY decisions
/// — the underlying list mixes apply + skip. Throws a [Failure] on transport
/// error (mapped via the shared failure_mapper).
abstract interface class ApplicationsRepository {
  /// The worker's applied (`action == 'apply'`) jobs, oldest-first as the API
  /// returns them. The cubit reverses for newest-first display.
  Future<List<AppliedJob>> appliedJobs();
}
