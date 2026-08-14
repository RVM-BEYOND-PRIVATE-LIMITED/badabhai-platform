import 'package:flutter_tts/flutter_tts.dart';

import '../domain/speech_reader.dart';

/// Real [SpeechReader] over the `flutter_tts` plugin — the device's own TTS
/// engine, no network of ours involved.
///
/// [FlutterTts] is a test seam ([speak] touches a platform channel that throws
/// under `flutter test`, so the widget injects a fake instead). Everything is
/// fail-closed: configuration and playback swallow errors so a device with no
/// Hindi voice (or no TTS at all) simply stays silent — the question text is
/// already on screen.
class RealSpeechReader implements SpeechReader {
  RealSpeechReader([FlutterTts? tts]) : _tts = tts ?? FlutterTts();

  final FlutterTts _tts;
  bool _configured = false;

  Future<void> _ensureConfigured() async {
    if (_configured) return;
    try {
      // speak() resolves only when playback FINISHES, so the caller can clear
      // the "speaking" icon state on completion.
      await _tts.awaitSpeakCompletion(true);
      // Hindi-first: bada bhai's questions are Hindi/Hinglish. If hi-IN is not
      // installed the platform falls back to its default voice.
      await _tts.setLanguage('hi-IN');
      // A calmer pace than the default, for low-literacy workers.
      await _tts.setSpeechRate(0.45);
    } catch (_) {
      // Best-effort — a missing voice must never crash read-aloud.
    }
    _configured = true;
  }

  @override
  Future<void> speak(String text) async {
    final String t = text.trim();
    if (t.isEmpty) return;
    try {
      await _ensureConfigured();
      await _tts.stop(); // never overlap two questions
      await _tts.speak(t);
    } catch (_) {
      // TTS unavailable — silent, never fatal.
    }
  }

  @override
  Future<void> stop() async {
    try {
      await _tts.stop();
    } catch (_) {
      // Best-effort.
    }
  }
}
