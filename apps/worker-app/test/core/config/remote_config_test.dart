import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/config/remote_config.dart';

/// B7 — the Remote Config SAFE-FALLBACK contract.
///
/// The whole design rests on one property: when Remote Config is unreachable the
/// app must behave EXACTLY as it does today — not fail open, not fail closed, not
/// half-apply. `flutter test` registers no Firebase plugin, so every test here runs
/// in genuinely the same state as the failure modes we care about (RC down, first
/// launch before any fetch, a non-GMS device, a build with Firebase stripped).
///
/// These are the tests that make "safe fallback" a checked claim rather than a
/// comment. `init()` is exercised too — the unreachable-Firebase path must be
/// swallowed, because a throw there would take down app startup.
void main() {
  final BbRemoteConfig rc = BbRemoteConfig.instance;

  setUp(rc.debugReset);
  tearDown(rc.debugReset);

  group('fallback — no activated config (RC down / first launch / no GMS)', () {
    test('every lever returns its compiled-in default', () {
      expect(rc.isActivated, isFalse);
      expect(rc.voiceEntryHidden, BbRemoteConfig.kDefaultVoiceEntryHidden);
      expect(rc.inviteEntryHidden, BbRemoteConfig.kDefaultInviteEntryHidden);
      expect(rc.chatMaintenanceNotice, BbRemoteConfig.kDefaultChatMaintenanceNotice);
      expect(rc.boostVisible, BbRemoteConfig.kDefaultBoostVisible);
      expect(rc.freeQuotaCopy, BbRemoteConfig.kDefaultFreeQuotaCopy);
    });

    test('the defaults ARE today\'s behaviour — nothing is hidden and no notice shows', () {
      // Pinned as VALUES, not as a self-comparison: a future edit that flips a
      // default would silently change what a fetch-less device does, which is the
      // one thing this layer promises never to happen by accident.
      expect(rc.voiceEntryHidden, isFalse, reason: 'the mic is visible today');
      expect(rc.inviteEntryHidden, isFalse, reason: 'the invite row is visible today');
      expect(rc.chatMaintenanceNotice, isEmpty, reason: 'no maintenance notice today');
      expect(rc.boostVisible, isFalse, reason: 'the worker app shows no boost affordance');
      expect(rc.freeQuotaCopy, isEmpty, reason: 'no free-quota line today');
    });

    test('init() with Firebase unavailable never throws and never activates', () async {
      // The real failure mode: no plugin registered. init() must swallow it — an
      // escaping error here would break startup for every non-GMS device.
      await expectLater(rc.init(timeout: const Duration(milliseconds: 200)), completes);
      expect(rc.isActivated, isFalse);
      // …and the app is still on the defaults afterwards.
      expect(rc.voiceEntryHidden, isFalse);
      expect(rc.boostVisible, isFalse);
    });
  });

  group('activated config', () {
    test('an activated snapshot overrides the defaults', () {
      rc.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyVoiceEntryHidden: true,
        BbRemoteConfig.kKeyBoostVisible: true,
        BbRemoteConfig.kKeyChatMaintenanceNotice: 'Abhi seva band hai.',
      });

      expect(rc.isActivated, isTrue);
      expect(rc.voiceEntryHidden, isTrue);
      expect(rc.boostVisible, isTrue);
      expect(rc.chatMaintenanceNotice, 'Abhi seva band hai.');
    });

    test('a key ABSENT from the snapshot still falls back per-key', () {
      // A partial payload is the realistic console state: params are added one at a
      // time, so an activated config routinely lacks keys this build knows about.
      rc.debugSetSnapshot(<String, Object>{BbRemoteConfig.kKeyVoiceEntryHidden: true});

      expect(rc.voiceEntryHidden, isTrue);
      expect(rc.inviteEntryHidden, BbRemoteConfig.kDefaultInviteEntryHidden);
      expect(rc.freeQuotaCopy, BbRemoteConfig.kDefaultFreeQuotaCopy);
    });

    test('a WRONG-TYPED value falls back instead of crashing or coercing', () {
      // The console is a text box — someone can type "yes" into a boolean param, or
      // ship a number where copy is expected. Coercing would let a typo silently
      // flip a kill switch; the getters must reject the value and use the default.
      rc.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyVoiceEntryHidden: 'yes',
        BbRemoteConfig.kKeyBoostVisible: 1,
        BbRemoteConfig.kKeyChatMaintenanceNotice: 42,
      });

      expect(rc.voiceEntryHidden, BbRemoteConfig.kDefaultVoiceEntryHidden);
      expect(rc.boostVisible, BbRemoteConfig.kDefaultBoostVisible);
      expect(rc.chatMaintenanceNotice, BbRemoteConfig.kDefaultChatMaintenanceNotice);
    });

    test('debugReset drops back to the defaults', () {
      rc.debugSetSnapshot(<String, Object>{BbRemoteConfig.kKeyBoostVisible: true});
      expect(rc.boostVisible, isTrue);

      rc.debugReset();

      expect(rc.isActivated, isFalse);
      expect(rc.boostVisible, BbRemoteConfig.kDefaultBoostVisible);
    });
  });

  group('the quota is NOT a Remote Config value (ADR-0036 §8)', () {
    test('the free-quota lever is display COPY, never a number', () {
      // Guards the boundary the RC doc states: the free-tier quota is enforced
      // server-side from `match_config.free_unlock_credits`. RC carries only the
      // SENTENCE about it, so a client that never fetches cannot mint itself a
      // different quota. If this ever becomes an int, that invariant is gone.
      rc.debugSetSnapshot(<String, Object>{BbRemoteConfig.kKeyFreeQuotaCopy: '50 free unlocks'});
      expect(rc.freeQuotaCopy, isA<String>());
      expect(BbRemoteConfig.kDefaultFreeQuotaCopy, isA<String>());
    });
  });
}
