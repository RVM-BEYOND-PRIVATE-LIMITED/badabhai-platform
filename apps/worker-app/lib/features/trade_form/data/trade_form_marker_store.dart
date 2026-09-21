import 'package:shared_preferences/shared_preferences.dart';

import '../domain/form_fact_registry.dart' show TradeFormMarkerType;

/// Remembers which marker pages (preferences / employment / qualifications) the
/// SERVER has already accepted a save for, so a fresh `TradeFormCubit` (back
/// from step 1 then the chat card, a cold start that restores /trade-form)
/// resumes past them instead of re-showing them blank.
///
/// Why the client has to remember it: marker screens carry no "already
/// filled" signal on `GET /profiling/form`, and none of the three endpoints
/// has a read route. A marker is recorded only AFTER its PUT succeeded (or,
/// for a page with nothing to change, after the worker submitted it), so a
/// record is a fact the server acknowledged, never a guess.
///
/// ONE RECORD PER WORKER, NOT PER FORM: all three endpoints write the worker as
/// a whole (`PUT /workers/me/...`), so a page saved through one trade's form is
/// just as saved when the chat later routes the worker to another trade's form.
///
/// PII-FREE BY CONSTRUCTION: it stores marker TYPES, never a value the worker
/// entered. It is still cleared on logout (`_clearSessionScopedCaches`) so a
/// shared phone's next worker starts clean.
abstract interface class TradeFormMarkerStore {
  /// The marker types already saved for the signed-in worker. Empty when
  /// nothing is recorded. Best-effort — NEVER throws.
  Future<Set<TradeFormMarkerType>> completedMarkers();

  /// Records that [marker] was saved. Best-effort — NEVER throws.
  Future<void> markCompleted(TradeFormMarkerType marker);

  /// Forgets every recorded marker. Best-effort — NEVER throws.
  Future<void> clearAll();
}

/// Resolves the [SharedPreferences] instance. Injectable so a test can hand in
/// a mocked instance without the platform channel.
typedef SharedPreferencesGetter = Future<SharedPreferences> Function();

/// [TradeFormMarkerStore] over `shared_preferences`.
///
/// Resolves [SharedPreferences] LAZILY on each call (like
/// `SharedPrefsPendingReferralStore`), so REGISTERING it never touches the
/// platform channel. Every method swallows a plugin error: a storage failure
/// only means the marker is shown again, which is the pre-store behaviour.
class SharedPrefsTradeFormMarkerStore implements TradeFormMarkerStore {
  const SharedPrefsTradeFormMarkerStore({
    SharedPreferencesGetter prefs = SharedPreferences.getInstance,
  }) : _prefs = prefs;

  final SharedPreferencesGetter _prefs;

  /// `bb_`-prefixed to match the existing key convention. The ONE worker-wide
  /// key (see the class doc) — no build writes a per-form key. [clearAll]
  /// removes every key starting with it anyway, as a defensive sweep.
  static const String kKey = 'bb_trade_form_markers';

  @override
  Future<Set<TradeFormMarkerType>> completedMarkers() async {
    try {
      final SharedPreferences prefs = await _prefs();
      final List<String> names = prefs.getStringList(kKey) ?? const <String>[];
      // An unknown name (a marker type a later build added) is ignored, never
      // fatal.
      return <TradeFormMarkerType>{
        for (final TradeFormMarkerType type in TradeFormMarkerType.values)
          if (names.contains(type.name)) type,
      };
    } catch (_) {
      return <TradeFormMarkerType>{};
    }
  }

  @override
  Future<void> markCompleted(TradeFormMarkerType marker) async {
    try {
      final SharedPreferences prefs = await _prefs();
      final Set<String> names = <String>{
        ...?prefs.getStringList(kKey),
        marker.name,
      };
      await prefs.setStringList(kKey, names.toList());
    } catch (_) {
      // Best-effort: an unrecorded marker is simply shown again next time.
    }
  }

  @override
  Future<void> clearAll() async {
    try {
      final SharedPreferences prefs = await _prefs();
      final List<String> keys = prefs
          .getKeys()
          .where((String key) => key.startsWith(kKey))
          .toList();
      for (final String key in keys) {
        await prefs.remove(key);
      }
    } catch (_) {
      // Best-effort: a teardown failure must never block sign-out.
    }
  }
}

/// In-memory [TradeFormMarkerStore] — the seam unit tests inject, and the
/// cubit's default wherever persistence is not wired. Loses its records on a
/// cold start, which only means markers are shown again.
class InMemoryTradeFormMarkerStore implements TradeFormMarkerStore {
  final Set<TradeFormMarkerType> _done = <TradeFormMarkerType>{};

  @override
  Future<Set<TradeFormMarkerType>> completedMarkers() async =>
      <TradeFormMarkerType>{..._done};

  @override
  Future<void> markCompleted(TradeFormMarkerType marker) async =>
      _done.add(marker);

  @override
  Future<void> clearAll() async => _done.clear();
}
