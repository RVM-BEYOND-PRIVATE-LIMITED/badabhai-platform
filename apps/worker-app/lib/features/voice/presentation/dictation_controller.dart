import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show HapticFeedback;

import '../../../core/di/locator.dart';
import '../../../core/error/failure.dart';
import '../domain/speech_dictation.dart';

/// Honest copy when the device recogniser could not be started (no engine, or an
/// unexpected error). Typing always stays available.
const String kVoiceToTextUnavailable =
    'Awaaz text mein nahi badal payi. Dobara boliye ya type kijiye.';

/// Drives TAP-TO-TALK: the device's own recogniser ([SpeechDictation]) feeding a
/// live waveform and, on Stop, a block of recognised text for the caller's field.
///
/// Extracted from the chat composer so a second surface (feedback, and anything
/// after it) gets the SAME dictation instead of a copy that drifts. Nothing here
/// talks to a BadaBhai server: no upload, no `/voice/*` endpoint, no AI spend —
/// the recognised words are the caller's to send as ordinary text.
///
/// WHY A ChangeNotifier AND NOT A CUBIT (this repo's usual shape): this is a
/// composer INPUT controller with the lifetime of one widget — a sibling of
/// [TextEditingController], not a screen's state machine over a repository. It
/// also carries a ~10–15 Hz amplitude stream, which is published on its own
/// [level] listenable so the waveform repaints WITHOUT rebuilding the composer;
/// a state class emitted per RMS sample would rebuild the whole screen instead.
///
/// The subtle parts — the utterance-boundary commit, the [_accepting] latch and
/// the adaptive noise floor — are documented at their fields. They are load-
/// bearing: get them wrong and dictated words are duplicated, lost, or refilled
/// into a box the worker just cleared.
class DictationController extends ChangeNotifier {
  /// [speech] is a test/reuse seam; when null the registered [SpeechDictation]
  /// is resolved from the locator at use time — and its ABSENCE is tolerated
  /// (dictation simply does nothing), never a crash.
  ///
  /// [onNotice] receives honest, PII-free failure copy for the caller to surface
  /// however that screen surfaces notices (the chat composer uses a snackbar).
  DictationController({SpeechDictation? speech, this.onNotice})
    : _injected = speech;

  final SpeechDictation? _injected;

  /// Called with worker-facing copy when the mic is denied or the recogniser
  /// cannot start. Never carries PII.
  final ValueChanged<String>? onNotice;

  /// Mic units above the ambient [_floor] that still count as quiet — the
  /// squelch that keeps a fan/room tone off the bars. (Android RMS scale.)
  static const double kWaveSquelch = 1.5;

  /// Mic units above (floor + squelch) that fill the bars — speech headroom.
  static const double kWaveSpan = 6.0;

  /// Tap-to-talk dictation is live (the device recogniser is listening). The mic
  /// is a TOGGLE — tap to start, tap Stop to end — not a hold.
  bool _dictating = false;

  /// A dictation leg (start OR stop) is in flight — reentrancy guard.
  bool _busy = false;

  /// Stop was tapped before [start] finished starting the mic — ask that
  /// in-flight start to cancel rather than leave a mic with no owner.
  bool _stopRequested = false;

  /// The live-waveform cue is showing — for the WHOLE dictation (shown when
  /// listening starts, hidden when the worker taps Stop).
  bool _listening = false;

  /// The live, normalized (0..1) mic amplitude the waveform reads. A
  /// ValueNotifier so only the waveform repaints, never the whole composer.
  final ValueNotifier<double> _level = ValueNotifier<double>(0);

  /// Adaptive NOISE FLOOR — the ambient level (a fan, room tone) the mic
  /// amplitude is measured against. It seeds to the first sample, then drops
  /// fast to a quieter floor and rises slowly, so a steady fan settles onto the
  /// baseline and only SPEECH (louder than room noise) clears it. This is what
  /// keeps the wave flat on ambient noise while staying REAL-TIME on the voice —
  /// no recognition gate, no lag. These workers are in noisy places; without it
  /// the cue is useless exactly where it is needed.
  double _floor = 0;
  bool _floorSeeded = false;

  /// Whatever was already typed when dictation began — recognised words append
  /// onto it so live dictation never clobbers text the worker started by hand.
  /// Each finished utterance is committed back into this so a later utterance
  /// appends onto it instead of overwriting the sentence just spoken.
  String _base = '';

  /// The latest partial reading of the CURRENT utterance. The recogniser only
  /// ever GROWS a partial (each reading extends the last), so a reading that does
  /// NOT extend this one means it started a NEW utterance after a pause — at which
  /// point the previous utterance is folded into [_base] before the new words
  /// append. This is what keeps a phrase spoken before a mid-listen pause (e.g.
  /// "hello" before a 5s think) when the next phrase ("I am a CNC developer")
  /// follows — WITHOUT depending on the recogniser emitting a final or restarting
  /// the session, which some devices skip.
  String _lastHeard = '';

  /// True only while dictation is live and recognised words may be accepted.
  /// Goes false the instant it tears down ([_hideWave], [stop], [discard]) so a
  /// trailing final result the recogniser delivers AFTER the worker stopped — the
  /// continuous-listen session flushing — can never re-fill a box they have just
  /// cleared or sent.
  bool _accepting = false;

  bool _disposed = false;

  /// The waveform cue should be on screen.
  bool get listening => _listening;

  /// The device recogniser is live (i.e. [stop] has something to end).
  bool get dictating => _dictating;

  /// Normalized 0..1 mic amplitude for the waveform. Repaints on its own.
  ValueListenable<double> get level => _level;

  /// The full recognised text so far — the committed base plus the current
  /// utterance — trimmed. Empty when nothing was recognised.
  String get text => _appendToBase(_base, _lastHeard).trim();

  /// The registered recogniser, or null when none is registered — dictation is
  /// then a silent no-op rather than a crash.
  SpeechDictation? get _speech =>
      _injected ??
      (locator.isRegistered<SpeechDictation>()
          ? locator<SpeechDictation>()
          : null);

  /// START voice-to-text. Requests the mic permission (via the recogniser's
  /// `initialize`), starts the DEVICE recogniser and raises the waveform. NOTHING
  /// is typed while listening — the recognised text is handed back by [stop] /
  /// [stopForSend]. Keeps listening until the worker stops it. A denied mic / no
  /// recogniser surfaces an honest notice through [onNotice] and leaves typing
  /// untouched — never a crash.
  ///
  /// [initialText] is whatever the worker had already typed; recognised words
  /// append onto it. [localeId] is a recogniser locale id (e.g. `hi_IN`); null
  /// uses the device default.
  Future<void> start({String initialText = '', String? localeId}) async {
    if (_dictating || _busy) return;
    final SpeechDictation? speech = _speech;
    if (speech == null) return;
    _busy = true;
    _stopRequested = false;
    // Instant, BEFORE any await: a buzz + the waveform the moment the tap is
    // recognised, so the worker feels the mic engage.
    HapticFeedback.vibrate();
    _floor = 0;
    _floorSeeded = false;
    _level.value = 0;
    _listening = true;
    _notify();
    try {
      // `initialize()` is where the mic PERMISSION prompt happens (speech_to_text
      // requests it); a denial or a device with no recogniser returns false.
      final bool ready = await speech.initialize();
      if (_disposed) return;
      if (!ready) {
        _hideWave();
        onNotice?.call(const MicPermissionFailure().message);
        return;
      }
      if (_stopRequested) {
        // Stopped before listening began — nothing to start.
        _hideWave();
        return;
      }
      // Preserve anything already typed; recognised words append onto it.
      _base = initialText.trimRight();
      _lastHeard = '';
      _accepting = true;
      await speech.listen(
        onResult: _onResult,
        onSoundLevel: _onSoundLevel, // live amplitude -> the waveform
        localeId: localeId,
      );
      if (_disposed) return;
      _dictating = true;
      _notify();
    } catch (_) {
      if (!_disposed) {
        _hideWave();
        onNotice?.call(kVoiceToTextUnavailable);
      }
    } finally {
      _busy = false;
    }
  }

  /// STOP tapped: end listening and RETURN the recognised text (empty when
  /// nothing was heard) for the caller to land in its field. Stopping mid-start
  /// just asks the in-flight start to cancel and returns empty.
  ///
  /// Synchronous ON PURPOSE. The caller lands the text in the same turn the
  /// waveform comes down, so the composer can never paint empty for a frame in
  /// between; the recogniser is asked to stop in the background, since nothing
  /// observable waits on it (see [_stopRecogniser]).
  String stop() {
    if (!_dictating) {
      // Stopped mid-init: tell the start leg not to begin listening.
      _hideWave();
      _stopRequested = true;
      return '';
    }
    return _finish();
  }

  /// SEND tapped while listening: same as [stop], but a stop that never began
  /// listening is a plain no-op (no waveform teardown, nothing to send).
  String stopForSend() {
    if (!_dictating) return '';
    return _finish();
  }

  /// Drop the dictation carry-over — the caller sent or cleared the field, so a
  /// late recogniser final (or the next start) must never re-fill it with the
  /// sentence just sent.
  void discard() {
    _accepting = false;
    _base = '';
    _lastHeard = '';
    _level.value = 0;
  }

  @override
  void dispose() {
    _disposed = true;
    _level.dispose();
    super.dispose();
  }

  /// Ends the live dictation: takes the text, clears the runtime state, drops the
  /// waveform and stops the recogniser.
  String _finish() {
    final String heard = text;
    discard();
    _dictating = false;
    _listening = false;
    unawaited(_stopRecogniser());
    _notify();
    return heard;
  }

  /// Best-effort stop of the device recogniser — must never surface an error.
  Future<void> _stopRecogniser() async {
    final SpeechDictation? speech = _speech;
    if (speech == null) return;
    try {
      await speech.stop();
    } catch (_) {}
  }

  /// Dictation callback: ACCUMULATES the recognised words in memory. Each
  /// finished utterance is committed into [_base] so the next one appends onto
  /// it. A new utterance is detected by [_lastHeard] no longer being extended —
  /// see that field — so a phrase said before a mid-listen pause is kept even
  /// when the device never emits a final for it.
  void _onResult(DictationResult result) {
    if (_disposed || !_accepting) return;
    final String heard = result.text.trim();
    if (heard.isEmpty) return;

    // The recogniser has started a NEW utterance when this reading no longer
    // extends the last — commit the finished one into the base BEFORE the new
    // words, or the new phrase would REPLACE the old one.
    if (_lastHeard.isNotEmpty && !_extendsUtterance(heard, _lastHeard)) {
      _base = _appendToBase(_base, _lastHeard);
      _lastHeard = '';
    }
    _lastHeard = heard;

    if (result.isFinal) {
      // Settled — fold it into the base and start the next utterance clean.
      _base = _appendToBase(_base, heard);
      _lastHeard = '';
    }
  }

  /// True when [next] continues the same utterance as [prev] — the recogniser
  /// only extends a partial, so a growing reading starts with the prior one.
  bool _extendsUtterance(String next, String prev) =>
      next.toLowerCase().startsWith(prev.toLowerCase());

  /// Joins a committed [base] with freshly [heard] words, single-spaced.
  String _appendToBase(String base, String heard) =>
      base.isEmpty ? heard : '$base $heard';

  /// The mic's live amplitude -> the waveform, in REAL TIME (no wait for
  /// recognition). Measured against the adaptive [_floor] with a small squelch,
  /// so a steady fan/room tone stays at the baseline (flat bars) while speech —
  /// which is louder than ambient — drives the bars, and the moment the worker
  /// stops the level drops and the bars settle. Tuned for the plugin's Android
  /// RMS scale (~ -2..12); other platforms may want [kWaveSquelch]/[kWaveSpan]
  /// adjusted.
  void _onSoundLevel(double raw) {
    if (!_floorSeeded) {
      // Seed ABOVE the first sample so the floor can only settle DOWNWARD onto
      // ambient — which it does fast (the 0.5 drop below). Seeding AT the first
      // (cold-mic, often low) sample and letting the floor climb UP to the real
      // ambient was the bug: the climb took 2-3s, and until it caught up every
      // sample read as signal and slammed the bars full at the start of a hold.
      _floor = raw + kWaveSpan;
      _floorSeeded = true;
    } else if (raw < _floor) {
      _floor = raw * 0.5 + _floor * 0.5; // drop fast toward a quieter ambient
    } else {
      _floor = _floor * 0.9 + raw * 0.1; // rise toward a louder ambient (a fan)
    }
    final double signal = raw - _floor - kWaveSquelch;
    _level.value = signal <= 0 ? 0.0 : (signal / kWaveSpan).clamp(0.0, 1.0);
  }

  /// Hides the waveform cue and parks the level at rest (a failed start, or a
  /// stop that arrived before listening began).
  void _hideWave() {
    // Stop accepting recognised words the moment dictation ends — a trailing
    // final the recogniser flushes afterwards must not re-fill the composer.
    _accepting = false;
    _level.value = 0;
    if (!_disposed && _listening) {
      _listening = false;
      _notify();
    }
  }

  void _notify() {
    if (_disposed) return;
    notifyListeners();
  }
}
