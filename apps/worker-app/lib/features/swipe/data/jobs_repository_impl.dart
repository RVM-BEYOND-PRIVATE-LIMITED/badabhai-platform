import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/job_detail.dart';
import '../domain/jobs_repository.dart';

class JobsRepositoryImpl implements JobsRepository {
  JobsRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<JobDetail> jobDetail(String jobId) async {
    final String token = _requireToken();
    try {
      return await _api.jobDetail(jobId, authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }
}
