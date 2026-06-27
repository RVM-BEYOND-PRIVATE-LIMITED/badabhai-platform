import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/consent_repository.dart';

class ConsentRepositoryImpl implements ConsentRepository {
  ConsentRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<void> acceptConsent({required List<String> purposes}) async {
    final String? workerId = _session.workerId;
    // Should never happen after login; fail closed rather than call with no id.
    if (workerId == null) throw const UnauthorizedFailure();
    try {
      await _api.acceptConsent(workerId: workerId, purposes: purposes);
    } catch (error) {
      throw mapError(error);
    }
  }
}
