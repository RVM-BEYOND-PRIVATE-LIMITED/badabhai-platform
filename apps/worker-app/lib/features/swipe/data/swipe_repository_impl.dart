import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/swipe_repository.dart';

class SwipeRepositoryImpl implements SwipeRepository {
  SwipeRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<List<FeedItem>> getFeed() async {
    final String token = _requireToken();
    try {
      return await _api.getFeed(authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> applyToJob(String jobId, {int? rank}) async {
    final String token = _requireToken();
    try {
      await _api.applyToJob(jobId, authToken: token, rank: rank);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> skipJob(String jobId, {required String reason}) async {
    final String token = _requireToken();
    try {
      await _api.skipJob(jobId, authToken: token, reason: reason);
    } catch (error) {
      throw mapError(error);
    }
  }
}
