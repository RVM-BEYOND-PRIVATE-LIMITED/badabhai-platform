/// Reads a chat question aloud on the DEVICE (text-to-speech).
///
/// The chat surface uses this to voice bada bhai's questions when the worker
/// taps the speaker icon — no server, no audio assets, the platform's own TTS
/// engine (Android `TextToSpeech` / iOS `AVSpeechSynthesizer`). A seam so the
/// widget can be driven in tests without the platform channel (which throws
/// under `flutter test`).
abstract interface class SpeechReader {
  /// Speaks [text] aloud, completing when playback finishes (or immediately if
  /// TTS is unavailable / the text is empty). NEVER throws — a missing voice
  /// degrades to silence, the text is on screen anyway.
  Future<void> speak(String text);

  /// Stops any in-flight playback.
  Future<void> stop();
}
