import 'dart:async';

import 'package:firebase_remote_config/firebase_remote_config.dart';
import 'package:flutter/foundation.dart';

/// B7 — Firebase Remote Config, as a small typed wrapper.
///
/// ## What this is NOT
///
/// **Remote Config is CLIENT-DISPLAY ONLY. It cannot gate a server rule.** The
/// caps, quotas, consent gate, spend limits and feature flags that actually
/// matter live in server env and are enforced server-side; nothing here can
/// change what the API will or will not do. Every value below decides only what
/// THIS APP SHOWS. Treating an RC flag as a security or quota control would be a
/// bug — a worker can pin an old build, run offline, or simply never fetch.
///
/// ## The defaults are the contract
///
/// Every lever has a compiled-in default equal to TODAY'S BEHAVIOUR, and the
/// getters fall back to it whenever there is no activated value. So all of these
/// change nothing at all:
///   - Remote Config is down / the project has no such parameter,
///   - the very first launch, before any fetch has completed,
///   - a build with Firebase stripped or a device with no Google Play Services,
///   - `flutter test`, where the plugin is not registered.
///
/// That is why [init] is fire-and-forget and time-boxed: it can only ever
/// UPGRADE the app's knowledge, never gate its startup.
class BbRemoteConfig {
  BbRemoteConfig._();

  static final BbRemoteConfig instance = BbRemoteConfig._();

  // ---- RC parameter keys (the console must use these exact names) ----

  /// Hide the mic entry point in the profiling chat.
  static const String kKeyVoiceEntryHidden = 'worker_voice_entry_hidden';

  /// Hide the "invite a friend" entry point.
  static const String kKeyInviteEntryHidden = 'worker_invite_entry_hidden';

  /// Non-empty ⇒ show a maintenance notice above the chat composer. The STRING
  /// is the notice, so ops can say what is actually wrong instead of shipping a
  /// build. Worker-facing copy: it must obey the persona rules (aap-form, no
  /// vocative, no exclamation mark) — Remote Config is not exempt from them, and
  /// `test/persona_neutrality_test.dart` cannot check a string it never sees.
  static const String kKeyChatMaintenanceNotice = 'worker_chat_maintenance_notice';

  /// Whether boost affordances are shown.
  static const String kKeyBoostVisible = 'worker_boost_visible';

  /// Display copy for the free-quota line.
  static const String kKeyFreeQuotaCopy = 'worker_free_quota_copy';

  // ---- Compiled-in defaults == today's behaviour ----

  /// The mic is VISIBLE today.
  static const bool kDefaultVoiceEntryHidden = false;

  /// The invite row is VISIBLE today.
  static const bool kDefaultInviteEntryHidden = false;

  /// No maintenance notice is shown today (empty = show nothing).
  static const String kDefaultChatMaintenanceNotice = '';

  /// The worker app shows no boost affordance today.
  static const bool kDefaultBoostVisible = false;

  /// The worker app shows no free-quota line today (empty = show nothing).
  static const String kDefaultFreeQuotaCopy = '';

  /// The activated snapshot, or null until a fetch has succeeded. Read
  /// SYNCHRONOUSLY by widgets, which is why it is a plain map and not a live
  /// call into the plugin on every build.
  Map<String, Object>? _snapshot;

  /// True once a fetch-and-activate has actually landed. Purely diagnostic —
  /// nothing branches on it, because "not fetched" and "fetched the defaults"
  /// must behave identically.
  bool get isActivated => _snapshot != null;

  // ---- Typed levers ----

  /// Kill switch: hide the voice-note entry point in chat. Typing is always
  /// available, so hiding the mic degrades the flow but never blocks it.
  bool get voiceEntryHidden =>
      _bool(kKeyVoiceEntryHidden, kDefaultVoiceEntryHidden);

  /// Kill switch: hide the invite entry point (e.g. if the referral funnel has
  /// to be paused).
  bool get inviteEntryHidden =>
      _bool(kKeyInviteEntryHidden, kDefaultInviteEntryHidden);

  /// Maintenance notice for the profiling chat, or '' for "nothing to say".
  String get chatMaintenanceNotice =>
      _string(kKeyChatMaintenanceNotice, kDefaultChatMaintenanceNotice);

  /// Whether boost affordances are shown.
  ///
  /// NO CONSUMER IN THIS APP YET — boosts are a payer-side concept and the
  /// worker app renders none. It is declared here so the parameter NAME is fixed
  /// before a screen needs it, rather than a future screen inventing a second
  /// key for the same idea. Defaults to today's behaviour: not shown.
  bool get boostVisible => _bool(kKeyBoostVisible, kDefaultBoostVisible);

  /// Display copy for the free-quota line, or '' for "show nothing".
  ///
  /// NO CONSUMER IN THIS APP YET (same reasoning as [boostVisible]). Copy, not
  /// a number: the QUOTA itself is server-enforced and RC must never be read as
  /// the source of truth for one — this is only the sentence about it.
  String get freeQuotaCopy => _string(kKeyFreeQuotaCopy, kDefaultFreeQuotaCopy);

  bool _bool(String key, bool fallback) {
    final Object? value = _snapshot?[key];
    return value is bool ? value : fallback;
  }

  String _string(String key, String fallback) {
    final Object? value = _snapshot?[key];
    return value is String ? value : fallback;
  }

  /// Fetch and activate, bounded by [timeout]. NEVER throws, and never delays
  /// startup: call it unawaited from the splash / after the first frame.
  ///
  /// The timeout is short on purpose. Firebase's own `fetchTimeout` covers the
  /// network leg, but `Firebase.initializeApp()` on a non-GMS / AOSP ROM can
  /// hang rather than error (the same failure mode `CrashReporter` is bounded
  /// for), so the whole call is wrapped too. A miss costs nothing — the defaults
  /// above ARE today's behaviour.
  Future<void> init({Duration timeout = const Duration(seconds: 5)}) async {
    try {
      await _fetchAndActivate(timeout).timeout(timeout);
    } catch (_) {
      // Fail-open to the compiled-in defaults. Never surfaced, never fatal.
      if (kDebugMode) {
        debugPrint('[BbRemoteConfig] using compiled-in defaults');
      }
    }
  }

  Future<void> _fetchAndActivate(Duration timeout) async {
    final FirebaseRemoteConfig rc = FirebaseRemoteConfig.instance;
    await rc.setConfigSettings(RemoteConfigSettings(
      fetchTimeout: timeout,
      // A kill switch is worthless if it takes 12 hours to arrive. Ops flip
      // these to stop an active incident, so cache only briefly.
      minimumFetchInterval: const Duration(minutes: 5),
    ));
    // Seed the plugin with the SAME defaults the getters fall back to, so the
    // two can never disagree.
    await rc.setDefaults(<String, Object>{
      kKeyVoiceEntryHidden: kDefaultVoiceEntryHidden,
      kKeyInviteEntryHidden: kDefaultInviteEntryHidden,
      kKeyChatMaintenanceNotice: kDefaultChatMaintenanceNotice,
      kKeyBoostVisible: kDefaultBoostVisible,
      kKeyFreeQuotaCopy: kDefaultFreeQuotaCopy,
    });
    await rc.fetchAndActivate();
    _snapshot = <String, Object>{
      kKeyVoiceEntryHidden: rc.getBool(kKeyVoiceEntryHidden),
      kKeyInviteEntryHidden: rc.getBool(kKeyInviteEntryHidden),
      kKeyChatMaintenanceNotice: rc.getString(kKeyChatMaintenanceNotice),
      kKeyBoostVisible: rc.getBool(kKeyBoostVisible),
      kKeyFreeQuotaCopy: rc.getString(kKeyFreeQuotaCopy),
    };
  }

  /// Install an activated snapshot without touching Firebase. Test-only.
  @visibleForTesting
  void debugSetSnapshot(Map<String, Object> values) {
    _snapshot = Map<String, Object>.unmodifiable(values);
  }

  /// Drop back to the compiled-in defaults. Test-only.
  @visibleForTesting
  void debugReset() {
    _snapshot = null;
  }
}
