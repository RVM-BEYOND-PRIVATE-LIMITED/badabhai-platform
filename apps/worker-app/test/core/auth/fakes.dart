import 'package:badabhai_worker_app/core/auth/biometric_service.dart';
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

/// In-memory [BiometricService] (#2451). The real plugin throws under
/// `flutter test`, so every biometric test drives one of these instead.
///
/// [availabilityValue] and [result] are settable so a test can script success,
/// cancel, unavailable and enrollment-removed. Calls are counted so the UI can
/// prove the one-shot auto prompt does not loop and that the explicit CTA
/// retries exactly once.
class FakeBiometricService implements BiometricService {
  BiometricAvailability availabilityValue = BiometricAvailability.available;
  BiometricUnlockResult result = BiometricUnlockResult.success;

  int availabilityCalls = 0;
  int authenticateCalls = 0;
  String? lastReason;

  @override
  Future<BiometricAvailability> availability() async {
    availabilityCalls++;
    return availabilityValue;
  }

  @override
  Future<BiometricUnlockResult> authenticate({required String reason}) async {
    authenticateCalls++;
    lastReason = reason;
    return result;
  }
}
