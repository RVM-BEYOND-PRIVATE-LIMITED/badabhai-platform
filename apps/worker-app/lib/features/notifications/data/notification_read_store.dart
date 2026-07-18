import 'package:shared_preferences/shared_preferences.dart';

/// The minimal persistence surface the Alerts feed needs to remember WHICH
/// notifications the worker has already seen, across app restarts (#456 / TD90).
///
/// Abstracted the way [KeyValueStore] is in `core/auth/locale_store.dart`: the
/// real `shared_preferences` plugin throws under `flutter test` without
/// `setMockInitialValues`, so tests inject an in-memory fake instead.
///
/// The stored value is a list of NOTIFICATION IDS, which are the opaque event
/// UUIDs the API already returns — no phone, name, employer, or copy. Nothing
/// here is a credential either, so it belongs in PLAIN prefs (same posture as
/// the locale), NOT secure storage.
abstract interface class NotificationReadStore {
  /// The persisted read ids, OLDEST-FIRST (the order [write] was given). Empty
  /// when nothing has been stored yet.
  Future<List<String>> read();

  /// Replaces the persisted set with [ids], oldest-first.
  Future<void> write(List<String> ids);
}

/// The DEFAULT [NotificationReadStore]: remembers nothing across launches.
///
/// This is the pre-#456 behaviour, kept as the default on purpose. The
/// synchronous DI graph ([setupLocator]) is deliberately PLUGIN-FREE — see the
/// rule documented in core/di/locator.dart — because widget tests build that
/// graph without awaiting `initAuthLocator`, and the `shared_preferences`
/// channel never answers under `flutter_test`'s FakeAsync. Defaulting to the
/// plugin-backed store would therefore deadlock the Alerts feed in every widget
/// test, and, on a device, any future caller that builds the repository outside
/// the async init would inherit the same hang.
///
/// Persistence is opt-IN: `initAuthLocator` registers
/// [SharedPrefsNotificationReadStore] once `SharedPreferences` is genuinely
/// resolved, and the real app always goes through that path.
class SessionOnlyNotificationReadStore implements NotificationReadStore {
  const SessionOnlyNotificationReadStore();

  @override
  Future<List<String>> read() async => const <String>[];

  @override
  Future<void> write(List<String> ids) async {
    // Intentionally nothing: the repository's in-memory set is still the live
    // read-state for this session, so the badge behaves correctly — it just
    // does not survive a restart.
  }
}

/// [NotificationReadStore] over `shared_preferences`.
///
/// Unlike [LocaleStore], this resolves [SharedPreferences] ITSELF on each call
/// rather than taking a pre-resolved instance: the notifications repository is
/// registered as a lazy singleton with a synchronous factory (locator.dart), so
/// there is no `await` available at construction time. `getInstance()` caches
/// its instance after the first call, so the repeat cost is a map lookup.
class SharedPrefsNotificationReadStore implements NotificationReadStore {
  const SharedPrefsNotificationReadStore();

  /// `bb_`-prefixed to match the existing `bb_locale` key convention.
  static const String kReadIds = 'bb_notif_read_ids';

  @override
  Future<List<String>> read() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(kReadIds) ?? const <String>[];
  }

  @override
  Future<void> write(List<String> ids) async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(kReadIds, ids);
  }
}
