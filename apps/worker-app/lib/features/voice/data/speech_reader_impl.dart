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
///
/// Voice: bada bhai is a MALE persona. Language is `hi-IN` (Indian
/// pronunciation) and read-aloud selects a MALE hi-IN voice — Google TTS's
/// `hi-in-x-hie` (confirmed by listening; `hi-in-x-hid` is the other male one).
/// Where no known male hi-IN voice exists (a non-Google engine), the pitch is
/// dropped so the default reads masculine rather than the female hi-IN default.
class RealSpeechReader implements SpeechReader {
  RealSpeechReader([FlutterTts? tts]) : _tts = tts ?? FlutterTts();

  final FlutterTts _tts;
  bool _configured = false;

  /// Google TTS's MALE hi-IN voices, best first. `hie` is the one confirmed on
  /// device; `hid` is the other male. Local before network so it works offline.
  static const List<String> _maleHindiVoices = <String>[
    'hi-in-x-hie-local',
    'hi-in-x-hie-network',
    'hi-in-x-hid-local',
    'hi-in-x-hid-network',
  ];

  Future<void> _ensureConfigured() async {
    if (_configured) return;
    try {
      // speak() resolves only when playback FINISHES, so the caller can clear
      // the "speaking" icon state on completion.
      await _tts.awaitSpeakCompletion(true);
      // A calmer pace than the default, for low-literacy workers.
      await _tts.setSpeechRate(0.45);

      // MALE voice (bada bhai). Pick the male hi-IN voice and set it as the LAST
      // config call. CRITICAL: do NOT call setLanguage('hi-IN') first — on this
      // engine that reselects the FEMALE hi-IN default (hia) and the later
      // setVoice did not override it, which is why read-aloud stayed female. The
      // male voice already carries its hi-IN locale, so pronunciation is Indian
      // without a separate setLanguage.
      final String? maleVoice = await _findMaleHindiVoiceName();
      if (maleVoice != null) {
        await _tts.setVoice(<String, String>{
          'name': maleVoice,
          'locale': 'hi-IN',
        });
      } else {
        // No male hi-IN voice on this device — read hi-IN with a deeper pitch.
        await _tts.setLanguage('hi-IN');
        await _tts.setPitch(0.85);
      }
    } catch (_) {
      // Best-effort — a missing voice must never crash read-aloud.
    }
    _configured = true;
  }

  /// The name of an available MALE hi-IN voice, or null if none. Prefers the
  /// known Google male voices, then any voice the engine explicitly tags male.
  Future<String?> _findMaleHindiVoiceName() async {
    try {
      final Object? raw = await _tts.getVoices;
      if (raw is! List) return null;

      final Set<String> available = <String>{};
      for (final Object? v in raw) {
        if (v is Map && v['name'] != null) {
          available.add(v['name'].toString());
        }
      }
      // 1) A known Google male hi-IN voice, best first (hie confirmed male).
      for (final String name in _maleHindiVoices) {
        if (available.contains(name)) return name;
      }
      // 2) Any hi voice the engine explicitly reports as male.
      for (final Object? v in raw) {
        if (v is! Map) continue;
        final String name = (v['name'] ?? '').toString();
        final String locale = (v['locale'] ?? '').toString();
        final String gender = (v['gender'] ?? '').toString().toLowerCase();
        if (locale.toLowerCase().startsWith('hi') &&
            (gender == 'male' || name.toLowerCase().contains('male'))) {
          return name;
        }
      }
    } catch (_) {
      // Ignore — the pitch fallback in _ensureConfigured handles it.
    }
    return null;
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
