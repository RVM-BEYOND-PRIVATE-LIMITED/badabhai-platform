import 'dart:async';

import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../domain/speech_dictation.dart';

/// Real [SpeechDictation] over the `speech_to_text` plugin — the platform's OWN
/// speech recogniser (Android SpeechRecognizer / iOS Speech). No BadaBhai server
/// and no `/voice/*` endpoint are involved.
///
/// PRIVACY — WHERE THE AUDIO GOES: [listen] uses the device's BEST recogniser
/// (`onDevice: false`) because forcing the offline engine transcribed almost
/// nothing on handsets without a good local model. On most Android devices that
/// recogniser routes audio to GOOGLE's cloud speech service — i.e. voice can be
/// shared with Google as a third party. That MUST stay disclosed to the worker +
/// declared on the Play Data Safety form; it is NOT "no network involved". Keeping
/// audio strictly on-device again needs a real BUNDLED model, not the `onDevice`
/// flag (which silently degrades to unusable).
///
/// CONTINUOUS-WHILE-HELD. The platform recogniser stops itself on its own
/// silence/idle timeout (Android fires `ERROR_SPEECH_TIMEOUT` after a few
/// seconds of quiet, no matter how large `pauseFor` is). A worker who holds the
/// button, thinks, then speaks would otherwise get nothing. So [listen] sets a
/// "want listening" flag and RESTARTS the plugin every time it reports it
/// stopped — until [stop]/[cancel] clears the flag. Each restart is a fresh
/// recognition session, so the WIDGET commits every final result before the next
/// one begins (see `_onDictationResult`).
///
/// [SpeechToText] is a test seam ([initialize] touches a platform channel that
/// throws under `flutter test`, so the widget injects a fake instead). Everything
/// here is fail-closed: [initialize] returns false rather than throwing when the
/// device has no recogniser or the worker denies permission.
class RealSpeechDictation implements SpeechDictation {
  RealSpeechDictation([SpeechToText? speech])
    : _speech = speech ?? SpeechToText();

  final SpeechToText _speech;
  bool _ready = false;

  /// True between [listen] and [stop]/[cancel]: keep the recogniser alive across
  /// the platform's own idle timeouts.
  bool _wantListening = false;

  /// Guards against overlapping restart attempts.
  bool _restarting = false;

  /// The latest words the CURRENT recognition session has reported but NOT yet
  /// settled as a final. Android ends a session on its own silence timeout with
  /// only a PARTIAL in hand (no final), so without this the words spoken before
  /// a mid-hold pause — e.g. "hello" before five seconds of thinking — would be
  /// dropped when the session restarts. Flushed as a synthetic final on the
  /// session boundary (see [_maybeRestart]); cleared once a real final settles.
  String _pendingWords = '';

  void Function(DictationResult result)? _onResult;
  void Function(double level)? _onSoundLevel;
  String? _localeId;

  /// Far longer than any single hold — the restart loop, not this, is what keeps
  /// a long session alive; these just stop the plugin capping us early.
  static const Duration _session = Duration(minutes: 5);

  @override
  Future<bool> initialize() async {
    if (_ready) return true;
    _ready = await _speech.initialize(
      // A permanent error (e.g. speech timeout) ends the plugin session; restart
      // it while the worker still holds the button.
      onError: (_) => _maybeRestart(),
      onStatus: (String status) {
        if (status == 'done' || status == 'notListening') _maybeRestart();
      },
    );
    return _ready;
  }

  @override
  Future<void> listen({
    required void Function(DictationResult result) onResult,
    void Function(double level)? onSoundLevel,
    String? localeId,
  }) async {
    _onResult = onResult;
    _onSoundLevel = onSoundLevel;
    _localeId = localeId;
    _wantListening = true;
    _pendingWords = '';
    await _startPluginListen();
  }

  @override
  Future<void> stop() async {
    _wantListening = false;
    _pendingWords = '';
    await _speech.stop();
  }

  @override
  Future<void> cancel() async {
    _wantListening = false;
    _pendingWords = '';
    await _speech.cancel();
  }

  @override
  bool get isListening => _speech.isListening;

  /// Restarts the plugin if the worker still wants to listen and it is not
  /// already (re)starting. Serialised by [_restarting] so a burst of status
  /// callbacks cannot stack two `listen` calls.
  void _maybeRestart() {
    if (!_wantListening || _restarting || _speech.isListening) return;
    // The session ended mid-hold (silence timeout / done) with words that never
    // settled as a final — Android drops them otherwise. Settle them now so the
    // widget commits them before the fresh session appends the next utterance.
    if (_pendingWords.isNotEmpty) {
      final String flushed = _pendingWords;
      _pendingWords = '';
      _onResult?.call(DictationResult(flushed, isFinal: true));
    }
    unawaited(_startPluginListen());
  }

  Future<void> _startPluginListen() async {
    if (_restarting || _speech.isListening) return;
    _restarting = true;
    try {
      await _speech.listen(
        onResult: (SpeechRecognitionResult r) {
          // Track the newest words this session has reported so a silence
          // timeout can't drop them: a non-empty final commits them (clear the
          // pending buffer), any partial just updates it, so [_maybeRestart] can
          // flush the buffer if the session dies before a final arrives.
          if (r.finalResult && r.recognizedWords.isNotEmpty) {
            _pendingWords = '';
          } else if (r.recognizedWords.isNotEmpty) {
            _pendingWords = r.recognizedWords;
          }
          _onResult?.call(
            DictationResult(r.recognizedWords, isFinal: r.finalResult),
          );
        },
        onSoundLevelChange: (double level) => _onSoundLevel?.call(level),
        listenOptions: SpeechListenOptions(
          // DICTATION, not the default confirmation. `ListenMode.confirmation`
          // is a SHORT-COMMAND mode: the engine endpoints hard after the first
          // phrase, so a worker speaking three sentences was finalised down to a
          // single word ("me"). Dictation mode tunes the recogniser for
          // sentences/paragraphs (relaxed endpointing) — the actual fix for the
          // "only hears one word" report. MUST stay dictation; do not drop it.
          listenMode: ListenMode.dictation,
          // Partial results fill the composer live as the worker speaks.
          partialResults: true,
          // RECOGNITION RELIABILITY over forced-offline. `onDevice: true` sets the
          // platform's PREFER_OFFLINE flag, which does NOT gracefully fall back: on
          // the many handsets/locales without a good on-device model it uses a
          // weak/absent offline engine and transcribes almost nothing — the "not
          // listening" report. `false` lets the device use its best recogniser
          // (cloud where needed), which is what actually works for a low-end,
          // multi-locale audience.
          //
          // PRIVACY: audio may then reach the platform speech service (Google on
          // most Android) as a third party — this MUST stay disclosed to the worker
          // and declared on the Play Data Safety form. A dictation feature that does
          // not transcribe helps nobody; truly on-device needs a real bundled model,
          // not a flag that silently degrades to unusable.
          onDevice: false,
          listenFor: _session,
          pauseFor: _session,
          localeId: _localeId,
        ),
      );
    } catch (_) {
      // A failed (re)start is swallowed — the worker sees the honest notice from
      // the widget's initialize() path, never a crash.
    } finally {
      _restarting = false;
    }
  }
}
