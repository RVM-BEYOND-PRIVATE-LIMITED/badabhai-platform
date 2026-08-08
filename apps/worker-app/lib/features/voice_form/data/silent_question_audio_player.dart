import '../domain/question_audio_player.dart';
import '../domain/voice_form_models.dart';

/// The safe, ship-now default [QuestionAudioPlayer]: it plays NOTHING and
/// returns immediately, so the session degrades to **text-only** and continues.
///
/// This is deliberate, not a stub-to-replace-hastily. Real read-aloud (#631) is
/// gated on two things outside the client: the rendered TTS asset corpus
/// (ai-service A3, blocked on the Sarvam romanized-Hinglish smoke test) and an
/// on-device audio-focus prototype on real low-end Android (the `record` +
/// player focus interaction "cannot be trusted from an emulator"). Until both
/// land, shipping silence — with the question always visible as text and the
/// speaker button simply a no-op — is the correct, honest behavior: TTS is an
/// enhancement, never a gate on answering.
class SilentQuestionAudioPlayer implements QuestionAudioPlayer {
  const SilentQuestionAudioPlayer();

  @override
  Future<void> play(VoiceQuestion question) async {
    // Intentionally silent — the caller shows the question text.
  }

  @override
  Future<void> stop() async {
    // Nothing is playing.
  }
}
