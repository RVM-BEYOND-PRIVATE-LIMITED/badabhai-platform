import 'package:flutter/foundation.dart' show VoidCallback;
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// Device speech-to-text for the job Description voice toggle (#2720).
///
/// The recognised words are the ONLY thing sent anywhere (the draft endpoint);
/// this interface never uploads audio. It is a seam so widget tests can inject a
/// fake — the real plugin touches a platform channel that throws under
/// `flutter test`.
abstract interface class SpeechDictation {
  /// Ask for the microphone and start the recogniser. False when there is no
  /// device recogniser or permission was denied — the caller keeps typing.
  Future<bool> initialize();

  /// Start a dictation session. [onResult] receives the recogniser's cumulative
  /// words for the current utterance (`isFinal` when it settles); [onDone] fires
  /// when the platform ends the session on its own (silence timeout).
  Future<void> listen({
    required void Function(String words, bool isFinal) onResult,
    required VoidCallback onDone,
    String localeId,
  });

  Future<void> stop();
  Future<void> cancel();
  bool get isListening;
}

/// Real [SpeechDictation] over the platform's own recogniser
/// (Android SpeechRecognizer / iOS Speech).
///
/// Hinglish is spoken, so the default locale is `hi_IN` — the recogniser returns
/// romanised Hinglish words, which the server-side draft turns into English.
class SpeechToTextDictation implements SpeechDictation {
  SpeechToTextDictation([SpeechToText? speech]) : _speech = speech ?? SpeechToText();

  final SpeechToText _speech;
  bool _ready = false;
  VoidCallback? _onDone;
  bool _doneSent = false;

  @override
  bool get isListening => _speech.isListening;

  @override
  Future<bool> initialize() async {
    if (_ready) return true;
    // Fail closed: a denied mic / missing recogniser returns false rather than
    // throwing into the form.
    _ready = await _speech.initialize(
      onError: (_) => _notifyDone(),
      onStatus: (String status) {
        if (status == 'done' || status == 'notListening') _notifyDone();
      },
    );
    return _ready;
  }

  @override
  Future<void> listen({
    required void Function(String words, bool isFinal) onResult,
    required VoidCallback onDone,
    String localeId = 'hi_IN',
  }) async {
    _onDone = onDone;
    _doneSent = false;
    await _speech.listen(
      onResult: (SpeechRecognitionResult result) =>
          onResult(result.recognizedWords, result.finalResult),
      listenOptions: SpeechListenOptions(
        // Sentences, not short commands: a spoken job note is several clauses.
        listenMode: ListenMode.dictation,
        partialResults: true,
        // Let the device use its best recogniser; a forced-offline engine
        // transcribes almost nothing on low-end handsets.
        onDevice: false,
        listenFor: const Duration(minutes: 1),
        pauseFor: const Duration(seconds: 3),
        localeId: localeId,
      ),
    );
  }

  @override
  Future<void> stop() async {
    _doneSent = true;
    await _speech.stop();
  }

  @override
  Future<void> cancel() async {
    _doneSent = true;
    await _speech.cancel();
  }

  void _notifyDone() {
    if (_doneSent) return;
    _doneSent = true;
    _onDone?.call();
  }
}
