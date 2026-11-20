import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/search_visibility_repository.dart';

/// [SearchVisibilityRepository] over the live API, authenticated by the session
/// token. The worker is always the session's, never a parameter.
class SearchVisibilityRepositoryImpl implements SearchVisibilityRepository {
  SearchVisibilityRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<SearchVisibilityDto> read() async {
    final String token = _requireToken();
    try {
      return await _api.getSearchVisibility(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<SearchVisibilityDto> setVisible(bool visible) async {
    final String token = _requireToken();
    try {
      return await _api.setSearchVisibility(authToken: token, visible: visible);
    } catch (error) {
      throw mapError(error);
    }
  }
}
