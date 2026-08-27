import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The minimal async key/value surface [SecureTokenStore] needs from a
/// secure-storage backend. Abstracting it lets tests inject an in-memory fake
/// (the real `flutter_secure_storage` plugin throws under `flutter test`).
abstract interface class SecureKeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Adapts the real [FlutterSecureStorage] plugin to [SecureKeyValueStore].
/// On Android this is backed by the Keystore-encrypted shared prefs.
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

/// The single owner of the worker's persistent + in-memory auth credentials.
///
/// SECURITY (CLAUDE.md §2): the refresh token, device id, and worker id live
/// ONLY in [SecureKeyValueStore] (Android Keystore-backed). They are NEVER
/// written to shared_preferences, NEVER logged, and NEVER put in events. The
/// ACCESS token is held IN MEMORY ONLY ([_accessToken]) — it is never persisted
/// to disk so a stolen disk image yields no live bearer token. The device id is
/// a random UUID (no IMEI / phone / PII).
///
/// Nothing in this class prints a token.
class SecureTokenStore {
  SecureTokenStore(this._store);

  final SecureKeyValueStore _store;

  // Storage keys. Namespaced so they never collide with other plugins.
  static const String _kRefreshToken = 'bb_auth_refresh_token';
  static const String _kDeviceId = 'bb_auth_device_id';
  static const String _kWorkerId = 'bb_auth_worker_id';
  static const String _kPinSet = 'bb_auth_pin_set';
  static const String _kAccessExpiresAt = 'bb_auth_access_expires_at';
  static const String _kRefreshIdemKey = 'bb_auth_refresh_idem_key';
  static const String _kRefreshIdemMintedAt = 'bb_auth_refresh_idem_minted_at';

  /// Access token — MEMORY ONLY. Survives the app process but NOT a cold start;
  /// after a restart the interceptor refreshes it from the persisted refresh
  /// token. Never written to any store.
  String? accessToken;

  Future<String?> readRefreshToken() => _store.read(_kRefreshToken);
  Future<void> writeRefreshToken(String token) =>
      _store.write(_kRefreshToken, token);

  Future<String?> readWorkerId() => _store.read(_kWorkerId);
  Future<void> writeWorkerId(String id) => _store.write(_kWorkerId, id);

  /// The idempotency key for the IN-FLIGHT refresh rotation (#998). Persisted so a
  /// retry across separate `_doRefresh` calls presents the SAME key — a fresh key
  /// every call is guaranteed to miss the server's dedupe window, so a retry of a
  /// rotation whose response was lost re-presents an already-`used` token and
  /// reuse-detection force-logs-out the worker. Held only until the rotation is
  /// durably persisted, then cleared.
  ///
  /// [mintedAt] stamps WHEN the key was first minted so the caller can bound how
  /// long an unconfirmed rotation may be replayed (#1134): the server honours the
  /// key for `IDEM_GRACE_SECONDS` only, past which replaying it trips reuse
  /// detection. The timestamp is written ALONGSIDE the key and stays fixed across
  /// reuses (the clock runs from the first mint, not each retry).
  Future<String?> readRefreshIdempotencyKey() => _store.read(_kRefreshIdemKey);
  Future<void> writeRefreshIdempotencyKey(String key, DateTime mintedAt) async {
    await _store.write(_kRefreshIdemKey, key);
    await _store.write(
        _kRefreshIdemMintedAt, mintedAt.millisecondsSinceEpoch.toString());
  }

  /// When the persisted refresh idempotency key was first minted, or null when
  /// none is on file (or a legacy key persisted before #1134 carried no stamp).
  Future<DateTime?> readRefreshIdempotencyKeyMintedAt() async {
    final String? raw = await _store.read(_kRefreshIdemMintedAt);
    if (raw == null) return null;
    final int? ms = int.tryParse(raw);
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  Future<void> clearRefreshIdempotencyKey() async {
    await _store.delete(_kRefreshIdemKey);
    await _store.delete(_kRefreshIdemMintedAt);
  }

  Future<bool> readPinSet() async => (await _store.read(_kPinSet)) == 'true';
  Future<void> writePinSet(bool value) =>
      _store.write(_kPinSet, value ? 'true' : 'false');

  /// Absolute wall-clock instant the in-memory access token expires. Stored as
  /// ms-since-epoch so the interceptor can decide proactive refresh across a warm
  /// restart. Null when unknown.
  Future<DateTime?> readAccessExpiresAt() async {
    final String? raw = await _store.read(_kAccessExpiresAt);
    if (raw == null) return null;
    final int? ms = int.tryParse(raw);
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  Future<void> writeAccessExpiresAt(DateTime at) =>
      _store.write(_kAccessExpiresAt, at.millisecondsSinceEpoch.toString());

  /// Returns the persisted device id, minting + persisting a fresh random
  /// [Uuid] one the first time. Stable across restarts; PII-free.
  ///
  /// The UUID is generated by the caller-supplied [mintUuid] so the store has no
  /// dependency on a concrete uuid impl (DI passes `const Uuid().v4`).
  Future<String> getOrCreateDeviceId(String Function() mintUuid) async {
    final String? existing = await _store.read(_kDeviceId);
    if (existing != null && existing.isNotEmpty) return existing;
    final String fresh = mintUuid();
    await _store.write(_kDeviceId, fresh);
    return fresh;
  }

  Future<String?> readDeviceId() => _store.read(_kDeviceId);

  /// Persists a full token set after an OTP verify / PIN verify / refresh.
  Future<void> saveTokens({
    required String refreshToken,
    required DateTime accessExpiresAt,
    String? accessToken,
  }) async {
    await writeRefreshToken(refreshToken);
    await writeAccessExpiresAt(accessExpiresAt);
    this.accessToken = accessToken;
  }

  /// Wipes every persisted auth credential AND the in-memory access token.
  /// Called on logout and on an unrecoverable refresh failure (reuse / re-auth).
  ///
  /// Deliberately does NOT clear the device id — the device stays the same
  /// physical device across logins, which keeps the device list stable and lets
  /// the backend recognise a returning device.
  Future<void> clear() async {
    accessToken = null;
    await _store.delete(_kRefreshToken);
    await _store.delete(_kWorkerId);
    await _store.delete(_kPinSet);
    await _store.delete(_kAccessExpiresAt);
    await _store.delete(_kRefreshIdemKey);
    await _store.delete(_kRefreshIdemMintedAt);
  }
}
