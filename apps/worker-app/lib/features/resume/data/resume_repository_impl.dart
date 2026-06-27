import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/resume_repository.dart';

class ResumeRepositoryImpl implements ResumeRepository {
  ResumeRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<String> generateResume() async {
    final String? workerId = _session.workerId;
    final String? profileId = _session.profileId;
    if (workerId == null || profileId == null) {
      throw const UnauthorizedFailure();
    }
    try {
      final ResumeResult result = await _api.generateResume(
        workerId: workerId,
        profileId: profileId,
      );
      _session.setResume(result.resumeId);
      return result.resumeText;
    } catch (error) {
      throw mapError(error);
    }
  }
}
