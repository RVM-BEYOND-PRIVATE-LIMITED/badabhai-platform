import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/firebase/firebase_boot.dart';

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
      expect(rc.voiceFormHidden, BbRemoteConfig.kDefaultVoiceFormHidden);
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
      // Deliberately the OPPOSITE default: the voice-form module ships DARK.
      expect(rc.voiceFormHidden, isTrue,
          reason: 'the voice-form module is hidden until staging validates it');
      expect(rc.inviteEntryHidden, isFalse, reason: 'the invite row is visible today');
      expect(rc.chatMaintenanceNotice, isEmpty, reason: 'no maintenance notice today');
      expect(rc.boostVisible, isFalse, reason: 'the worker app shows no boost affordance');
      expect(rc.freeQuotaCopy, isEmpty, reason: 'no free-quota line today');
    });

    // THE PRODUCTION BUG. `FirebaseRemoteConfig.instance` throws until an
    // `initializeApp()` has COMPLETED, and init() used to start while the crash
    // reporter's was still in flight: it threw on every cold start, and no console
    // value ever reached a device. The test above cannot see that — it passes
    // whether or not init() waits — so this one holds Firebase's init open and
    // checks init() does not finish (i.e. never reached Remote Config) before it.
    test('init() waits for Firebase to be initialized before it touches Remote Config', () async {
      final Completer<Object?> boot = Completer<Object?>();
      int boots = 0;
      FirebaseBoot.debugInitializer = () {
        boots++;
        return boot.future;
      };
      addTearDown(FirebaseBoot.debugReset);

      bool finished = false;
      final Future<void> pending =
          rc.init(timeout: const Duration(milliseconds: 200)).then((_) => finished = true);
      await pumpEventQueue();
      expect(boots, 1);
      expect(finished, isFalse, reason: 'init() must not reach Remote Config before Firebase is up');

      boot.complete(null);
      await pending;
      // Remote Config is still unregistered under `flutter test`, so the fetch
      // itself fails — swallowed, defaults kept, exactly as before.
      expect(finished, isTrue);
      expect(rc.isActivated, isFalse);
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

  group('kDefaults is the ONE source for the fetch path', () {
    test('every declared remote key appears in kDefaults', () {
      // The bug this exists to stop: `worker_voice_form_hidden` was declared,
      // given a default and read by a getter, but appeared in NEITHER the
      // setDefaults literal nor the snapshot literal — so the console
      // parameter was inert on every device, forever, silently. Every
      // activated-config test goes through debugSetSnapshot, which bypasses
      // the fetch path entirely, so nothing else can catch this.
      const List<String> declared = <String>[
        BbRemoteConfig.kKeyVoiceEntryHidden,
        BbRemoteConfig.kKeyInviteEntryHidden,
        BbRemoteConfig.kKeyVoiceFormHidden,
        BbRemoteConfig.kKeyChatMaintenanceNotice,
        BbRemoteConfig.kKeyBoostVisible,
        BbRemoteConfig.kKeyFreeQuotaCopy,
        BbRemoteConfig.kKeyChatCompanionEnabled,
        BbRemoteConfig.kKeyChatCompanionV2Enabled,
      ];
      for (final String key in declared) {
        expect(BbRemoteConfig.kDefaults.containsKey(key), isTrue,
            reason: '$key is missing from kDefaults — its Remote Config '
                'parameter would be inert on every device');
      }
      expect(BbRemoteConfig.kDefaults, hasLength(declared.length),
          reason: 'kDefaults carries a key no getter declares');
    });

    test('each kDefaults value matches the constant its getter falls back to',
        () {
      // The two halves disagreeing is the other way this breaks: the plugin
      // seeded with one value, the getter falling back to another.
      expect(BbRemoteConfig.kDefaults[BbRemoteConfig.kKeyVoiceFormHidden],
          BbRemoteConfig.kDefaultVoiceFormHidden);
      expect(BbRemoteConfig.kDefaults[BbRemoteConfig.kKeyVoiceEntryHidden],
          BbRemoteConfig.kDefaultVoiceEntryHidden);
      expect(BbRemoteConfig.kDefaults[BbRemoteConfig.kKeyBoostVisible],
          BbRemoteConfig.kDefaultBoostVisible);
      expect(BbRemoteConfig.kDefaults[BbRemoteConfig.kKeyFreeQuotaCopy],
          BbRemoteConfig.kDefaultFreeQuotaCopy);
      expect(BbRemoteConfig.kDefaults[BbRemoteConfig.kKeyChatCompanionEnabled],
          BbRemoteConfig.kDefaultChatCompanionEnabled);
      expect(BbRemoteConfig.kDefaults[BbRemoteConfig.kKeyChatCompanionV2Enabled],
          BbRemoteConfig.kDefaultChatCompanionV2Enabled);
    });

    test('companion v2 ships DARK — no edit card, no task chips, no mic', () {
      // ADR-0046 F4. The server's own flags decide BEHAVIOUR; this lever decides
      // only whether a build may render the v2 fields at all, so its default
      // must be false on a phone that has never fetched.
      BbRemoteConfig.instance.debugReset();
      expect(BbRemoteConfig.instance.chatCompanionV2Enabled, isFalse,
          reason: 'never fetched — v2 must be dark');
      BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyChatCompanionV2Enabled: true,
      });
      expect(BbRemoteConfig.instance.chatCompanionV2Enabled, isTrue);
      // A console value of the wrong type must not read as ON.
      BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyChatCompanionV2Enabled: 'true',
      });
      expect(BbRemoteConfig.instance.chatCompanionV2Enabled, isFalse,
          reason: 'a String must fail closed, not parse as true');
      BbRemoteConfig.instance.debugReset();
    });

    test('the chat companion ships DARK — the tab asks only once flipped', () {
      BbRemoteConfig.instance.debugReset();
      expect(BbRemoteConfig.instance.chatCompanionEnabled, isFalse);
      BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyChatCompanionEnabled: true,
      });
      expect(BbRemoteConfig.instance.chatCompanionEnabled, isTrue);
      BbRemoteConfig.instance.debugReset();
    });

    test('the voice form ships HIDDEN by default — the flip is console-only',
        () {
      // AC: an un-validated module must never be visible on a device that
      // has not fetched, or whose fetch failed.
      expect(BbRemoteConfig.kDefaultVoiceFormHidden, isTrue);
      rc.debugReset();
      expect(rc.voiceFormHidden, isTrue);
    });
  });
}
