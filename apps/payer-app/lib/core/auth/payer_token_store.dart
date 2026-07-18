import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The minimal async key/value surface [PayerTokenStore] needs. Abstracting it
/// lets tests inject an in-memory fake (the real `flutter_secure_storage` plugin
/// throws under `flutter test`).
abstract interface class SecureKeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Adapts the real [FlutterSecureStorage] plugin to [SecureKeyValueStore].
/// On Android this is backed by Keystore-encrypted shared prefs.
class FlutterSecureKeyValueStore implements SecureKeyValueStore {
  FlutterSecureKeyValueStore([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// A simple in-memory [SecureKeyValueStore] for tests / the mock seam — the real
/// plugin is not reachable under `flutter test`.
class InMemoryKeyValueStore implements SecureKeyValueStore {
  final Map<String, String> _map = <String, String>{};

  @override
  Future<String?> read(String key) async => _map[key];

  @override
  Future<void> write(String key, String value) async => _map[key] = value;

  @override
  Future<void> delete(String key) async => _map.remove(key);
}

/// The single owner of the payer's session credentials.
///
/// SECURITY (CLAUDE.md §2): the access token, payer id, and role live ONLY in
/// [SecureKeyValueStore] (Android Keystore-backed). They are NEVER written to
/// shared_preferences, NEVER logged, and NEVER put in a request body. The app
/// never sends a body `payer_id` — the server derives it from the bearer token.
///
/// Payer auth is SIMPLER than the worker app: a single bearer access token (no
/// PIN, no rotating refresh token held client-side — `/payer/refresh` mints a
/// fresh token from the current bearer). Nothing here prints a token.
class PayerTokenStore {
  PayerTokenStore(this._store);

  final SecureKeyValueStore _store;

  static const String _kAccessToken = 'bb_payer_access_token';
  static const String _kPayerId = 'bb_payer_id';
  static const String _kRole = 'bb_payer_role';

  /// In-memory cache so signing a request never awaits disk. Hydrated by
  /// [load] at startup and kept in sync by [save] / [clear].
  String? _accessToken;
  String? _payerId;
  String? _role;

  String? get accessToken => _accessToken;
  String? get payerId => _payerId;
  String? get role => _role;

  bool get hasSession => _accessToken != null && _accessToken!.isNotEmpty;

  /// Hydrates the in-memory cache from secure storage (cold start).
  ///
  /// #377 — FAIL SOFT, never wedge the boot. `main()` awaits this BEFORE
  /// `runApp`, so anything thrown here escapes `main` and the first frame never
  /// renders: the payer sits on the native splash on EVERY launch with no way
  /// out but manually clearing app data.
  ///
  /// The realistic trigger is a restored Google backup: this store runs on
  /// EncryptedSharedPreferences, and a restore brings the prefs XML across but
  /// NOT the Keystore master key, so every read throws (BadPadding / keystore
  /// error). `allowBackup="false"` in the manifest stops new backups, but a
  /// device restoring one made by an older install still lands here.
  ///
  /// An unreadable store is indistinguishable from an empty one, so treat it as
  /// "no session": drop the unusable material and start at Login. The payer
  /// signs in again with an email OTP — annoying, but recoverable.
  Future<void> load() async {
    try {
      _accessToken = await _store.read(_kAccessToken);
      _payerId = await _store.read(_kPayerId);
      _role = await _store.read(_kRole);
    } catch (_) {
      _accessToken = null;
      _payerId = null;
      _role = null;
      // Best-effort wipe. clear() goes through the same backing store that just
      // threw, so it may throw too — swallow that. Failing to clear must not
      // resurrect the boot wedge this exists to prevent; a successful login
      // overwrites the bad entries anyway.
      try {
        await clear();
      } catch (_) {
        // Nothing more we can do — deliberately ignored.
      }
    }
  }

  /// Persists a fresh session after a successful verify / refresh.
  Future<void> save({
    required String accessToken,
    required String payerId,
    required String role,
  }) async {
    _accessToken = accessToken;
    _payerId = payerId;
    _role = role;
    await _store.write(_kAccessToken, accessToken);
    await _store.write(_kPayerId, payerId);
    await _store.write(_kRole, role);
  }

  /// Updates just the access token (e.g. after `/payer/refresh` rotates it).
  Future<void> saveAccessToken(String accessToken) async {
    _accessToken = accessToken;
    await _store.write(_kAccessToken, accessToken);
  }

  /// Wipes every persisted session credential AND the in-memory cache. Called on
  /// logout and on a 401 (the bearer is no longer valid).
  Future<void> clear() async {
    _accessToken = null;
    _payerId = null;
    _role = null;
    await _store.delete(_kAccessToken);
    await _store.delete(_kPayerId);
    await _store.delete(_kRole);
  }
}
