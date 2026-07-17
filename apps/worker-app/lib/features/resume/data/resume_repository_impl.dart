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
  Future<String> generateResume({bool force = false}) async {
    final String? workerId = _session.workerId;
    final String? token = _session.sessionToken;
    if (workerId == null || token == null) {
      throw const UnauthorizedFailure();
    }

    String? profileId = _session.profileId;

    // Resolve the profile and REUSE an existing resume — on EVERY open, not only
    // when profileId happens to be null.
    //
    // The reuse short-circuit used to live inside `if (profileId == null)`, and
    // that block set profileId itself. So it fired at most once per session:
    // every later Resume-tab open fell straight through to POST /resume/generate.
    // Server-side that is createInitial(overwrite: true) — it resets
    // render_status to 'pending' and pdf_storage_key to null. The app was
    // destroying its own rendered PDF on each open (a self-inflicted 409 on the
    // very next download) and spending the worker's 5/day generate cap to do it
    // (then 429). Reuse is now the default and generate the exception.
    if (!force) {
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
    } else if (profileId == null) {
      // Deliberate rebuild, but this session never ran profiling — resolve the
      // profile id WITHOUT taking the reuse branch, or the stale cached text
      // would be returned and the regenerate silently skipped (F3).
      try {
        final WorkerProfileBundle bundle =
            await _api.getWorkerProfile(workerId: workerId, authToken: token);
        if (!bundle.hasProfile) {
          throw const ProfileIncompleteFailure();
        }
        _session.setProfile(bundle.profileId!);
        profileId = bundle.profileId;
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
