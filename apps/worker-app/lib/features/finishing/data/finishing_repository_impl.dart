import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/finishing_models.dart';
import '../domain/finishing_repository.dart';

/// Real finishing-form repository (#1296) — follows the name/resume real-repo
/// pattern: ctor takes the [ApiClient] + [SessionRepository], reads the bearer
/// token off the session, and maps transport errors to typed [Failure]s.
class FinishingRepositoryImpl implements FinishingRepository {
  FinishingRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<WorkPrefOptionsDto> loadOptions() async {
    final String token = _requireToken();
    try {
      return await _api.getWorkPreferenceOptions(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> saveWorkPreferences(WorkPreferences prefs) async {
    final String token = _requireToken();
    try {
      await _api.updateWorkPreferences(
        fields: prefs.toUpdateBody(),
        authToken: token,
      );
    } on ApiException catch (error) {
      // #1296 — a 400 here is the gazetteer rejecting a typed city and NAMING it.
      // Surface that message (a city name is the worker's OWN input and a matching
      // signal, never PII to redact) so they can fix the spelling, instead of the
      // generic InvalidRequestFailure copy that names nothing.
      if (error.statusCode == 400 && error.message.trim().isNotEmpty) {
        throw InvalidRequestFailure(error.message);
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> saveEmployment(List<EmploymentEntry> employments) async {
    final String token = _requireToken();
    try {
      await _api.updateEmployment(
        employments:
            employments.map((EmploymentEntry e) => e.toJson()).toList(),
        authToken: token,
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}
