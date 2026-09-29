import 'dart:async';

import 'package:firebase_remote_config/firebase_remote_config.dart';
import 'package:flutter/foundation.dart';

import '../firebase/firebase_boot.dart';

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

  /// Hide the voice-driven profiling FORM (the whole #627–#639 module). Distinct
  /// from [kKeyVoiceEntryHidden], which only hides the mic inside the existing
  /// chat. Compiled default is HIDDEN — the module ships dark and is flipped on
  /// only once staging validates it.
  static const String kKeyVoiceFormHidden = 'worker_voice_form_hidden';

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

  /// ADR-0044 — may the Bada Bhai TAB ask the server for the post-completion
  /// companion (`GET /chat/companion`)? The SERVER decides who is a companion
  /// worker (`CHAT_COMPANION_ENABLED` + its mode rule); this only decides whether
  /// the app asks at all. Off, the tab does exactly what it did before this
  /// existed — not even the extra request is made.
  static const String kKeyChatCompanionEnabled = 'worker_chat_companion_enabled';

  /// ADR-0046 — the companion's **Phase 1** v2 surface: the edit proposal card
  /// (contracts §5.1, P1), the task chips (§5.3) and the composer's voice
  /// button. Its own lever, separate from ADR-0044's `chatCompanionEnabled`
  /// recap, so v2 can ship dark while the recap is already live.
  ///
  /// This decides only whether the app may RENDER the v2 fields; the server's
  /// own phase flags decide what it sends. Defaults to HIDDEN.
  static const String kKeyChatCompanionV2Enabled = 'worker_chat_companion_v2_enabled';

  // ---- Compiled-in defaults == today's behaviour ----

  /// The mic is VISIBLE today.
  static const bool kDefaultVoiceEntryHidden = false;

  /// The invite row is VISIBLE today.
  static const bool kDefaultInviteEntryHidden = false;

  /// The voice-form module is HIDDEN today — it ships dark, behind a staging
  /// flip. This default is deliberately the opposite of the other kill switches.
  static const bool kDefaultVoiceFormHidden = true;

  /// No maintenance notice is shown today (empty = show nothing).
  static const String kDefaultChatMaintenanceNotice = '';

  /// The worker app shows no boost affordance today.
  static const bool kDefaultBoostVisible = false;

  /// The worker app shows no free-quota line today (empty = show nothing).
  static const String kDefaultFreeQuotaCopy = '';

  /// The tab does not ask for the companion today — it ships dark, and is flipped
  /// on (with the server flag) staging-first.
  static const bool kDefaultChatCompanionEnabled = false;

  /// The v2 surface ships DARK — no edit card, no task chips, no voice button.
  /// Flipped on staging-first, with the server's Phase 1 flags.
  static const bool kDefaultChatCompanionV2Enabled = false;

  /// EVERY remote key with the default its getter falls back to — the single
  /// source for `setDefaults` AND for the activated snapshot.
  ///
  /// A key absent here is invisible to Remote Config no matter how many
  /// getters reference it: the snapshot never carries it, so `_bool`/`_string`
  /// return the compiled constant forever and the console parameter is inert.
  /// A new key belongs in this map, and the fetch path picks it up for free.
  /// `bool` values are read with `getBool`, everything else with `getString`.
  static const Map<String, Object> kDefaults = <String, Object>{
    kKeyVoiceEntryHidden: kDefaultVoiceEntryHidden,
    kKeyInviteEntryHidden: kDefaultInviteEntryHidden,
    kKeyVoiceFormHidden: kDefaultVoiceFormHidden,
    kKeyChatMaintenanceNotice: kDefaultChatMaintenanceNotice,
    kKeyBoostVisible: kDefaultBoostVisible,
    kKeyFreeQuotaCopy: kDefaultFreeQuotaCopy,
    kKeyChatCompanionEnabled: kDefaultChatCompanionEnabled,
    kKeyChatCompanionV2Enabled: kDefaultChatCompanionV2Enabled,
  };

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

  /// Kill switch (#638): hide the whole voice-form module. Compiled default is
  /// HIDDEN — when true, the entry chooser never renders and profiling routes
  /// straight to the existing chat, exactly as it does today.
  bool get voiceFormHidden =>
      _bool(kKeyVoiceFormHidden, kDefaultVoiceFormHidden);

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

  /// ADR-0044 — whether the Bada Bhai tab asks for the post-completion companion.
  /// Client display only, like every lever here: the server still decides who
  /// gets it, and answers `interview` to everyone while its own flag is off.
  bool get chatCompanionEnabled =>
      _bool(kKeyChatCompanionEnabled, kDefaultChatCompanionEnabled);

  /// ADR-0046 — whether the companion's v2 surface may be drawn (the Phase 1
  /// edit card, task chips and voice button). Independent of
  /// [chatCompanionEnabled], which is ADR-0044's recap.
  bool get chatCompanionV2Enabled =>
      _bool(kKeyChatCompanionV2Enabled, kDefaultChatCompanionV2Enabled);

  bool _bool(String key, bool fallback) {
    // A DEBUG-BUILD override, so a lever can be exercised on a cabled phone
    // without a console round-trip. Empty and inert in every release build —
    // see [kDebugForcedRemoteFlags].
    if (_debugForced.contains(key)) return true;
    final Object? value = _snapshot?[key];
    return value is bool ? value : fallback;
  }

  String _string(String key, String fallback) {
    final Object? value = _snapshot?[key];
    return value is String ? value : fallback;
  }

  /// The boolean levers a DEBUG build forces on, comma-separated.
  ///
  /// WHY THIS EXISTS. Every lever here ships at today's behaviour, and the v2
  /// levers ship OFF, so a developer with the app on a cable sees exactly
  /// nothing of a dark feature — the only switch is the Firebase console, which
  /// means waiting on whoever owns the project and flipping a parameter that
  /// reaches real devices within five minutes. That is the wrong tool for
  /// "does my screen render". This is the right one:
  ///
  ///   flutter run --dart-define=FORCE_REMOTE_FLAGS=worker_chat_companion_enabled,worker_chat_companion_v2_enabled
  ///
  /// RELEASE BUILDS IGNORE IT COMPLETELY, and that is the whole safety argument.
  /// These levers include KILL SWITCHES (`worker_voice_entry_hidden`), so an
  /// override that survived into a release could pin a mic visible during the
  /// very incident ops were trying to stop. [_debugForced] is therefore empty
  /// unless [kDebugMode], regardless of what was defined at build time.
  ///
  /// FORCES ON ONLY. A lever is either left alone or forced true; nothing here
  /// can force one false, because "off" is already every default and is
  /// reachable by simply not passing the flag. One direction is one thing to
  /// reason about.
  static const String kDebugForcedRemoteFlags =
      String.fromEnvironment('FORCE_REMOTE_FLAGS');

  /// [kDebugForcedRemoteFlags], parsed — and empty in release.
  static final Set<String> _debugForced = kDebugMode
      ? kDebugForcedRemoteFlags
          .split(',')
          .map((String k) => k.trim())
          .where((String k) => k.isNotEmpty)
          .toSet()
      : const <String>{};

  /// Fetch and activate, bounded by [timeout]. NEVER throws, and never delays
  /// startup: call it unawaited from the splash / after the first frame.
  ///
  /// FIREBASE FIRST. `FirebaseRemoteConfig.instance` throws until an
  /// `initializeApp()` has COMPLETED, and this used to start beside the crash
  /// reporter's still-pending one: it threw on every cold start, the catch below
  /// swallowed it, and no console value ever reached a device. It now waits for
  /// the shared [FirebaseBoot], which carries its own timeout for a native init
  /// that hangs on a non-GMS / AOSP ROM.
  ///
  /// The fetch timeout is short on purpose. Firebase's own `fetchTimeout` covers
  /// the network leg, and the whole fetch is wrapped too. A miss costs nothing —
  /// the defaults above ARE today's behaviour.
  Future<void> init({Duration timeout = const Duration(seconds: 5)}) async {
    try {
      await FirebaseBoot.ensureInitialized();
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
    // ONE source of truth for both halves. They were two hand-maintained
    // literals, and `worker_voice_form_hidden` shipped in NEITHER — so the
    // getter always read the compiled default and the console parameter did
    // nothing at all. Worse, adding it to the snapshot alone would have made
    // `getBool` return Firebase's static `false` for a parameter no console
    // defines, flipping the un-validated module VISIBLE on every device that
    // completed a fetch. Driving both from [kDefaults] makes forgetting one
    // half unrepresentable.
    await rc.setDefaults(kDefaults);
    await rc.fetchAndActivate();
    _snapshot = <String, Object>{
      for (final MapEntry<String, Object> e in kDefaults.entries)
        e.key: e.value is bool ? rc.getBool(e.key) : rc.getString(e.key),
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
