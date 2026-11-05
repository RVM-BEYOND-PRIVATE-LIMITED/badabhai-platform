import '../../../core/consent/voice_consent.dart';
import '../../../core/di/locator.dart';
import '../domain/consent_repository.dart';

/// OWNER ASK (2026-10-22) — reads THIS worker's voice-consent answer from the
/// server (`GET /consent/me`, the latest consent row's purposes) into
/// [VoiceConsent]. A cold start, a reinstall or a second device therefore know
/// the answer the worker gave on the privacy screen.
///
/// Best-effort and FAIL CLOSED: a failed read leaves the answer unknown, which
/// keeps every voice control hidden (typing still works). Never throws.
Future<void> refreshVoiceConsent() async {
  if (!locator.isRegistered<ConsentRepository>()) return;
  try {
    final List<String> purposes =
        (await locator<ConsentRepository>().employerContactState()).purposes;
    VoiceConsent.instance.setFromPurposes(purposes);
  } catch (_) {
    // Unknown stays unknown: no voice control until a read succeeds.
  }
}
