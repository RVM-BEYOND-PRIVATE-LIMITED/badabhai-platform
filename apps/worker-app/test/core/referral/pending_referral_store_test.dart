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

  // ── B4: the source tag (which leg delivered the code) ────────────────────────
  //
  // Without this the API only ever receives `source: unknown`, and a broken
  // App-Link or Install-Referrer leg is invisible — the funnel just silently
  // shrinks, which is the exact failure B4 exists to end.
  group('ReferralSource wire tokens', () {
    test('match the server enum EXACTLY (snake_case, not Dart camelCase)', () {
      // These strings are the contract with packages/event-schema's
      // InviteInstallSource. `name` would send "appLink" and be rejected.
      expect(ReferralSource.appLink.wire, 'app_link');
      expect(ReferralSource.installReferrer.wire, 'install_referrer');
      expect(ReferralSource.customScheme.wire, 'custom_scheme');
      expect(ReferralSource.unknown.wire, 'unknown');
    });

    test('fromWire round-trips, and degrades unknown input to unknown', () {
      for (final ReferralSource s in ReferralSource.values) {
        expect(ReferralSource.fromWire(s.wire), s);
      }
      expect(ReferralSource.fromWire('appLink'), ReferralSource.unknown);
      expect(ReferralSource.fromWire(null), ReferralSource.unknown);
      expect(ReferralSource.fromWire('garbage'), ReferralSource.unknown);
    });
  });

  group('pending referral source tagging', () {
    setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

    test('in-memory store round-trips the source through takePending', () async {
      final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
      await store.capture('abcdef012345',
          source: ReferralSource.installReferrer);

      final PendingReferral? pending = await store.takePending();
      expect(pending?.code, 'abcdef012345');
      expect(pending?.source, ReferralSource.installReferrer);
      expect(await store.takePending(), isNull); // consumed once
    });

    test('prefs store persists the source across a cold start', () async {
      const SharedPrefsPendingReferralStore store =
          SharedPrefsPendingReferralStore();
      await store.capture('abcdef012345', source: ReferralSource.appLink);

      const SharedPrefsPendingReferralStore reborn =
          SharedPrefsPendingReferralStore();
      final PendingReferral? pending = await reborn.takePending();
      expect(pending?.code, 'abcdef012345');
      expect(pending?.source, ReferralSource.appLink);
    });

    test('an untagged capture defaults to unknown (pre-B4 call sites)', () async {
      final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
      await store.capture('abcdef012345');
      expect((await store.takePending())?.source, ReferralSource.unknown);
    });

    test('take() still returns the bare code — the legacy contract is intact',
        () async {
      final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
      await store.capture('abcdef012345', source: ReferralSource.appLink);
      expect(await store.take(), 'abcdef012345');
      expect(await store.take(), isNull);
    });

    test('a STALE source never mislabels the next untagged code', () async {
      // The regression: clearing the code but leaving the source key behind would
      // make the NEXT capture (untagged) report the previous leg — silently
      // fabricating attribution provenance.
      const SharedPrefsPendingReferralStore store =
          SharedPrefsPendingReferralStore();
      await store.capture('aaaaaaaaaaaa', source: ReferralSource.appLink);
      await store.takePending();

      final SharedPreferences prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(SharedPrefsPendingReferralStore.kSourceKey), isNull);

      await store.capture('bbbbbbbbbbbb');
      expect((await store.takePending())?.source, ReferralSource.unknown);
    });
  });
}
