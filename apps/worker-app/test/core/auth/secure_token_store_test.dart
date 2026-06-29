import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';

import 'fakes.dart';

void main() {
  group('SecureTokenStore', () {
    test('refresh token + device id persist and survive a "restart"', () async {
      final FakeSecureStore backing = FakeSecureStore();
      final SecureTokenStore store = SecureTokenStore(backing);

      await store.writeRefreshToken('refresh-1');
      final String deviceId = await store.getOrCreateDeviceId(() => 'device-uuid');

      // Simulate a cold restart: a brand-new store over the SAME backing map.
      final SecureTokenStore restarted = SecureTokenStore(backing);
      expect(await restarted.readRefreshToken(), 'refresh-1');
      expect(await restarted.readDeviceId(), deviceId);
      // Access token is memory-only — gone after the "restart".
      expect(restarted.accessToken, isNull);
    });

    test('device id is stable across calls (minted once)', () async {
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      int mints = 0;
      String mint() {
        mints++;
        return 'device-$mints';
      }

      final String first = await store.getOrCreateDeviceId(mint);
      final String second = await store.getOrCreateDeviceId(mint);

      expect(first, second);
      expect(mints, 1); // minted exactly once, reused thereafter
    });

    test('access token stays in memory and is never written to the store',
        () async {
      final FakeSecureStore backing = FakeSecureStore();
      final SecureTokenStore store = SecureTokenStore(backing);

      await store.saveTokens(
        refreshToken: 'refresh-2',
        accessExpiresAt: DateTime.now().add(const Duration(minutes: 10)),
        accessToken: 'access-secret',
      );

      expect(store.accessToken, 'access-secret');
      // SECURITY: the access token value must NOT appear anywhere on disk.
      expect(
        backing.map.values.any((String v) => v.contains('access-secret')),
        isFalse,
        reason: 'access token must never be persisted',
      );
    });

    test('clear() wipes secrets but keeps the device id', () async {
      final FakeSecureStore backing = FakeSecureStore();
      final SecureTokenStore store = SecureTokenStore(backing);

      final String deviceId = await store.getOrCreateDeviceId(() => 'dev-keep');
      await store.saveTokens(
        refreshToken: 'refresh-3',
        accessExpiresAt: DateTime.now().add(const Duration(minutes: 5)),
        accessToken: 'access-3',
      );
      await store.writeWorkerId('worker-3');
      await store.writePinSet(true);

      await store.clear();

      expect(store.accessToken, isNull);
      expect(await store.readRefreshToken(), isNull);
      expect(await store.readWorkerId(), isNull);
      expect(await store.readPinSet(), isFalse);
      // Device id deliberately survives logout.
      expect(await store.readDeviceId(), deviceId);
    });

    test('pinSet round-trips as a boolean', () async {
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      expect(await store.readPinSet(), isFalse);
      await store.writePinSet(true);
      expect(await store.readPinSet(), isTrue);
    });
  });
}
