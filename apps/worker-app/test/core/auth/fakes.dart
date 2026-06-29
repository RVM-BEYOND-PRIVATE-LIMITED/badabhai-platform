import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';

/// In-memory [SecureKeyValueStore] for tests. The real flutter_secure_storage
/// plugin throws under `flutter test`, so SecureTokenStore is constructed over
/// this fake. The [map] is exposed so security assertions can inspect exactly
/// what was persisted.
class FakeSecureStore implements SecureKeyValueStore {
  FakeSecureStore([Map<String, String>? backing])
      : map = backing ?? <String, String>{};

  /// The backing store — shared across "restarts" by constructing a new
  /// [SecureTokenStore] over the same map.
  final Map<String, String> map;

  @override
  Future<String?> read(String key) async => map[key];

  @override
  Future<void> write(String key, String value) async => map[key] = value;

  @override
  Future<void> delete(String key) async => map.remove(key);
}

/// In-memory [KeyValueStore] for tests, standing in for SharedPreferences
/// (which also throws under `flutter test` without mock init). The [map] is the
/// PLAIN store — security tests assert no secret ever lands here.
class FakePrefs implements KeyValueStore {
  FakePrefs([Map<String, String>? backing])
      : map = backing ?? <String, String>{};

  final Map<String, String> map;

  @override
  String? getString(String key) => map[key];

  @override
  Future<void> setString(String key, String value) async => map[key] = value;
}
