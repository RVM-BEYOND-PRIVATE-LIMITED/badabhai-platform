import 'package:shared_preferences/shared_preferences.dart';

/// Which of the two Jobs-tab layouts the worker last picked: the Tinder-style
/// swipe deck (default) or the scrollable list.
enum JobFeedViewMode { list, deck }

/// The minimal persistence surface the Jobs tab needs to remember WHICH view
/// the worker last chose, across app restarts.
///
/// Abstracted the way [NotificationReadStore] is in
/// `features/notifications/data/notification_read_store.dart`: the real
/// `shared_preferences` plugin throws under `flutter test` without
/// `setMockInitialValues`, so tests inject an in-memory fake instead.
///
/// This is a DEVICE/UI preference, not worker data — the same posture as
/// `LocaleStore` (also never cleared on logout). Nothing here is PII or a
/// credential, so it belongs in PLAIN prefs, not secure storage.
abstract interface class JobFeedViewStore {
  /// The persisted view mode. Defaults to [JobFeedViewMode.deck] when nothing
  /// has been stored yet.
  Future<JobFeedViewMode> read();

  /// Replaces the persisted mode with [mode].
  Future<void> write(JobFeedViewMode mode);
}

/// The DEFAULT [JobFeedViewStore]: remembers nothing across launches, always
/// reads back [JobFeedViewMode.deck].
///
/// The synchronous DI graph ([setupLocator]) is deliberately PLUGIN-FREE — see
/// the rule documented in core/di/locator.dart — because widget tests build
/// that graph without awaiting `initAuthLocator`, and the `shared_preferences`
/// channel never answers under `flutter_test`'s FakeAsync. Defaulting to the
/// plugin-backed store would therefore deadlock any widget test that reads the
/// Jobs tab's view preference, and, on a device, any future caller that builds
/// the screen outside the async init would inherit the same hang.
///
/// Persistence is opt-IN: `initAuthLocator` registers
/// [SharedPrefsJobFeedViewStore] once `SharedPreferences` is genuinely
/// resolved, and the real app always goes through that path.
class SessionOnlyJobFeedViewStore implements JobFeedViewStore {
  const SessionOnlyJobFeedViewStore();

  @override
  Future<JobFeedViewMode> read() async => JobFeedViewMode.deck;

  @override
  Future<void> write(JobFeedViewMode mode) async {
    // Intentionally nothing: the screen's own in-memory state is still the
    // live view for this session, so the toggle behaves correctly — it just
    // does not survive a restart.
  }
}

/// [JobFeedViewStore] over `shared_preferences`.
///
/// Unlike [LocaleStore], this resolves [SharedPreferences] ITSELF on each call
/// rather than taking a pre-resolved instance: the Jobs screen would otherwise
/// need a synchronous factory with no `await` available at construction time.
/// `getInstance()` caches its instance after the first call, so the repeat
/// cost is a map lookup.
class SharedPrefsJobFeedViewStore implements JobFeedViewStore {
  const SharedPrefsJobFeedViewStore();

  /// `bb_`-prefixed to match the existing `bb_locale` / `bb_notif_read_ids`
  /// key convention.
  static const String kViewMode = 'bb_job_feed_view_mode';

  @override
  Future<JobFeedViewMode> read() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final String? stored = prefs.getString(kViewMode);
    // An explicit prior choice (either value) is always honoured — only
    // NOTHING stored yet (a fresh install, or a worker who never touched the
    // toggle) falls through to the deck default.
    if (stored == JobFeedViewMode.list.name) return JobFeedViewMode.list;
    if (stored == JobFeedViewMode.deck.name) return JobFeedViewMode.deck;
    return JobFeedViewMode.deck;
  }

  @override
  Future<void> write(JobFeedViewMode mode) async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString(kViewMode, mode.name);
  }
}
