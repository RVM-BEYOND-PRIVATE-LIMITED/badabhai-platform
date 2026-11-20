import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/still_looking_repository.dart';

/// [StillLookingRepository] over the live API, authenticated by the session
/// token. The worker is always the session's, never a parameter.
class StillLookingRepositoryImpl implements StillLookingRepository {
  StillLookingRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<StillLookingDto> read() async {
    final String token = _requireToken();
    try {
      return await _api.getStillLooking(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<StillLookingDto> answer(StillLookingAnswer answer) async {
    final String token = _requireToken();
    try {
      return await _api.answerStillLooking(
        authToken: token,
        answer: answer.wire,
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}
