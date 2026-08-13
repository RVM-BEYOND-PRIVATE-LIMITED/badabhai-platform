import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/job_search_item.dart';
import '../domain/job_search_repository.dart';

/// Wires `GET /jobs/search` to the session token and maps any transport/API
/// error to a user-safe [Failure] — the SAME convention as [SwipeRepositoryImpl]
/// (inject the session, `_requireToken`, `mapError` in the catch). No new
/// error/Result type is introduced: the method returns the value and throws a
/// mapped [Failure], exactly like the swipe repository's `getFeed`.
class JobSearchRepositoryImpl implements JobSearchRepository {
  JobSearchRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<JobSearchPage> searchJobs({
    String? q,
    String? city,
    String? state,
    int limit = 20,
    int page = 1,
  }) async {
    final String token = _requireToken();
    try {
      return await _api.searchJobs(
        authToken: token,
        q: q,
        city: city,
        state: state,
        limit: limit,
        page: page,
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}
