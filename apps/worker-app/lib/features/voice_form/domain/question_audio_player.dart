import 'voice_form_models.dart';

/// The seam between the [VoiceFormCubit] and question read-aloud (TTS).
///
/// The cubit's advance ordering plays the next question BEFORE it starts the
/// answer clip, so the mic never captures the prompt. The real player — bundled
/// Sarvam TTS assets with a conditional-autoplay + replay policy — is #631; this
/// interface is all the state machine needs, so the two can land independently.
abstract interface class QuestionAudioPlayer {
  /// Read [question] aloud, completing when playback finishes (or immediately if
  /// autoplay is off / no asset — the caller then just shows the text). Must not
  /// throw for a missing asset: a silent question is degraded, never fatal.
  Future<void> play(VoiceQuestion question);

  /// Stop any in-flight playback (interruption, session close).
  Future<void> stop();
}
