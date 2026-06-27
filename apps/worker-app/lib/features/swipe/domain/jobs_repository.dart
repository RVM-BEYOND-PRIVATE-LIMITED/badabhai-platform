import 'job_detail.dart';

/// Read boundary for a full job posting (spec §5.6). Implementations throw a
/// [Failure] (mapped from transport errors) on failure.
abstract interface class JobsRepository {
  /// Fetches the full [JobDetail] for [jobId].
  Future<JobDetail> jobDetail(String jobId);
}
