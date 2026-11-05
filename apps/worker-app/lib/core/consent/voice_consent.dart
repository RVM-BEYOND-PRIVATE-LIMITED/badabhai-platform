import 'package:flutter/foundation.dart';

import '../config/remote_config.dart';

/// The consent purpose that covers recording and processing the worker's voice
/// (`packages/types` `CONSENT_PURPOSES`, sent by the consent screen).
const String kVoiceConsentPurpose = 'voice_processing';

/// OWNER ASK (2026-10-22) — whether THIS worker allowed their voice to be
/// recorded ("Aapki awaaz record karne ki ijaazat" on the privacy screen).
///
/// A worker who taps "I don't agree" consents to typing only: every voice
/// control in the app — the chat mic, the companion voice note, the feedback
/// mic, the work-description mic — is HIDDEN, and the worker answers by typing.
///
/// FAIL CLOSED. Until the app KNOWS the worker granted [kVoiceConsentPurpose]
/// (from the consent screen this session, or the server's `GET /consent/me`),
/// voice stays hidden: an unknown answer is never treated as a yes (DPDP —
/// consent before processing). Typing always works, so nothing is blocked.
///
/// One process-wide instance; cleared on logout so one worker's answer never
/// carries into the next worker's session on a shared handset.
class VoiceConsent {
  VoiceConsent._();

  static final VoiceConsent instance = VoiceConsent._();

  /// TEST HARNESS ONLY: what an UNKNOWN consent reads as. The app never sets
  /// it; `test/flutter_test_config.dart` sets it `true` so suites written
  /// before this switch keep their voice controls, and the voice-consent tests
  /// set it back to `false` to prove the fail-closed default.
  @visibleForTesting
  static bool debugUnknownMeansGranted = false;

  /// `true` = granted, `false` = declined, `null` = not known yet.
  final ValueNotifier<bool?> state = ValueNotifier<bool?>(null);

  /// Whether a voice control may be SHOWN: the worker granted voice consent
  /// AND the remote kill switch (`worker_voice_entry_hidden`) is off.
  bool get voiceAllowed {
    final bool granted = state.value ?? debugUnknownMeansGranted;
    return granted && !BbRemoteConfig.instance.voiceEntryHidden;
  }

  /// Records the answer just given on the consent screen.
  void set({required bool granted}) => state.value = granted;

  /// Reads the answer from the worker's latest consent purposes (server
  /// truth, `GET /consent/me`).
  void setFromPurposes(List<String> purposes) =>
      state.value = purposes.contains(kVoiceConsentPurpose);

  /// Logout: forget this worker's answer.
  void clear() => state.value = null;
}
