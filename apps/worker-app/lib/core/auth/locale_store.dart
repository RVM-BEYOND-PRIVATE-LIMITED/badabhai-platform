import 'package:shared_preferences/shared_preferences.dart';

/// The minimal surface [LocaleStore] needs from a key/value backend. Abstracting
/// it lets tests inject an in-memory fake (the real `shared_preferences` plugin
/// throws under `flutter test` without `setMockInitialValues`).
abstract interface class KeyValueStore {
  String? getString(String key);
  Future<void> setString(String key, String value);
}

/// Adapts [SharedPreferences] to [KeyValueStore].
class SharedPrefsKeyValueStore implements KeyValueStore {
  SharedPrefsKeyValueStore(this._prefs);

  final SharedPreferences _prefs;

  @override
  String? getString(String key) => _prefs.getString(key);

  @override
  Future<void> setString(String key, String value) =>
      _prefs.setString(key, value);
}

/// Persists the worker's chosen UI language code — the source of the `X-Locale`
/// header on every API call.
///
/// NON-SECRET by design: the locale is a preference, not a credential, so it
/// lives in shared_preferences (plain), NOT secure storage. The supported codes
/// mirror the backend's accepted set; default is Hindi.
///
/// PASS 2 wires the splash language picker to [write]; PASS 1 only provides the
/// store + the `X-Locale` source.
class LocaleStore {
  LocaleStore(this._store);

  final KeyValueStore _store;

  static const String _kLocale = 'bb_locale';

  /// Supported UI language codes. `hi` Hindi, `mr` Marathi, `bho` Bhojpuri,
  /// `en` English. Mirrors the assumed backend `X-Locale` set.
  static const List<String> supported = <String>['hi', 'mr', 'bho', 'en'];

  /// Default locale when the worker has not picked one yet.
  static const String defaultLocale = 'hi';

  /// The current locale code, falling back to [defaultLocale] when unset or
  /// (defensively) unsupported.
  String read() {
    final String? code = _store.getString(_kLocale);
    if (code == null || !supported.contains(code)) return defaultLocale;
    return code;
  }

  /// Persists [code]. Unsupported values are coerced to [defaultLocale] so the
  /// `X-Locale` header is always a known code.
  Future<void> write(String code) {
    final String safe = supported.contains(code) ? code : defaultLocale;
    return _store.setString(_kLocale, safe);
  }
}
