import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/applications_repository.dart';

/// Reads the worker's applied jobs via [ApiClient.getMyApplications], using the
/// session token (never a widget-supplied id). The list MIXES apply + skip, so
/// this filters to `action == 'apply'` (required). Transport errors are mapped to
/// the shared [Failure] hierarchy via [mapError].
class ApplicationsRepositoryImpl implements ApplicationsRepository {
  ApplicationsRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<List<AppliedJob>> appliedJobs() async {
    final String token = _requireToken();
    try {
      final List<AppliedJob> all =
          await _api.getMyApplications(authToken: token);
      // The endpoint returns apply + skip mixed — this screen shows only applies.
      return all.where((AppliedJob a) => a.action == 'apply').toList();
    } catch (error) {
      throw mapError(error);
    }
  }
}
