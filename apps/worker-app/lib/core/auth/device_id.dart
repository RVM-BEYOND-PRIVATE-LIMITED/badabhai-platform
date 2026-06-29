import 'package:uuid/uuid.dart';

import 'secure_token_store.dart';

/// Provides a stable, PII-free device id for the `X-Device-Id` header.
///
/// The id is a random [Uuid] v4 generated on first run and persisted in
/// [SecureTokenStore] (Keystore-backed). It is NOT derived from hardware
/// (no IMEI / MAC / phone) so it carries no PII and can be rotated by clearing
/// secure storage. Stable across restarts; cached in memory after first read so
/// the hot path (every request) does no storage I/O.
class DeviceIdProvider {
  DeviceIdProvider(this._store, {Uuid? uuid}) : _uuid = uuid ?? const Uuid();

  final SecureTokenStore _store;
  final Uuid _uuid;

  String? _cached;

  /// Returns the device id, minting + persisting one on first call. Idempotent
  /// and safe to call on every request — subsequent calls hit the in-memory
  /// cache.
  Future<String> getOrCreate() async {
    final String? cached = _cached;
    if (cached != null) return cached;
    final String id = await _store.getOrCreateDeviceId(_uuid.v4);
    _cached = id;
    return id;
  }
}
