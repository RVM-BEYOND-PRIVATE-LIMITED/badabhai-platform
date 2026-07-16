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
    final String? token = _session.sessionToken;
    if (workerId == null || token == null) {
      throw const UnauthorizedFailure();
    }

    String? profileId = _session.profileId;

    // A worker who logged in (OTP/PIN) without re-running profiling this session
    // has no in-memory profileId. Restore it from the server, and reuse an
    // already-generated resume if one exists (auto-generated on profile.confirmed)
    // instead of regenerating. No profile at all → guide them to finish profiling.
    if (profileId == null) {
      try {
        final WorkerProfileBundle bundle =
            await _api.getWorkerProfile(workerId: workerId, authToken: token);
        if (!bundle.hasProfile) {
          throw const ProfileIncompleteFailure();
        }
        _session.setProfile(bundle.profileId!);
        profileId = bundle.profileId;
        if (bundle.hasResume) {
          _session.setResume(bundle.resumeId!);
          return bundle.resumeText!;
        }
      } on Failure {
        rethrow;
      } catch (error) {
        throw mapError(error);
      }
    }

    try {
      final ResumeResult result = await _api.generateResume(
        workerId: workerId,
        profileId: profileId!,
        authToken: token,
      );
      _session.setResume(result.resumeId);
      return result.resumeText;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<String> resumeDownloadUrl() async {
    final String? resumeId = _session.resumeId;
    final String? token = _session.sessionToken;
    if (resumeId == null || token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      final ResumeDownload dl = await _api.downloadResume(
        resumeId: resumeId,
        authToken: token,
      );
      return dl.url;
    } on ApiException catch (e) {
      // 409 on the download route specifically means the PDF isn't rendered yet
      // (render pending / not enabled) — surface an honest "taiyaar ho rahi hai"
      // instead of the generic server error the global mapper would produce.
      if (e.statusCode == 409) {
        throw const ResumeNotReadyFailure();
      }
      throw mapError(e);
    } catch (error) {
      throw mapError(error);
    }
  }
}
