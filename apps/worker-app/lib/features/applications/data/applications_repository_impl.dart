import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/applications_repository.dart';

/// Reads the worker's applied jobs via [ApiClient.getMyApplications], using the
/// session token (never a widget-supplied id). The list MIXES applied + skipped,
/// so this filters to `action == 'applied'` (required — matches the API's
/// `ApplicationAction` enum). Transport errors are mapped to the shared [Failure]
/// hierarchy via [mapError].
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
      // The endpoint returns applied + skipped mixed — this screen shows only
      // applies (action == 'applied', per the API's ApplicationAction enum).
      return all.where((AppliedJob a) => a.action == 'applied').toList();
    } catch (error) {
      throw mapError(error);
    }
  }
}
