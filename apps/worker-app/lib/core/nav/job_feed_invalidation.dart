import 'package:flutter/foundation.dart';

/// "The worker's match inputs changed — the Jobs feed is stale."
///
/// The feed is a projection of the worker's trade/skills: an occupation edit
/// (`PUT /workers/me/occupations`) or a match-skill toggle
/// (`PUT /workers/me/match-skills/:skillId/wants`, clear-all) changes which
/// jobs `GET /feed` returns. The repositories that own those writes call
/// [invalidate] after the server confirms them; the Jobs tab root listens and
/// refetches (see `SwipeJobsScreen`).
///
/// A locator singleton for the same reason as [TabFocus]: the writers live in
/// other shell branches (Profile, pushed on the root navigator), and the feed
/// sits in its own branch Navigator — no common inherited ancestor carries
/// state between them.
///
/// A [ChangeNotifier], not a value: there is no payload, only the fact that a
/// change happened. Listeners must be cheap and idempotent.
class JobFeedInvalidation extends ChangeNotifier {
  /// Marks the feed stale. Safe to call repeatedly.
  void invalidate() => notifyListeners();
}
