import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/nav/job_feed_invalidation.dart';
import '../../../core/session/session_repository.dart';
import '../domain/match_skill.dart';
import '../domain/match_skills_repository.dart';

/// [MatchSkillsRepository] over the three E4 worker routes. Stateless — it
/// caches nothing, so there is nothing to clear on logout.
///
/// A confirmed write changes which jobs `GET /feed` returns, so each one marks
/// the Jobs feed stale via [JobFeedInvalidation] (optional: absent in tests
/// that only exercise the wire).
class MatchSkillsRepositoryImpl implements MatchSkillsRepository {
  MatchSkillsRepositoryImpl(
    this._api,
    this._session, {
    JobFeedInvalidation? feedInvalidation,
  }) : _feedInvalidation = feedInvalidation;

  final ApiClient _api;
  final SessionRepository _session;
  final JobFeedInvalidation? _feedInvalidation;

  /// The bearer is the subject. Fail closed rather than call unauthed.
  String _token() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<List<MatchSkill>> list() async {
    final String token = _token();
    try {
      final List<MatchSkillDto> rows =
          await _api.getMatchSkills(authToken: token);
      return rows.map(MatchSkill.fromDto).toList(growable: false);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<bool> setWants(String skillId, {required bool wants}) async {
    final String token = _token();
    try {
      final MatchSkillDto held = await _api.setMatchSkillWants(
        skillId: skillId,
        wants: wants,
        authToken: token,
      );
      _feedInvalidation?.invalidate();
      return held.wants;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> clearAll() async {
    final String token = _token();
    try {
      await _api.clearAllMatchSkills(authToken: token);
      _feedInvalidation?.invalidate();
    } catch (error) {
      throw mapError(error);
    }
  }
}
