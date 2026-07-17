import 'job_detail.dart';

/// Job-detail boundary for the REAL worker-visible posting surface
/// (`GET /jobs/:jobId` — the ADR-0024 addendum, 2026-07-16). Implementations
/// read the worker's session token (never the widget) and throw a [Failure]
/// on error: [UnauthorizedFailure] on a 401 (re-login),
/// [ConsentRequiredFailure] on a 403 (consent gate), and a
/// [ServerFailure] carrying 404 for the neutral "Job not found"
/// (unknown/closed job) case.
abstract interface class JobsRepository {
  Future<JobDetail> jobDetail(String jobId);
}
