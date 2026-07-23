import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/referral/pending_referral_store.dart';

void main() {
  group(r'isValidReferralCode (^[a-f0-9]{12}$)', () {
    test('accepts exactly 12 lowercase-hex chars', () {
      expect(isValidReferralCode('abcdef012345'), isTrue);
      expect(isValidReferralCode('0123456789ab'), isTrue);
    });

    test('rejects wrong length, case, non-hex, null and empty', () {
      expect(isValidReferralCode(null), isFalse);
      expect(isValidReferralCode(''), isFalse);
      expect(isValidReferralCode('abcdef01234'), isFalse); // 11
      expect(isValidReferralCode('abcdef0123456'), isFalse); // 13
      expect(isValidReferralCode('ABCDEF012345'), isFalse); // uppercase
      expect(isValidReferralCode('abcdefg12345'), isFalse); // g not hex
      expect(isValidReferralCode('abc def01234'), isFalse); // space
    });
  });

  group('InMemoryPendingReferralStore', () {
    test('captures a valid code; take() returns it then clears (once)', () async {
      final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
      await store.capture('abcdef012345');

      expect(await store.take(), 'abcdef012345');
      // Consumed exactly once — a second take is empty.
      expect(await store.take(), isNull);
    });

    test('ignores an invalid code entirely', () async {
      final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
      await store.capture('NOT-A-CODE');
      expect(await store.take(), isNull);
    });

    test('last valid capture wins', () async {
      final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
      await store.capture('aaaaaaaaaaaa');
      await store.capture('bbbbbbbbbbbb');
      expect(await store.take(), 'bbbbbbbbbbbb');
    });
  });

  group('SharedPrefsPendingReferralStore', () {
    setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

    test('persists a valid code and consumes it exactly once', () async {
      const SharedPrefsPendingReferralStore store =
          SharedPrefsPendingReferralStore();

      await store.capture('abcdef012345');
      // Survives a "cold start" — a fresh store instance over the same prefs.
      const SharedPrefsPendingReferralStore reborn =
          SharedPrefsPendingReferralStore();

      expect(await reborn.take(), 'abcdef012345');
      expect(await reborn.take(), isNull); // cleared on take
    });

    test('never persists an invalid code', () async {
      const SharedPrefsPendingReferralStore store =
          SharedPrefsPendingReferralStore();
      await store.capture('bad');

      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(SharedPrefsPendingReferralStore.kKey), isNull);
      expect(await store.take(), isNull);
    });
  });
}
