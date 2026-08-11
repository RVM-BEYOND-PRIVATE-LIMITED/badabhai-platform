import 'dart:async';

import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../domain/speech_dictation.dart';

/// Real [SpeechDictation] over the `speech_to_text` plugin — the device's own
/// recogniser, no network of ours involved.
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

  void Function(DictationResult result)? _onResult;
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
    String? localeId,
  }) async {
    _onResult = onResult;
    _localeId = localeId;
    _wantListening = true;
    await _startPluginListen();
  }

  @override
  Future<void> stop() async {
    _wantListening = false;
    await _speech.stop();
  }

  @override
  Future<void> cancel() async {
    _wantListening = false;
    await _speech.cancel();
  }

  @override
  bool get isListening => _speech.isListening;

  /// Restarts the plugin if the worker still wants to listen and it is not
  /// already (re)starting. Serialised by [_restarting] so a burst of status
  /// callbacks cannot stack two `listen` calls.
  void _maybeRestart() {
    if (!_wantListening || _restarting || _speech.isListening) return;
    unawaited(_startPluginListen());
  }

  Future<void> _startPluginListen() async {
    if (_restarting || _speech.isListening) return;
    _restarting = true;
    try {
      await _speech.listen(
        onResult: (SpeechRecognitionResult r) => _onResult?.call(
          DictationResult(r.recognizedWords, isFinal: r.finalResult),
        ),
        listenOptions: SpeechListenOptions(
          // Partial results fill the composer live as the worker speaks.
          partialResults: true,
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
