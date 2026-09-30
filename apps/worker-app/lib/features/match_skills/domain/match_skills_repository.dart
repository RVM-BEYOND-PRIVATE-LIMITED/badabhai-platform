import 'match_skill.dart';

/// The worker's own exit from matching (E4, #1828): read which kinds of work
/// he is shown for, turn one off or on, or turn all of them off.
///
/// Implementations take the worker from the session bearer (never from the
/// widget) and throw a [Failure] on error.
abstract interface class MatchSkillsRepository {
  /// `GET /workers/me/match-skills`. Switched-off rows are included.
  Future<List<MatchSkill>> list();

  /// `PUT /workers/me/match-skills/:skillId/wants`. [wants] is the RESULTING
  /// state; returns the state the server now holds for [skillId].
  Future<bool> setWants(String skillId, {required bool wants});

  /// `POST /workers/me/match-skills/clear-all` — every kind of work off.
  ///
  /// Returns nothing on purpose: the server's `cleared` counts every row the
  /// worker holds, already-off ones included (#1850), so it cannot say how
  /// many switches this call turned off. The caller derives that itself.
  Future<void> clearAll();
}
