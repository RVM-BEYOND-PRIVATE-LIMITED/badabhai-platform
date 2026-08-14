/// One recognition update from the on-device recogniser: the words heard so far
/// and whether this is the settled, final reading.
class DictationResult {
  const DictationResult(this.text, {required this.isFinal});

  /// Words recognised so far (partial) or the settled utterance (final).
  final String text;

  /// True once the recogniser has settled on this reading.
  final bool isFinal;
}

/// On-device speech-to-text for the chat composer's HOLD-TO-TALK.
///
/// Wraps the platform recogniser (Android `SpeechRecognizer` / iOS `Speech`).
/// There is NO server, NO upload, and NO `/voice/*` endpoint in this path — the
/// recognised words are dropped straight into the composer and then sent as an
/// ordinary chat message through the normal `/chat/message` flow. It exists as a
/// seam so the widget can be driven in tests without the platform channel (which
/// throws under `flutter test`).
abstract interface class SpeechDictation {
  /// One-time platform init + permission (mic on Android; mic + Speech on iOS).
  /// Returns false — never throws — when the device has no recogniser or the
  /// worker declined, so hold-to-talk can degrade to an honest notice.
  Future<bool> initialize();

  /// Begins listening. [onResult] fires with partial readings as the worker
  /// speaks and once more with the final one. [onSoundLevel] fires in near
  /// real-time with the mic amplitude (raw device units) — the live-waveform
  /// cue reads it directly, so it responds to the voice without waiting for
  /// recognition. [localeId] is a recogniser locale id (e.g. `hi_IN`); null uses
  /// the device default.
  Future<void> listen({
    required void Function(DictationResult result) onResult,
    void Function(double level)? onSoundLevel,
    String? localeId,
  });

  /// Stops listening and lets the final result settle.
  Future<void> stop();

  /// Aborts listening without a final result.
  Future<void> cancel();

  /// True while a listen session is active.
  bool get isListening;
}
