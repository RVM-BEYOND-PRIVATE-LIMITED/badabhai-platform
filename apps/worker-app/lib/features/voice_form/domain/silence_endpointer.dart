/// Tunable thresholds for [SilenceEndpointer]. Every value is injectable so the
/// field-measurement data (factories, roadsides, workshops) can retune the
/// endpointer without a code change.
class EndpointerThresholds {
  const EndpointerThresholds({
    this.onDeltaDb = 9.0,
    this.offDeltaDb = 6.0,
    this.minSpeech = const Duration(milliseconds: 700),
    this.trailingSilence = const Duration(milliseconds: 1400),
    this.leadingGrace = const Duration(seconds: 6),
    this.stallTimeout = const Duration(milliseconds: 1200),
    this.floorReestimateClampDb = 10.0,
    this.floorReestimateAlpha = 0.05,
    this.maxCapOuts = 3,
  });

  /// Speech starts when the level rises this many dB ABOVE the noise floor.
  final double onDeltaDb;

  /// Silence resumes when the level falls back to within this many dB of the
  /// floor. `< onDeltaDb` gives hysteresis — a separate on/off gate so a level
  /// hovering at the boundary can't chatter the state.
  final double offDeltaDb;

  /// Cumulative time above the on-gate before an utterance counts — a cough or a
  /// door slam is shorter than this and never becomes "an answer".
  final Duration minSpeech;

  /// Silence AFTER real speech that ends the answer. Generous because
  /// Hindi/Hinglish speakers pause mid-sentence. A tunable field, not a const.
  final Duration trailingSilence;

  /// The grace window at the start where silence is expected (the worker is
  /// reading + thinking) — the UI holds its "bolein" nudge until this passes.
  final Duration leadingGrace;

  /// No samples for this long ⇒ the stream stalled (an incoming call froze the
  /// mic). The endpointer FREEZES: it drops any pending trailing-silence timer
  /// and never auto-advances across the gap.
  final Duration stallTimeout;

  /// The floor may drift only within ±this of the calibrated floor.
  final double floorReestimateClampDb;

  /// EMA weight for the one-sided (silence-only) floor re-estimation.
  final double floorReestimateAlpha;

  /// Consecutive cap-outs that switch the session to manual-only.
  final int maxCapOuts;
}

/// What [SilenceEndpointer.add] decided for this sample.
enum EndpointerSignal {
  /// Keep listening.
  none,

  /// The worker finished — auto-advance to the next question.
  endpoint,

  /// The per-answer cap was hit without a clean end — the caller stops the clip
  /// and moves on; a run of these flips the session to manual-only.
  capped,
}

/// Phase of the current answer, for the UI mic-state row.
enum EndpointerPhase { idle, listening, speaking, trailingSilence, done, manualOnly }

/// A plugin-FREE silence endpointer for the voice form (#626): it decides when a
/// spoken answer has ended, from a stream of microphone amplitudes (dBFS) plus
/// an INJECTED clock. It touches no recorder plugin (which throws under
/// `flutter test`), so it is 100% unit-testable with a synthetic sample sequence
/// and a fake clock.
///
/// Thresholds are RELATIVE to a noise floor measured in the pre-flight — an
/// absolute dBFS gate cannot work for an audience on factory floors and
/// roadsides. Feed the pre-flight sample to [calibrate], [arm] a question, then
/// push live samples through [add]; it returns [EndpointerSignal.endpoint] when
/// the answer is done. dBFS is `0` = full-scale, large-negative = quiet.
class SilenceEndpointer {
  SilenceEndpointer({
    this.thresholds = const EndpointerThresholds(),
    this.maxAnswer = const Duration(seconds: 30),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final EndpointerThresholds thresholds;

  /// The per-answer hard stop. Hitting it without a clean endpoint is a cap-out.
  final Duration maxAnswer;

  final DateTime Function() _clock;

  double _calibratedFloorDb = -50;
  double _floorDb = -50;

  int _consecutiveCapOuts = 0;
  bool _manualOnly = false;

  // --- per-question state ---
  DateTime? _armedAt;
  DateTime? _lastSampleAt;
  DateTime? _silenceSince;
  int _speechMs = 0;
  bool _enoughSpeech = false;
  EndpointerPhase _phase = EndpointerPhase.idle;

  double get noiseFloorDb => _floorDb;

  /// Once true (after [EndpointerThresholds.maxCapOuts] consecutive cap-outs)
  /// the endpointer never auto-advances again this session — the worker drives
  /// with the manual button only.
  bool get manualOnly => _manualOnly;

  EndpointerPhase get phase => _phase;

  /// True while the answer has not yet gathered real speech — the UI uses this
  /// with [EndpointerThresholds.leadingGrace] to time its "bolein" nudge.
  bool get awaitingFirstSpeech => !_enoughSpeech;

  /// Set the noise floor to the p75 of the pre-flight noise sample. p75 (not the
  /// mean) keeps a stray clank from inflating the baseline.
  void calibrate(Iterable<double> preflightDbfs) {
    final List<double> s = preflightDbfs.toList()..sort();
    if (s.isEmpty) return;
    final int idx = ((s.length - 1) * 0.75).round();
    _calibratedFloorDb = s[idx];
    _floorDb = _calibratedFloorDb;
  }

  /// Begin a new question. Resets per-question state; the calibrated floor and
  /// the cap-out streak persist across questions (a session-level concern).
  void arm() {
    final DateTime now = _clock();
    _armedAt = now;
    _lastSampleAt = now;
    _silenceSince = null;
    _speechMs = 0;
    _enoughSpeech = false;
    _floorDb = _calibratedFloorDb;
    _phase =
        _manualOnly ? EndpointerPhase.manualOnly : EndpointerPhase.listening;
  }

  /// Feed one amplitude sample ([dbfs]). Returns what to do.
  EndpointerSignal add(double dbfs) {
    if (_manualOnly ||
        _armedAt == null ||
        _phase == EndpointerPhase.done ||
        _phase == EndpointerPhase.manualOnly) {
      return EndpointerSignal.none;
    }

    final DateTime now = _clock();
    final Duration gap = now.difference(_lastSampleAt!);
    _lastSampleAt = now;

    // STALL: a gap past stallTimeout is a frozen stream (an incoming call), not
    // trailing silence. Drop the pending silence timer so the resumed stream
    // cannot be read as "the worker finished", and don't credit the gap as
    // either speech or silence.
    final bool stalled = gap > thresholds.stallTimeout;
    if (stalled) _silenceSince = null;

    // CAP: the per-answer max was reached without a clean end.
    if (now.difference(_armedAt!) >= maxAnswer) {
      _phase = EndpointerPhase.done;
      _consecutiveCapOuts += 1;
      if (_consecutiveCapOuts >= thresholds.maxCapOuts) _manualOnly = true;
      return EndpointerSignal.capped;
    }

    final double onDb = _floorDb + thresholds.onDeltaDb;
    final double offDb = _floorDb + thresholds.offDeltaDb;

    if (dbfs >= onDb) {
      // Speaking.
      if (!stalled) _speechMs += gap.inMilliseconds;
      if (_speechMs >= thresholds.minSpeech.inMilliseconds) _enoughSpeech = true;
      _silenceSince = null;
      _phase = EndpointerPhase.speaking;
      return EndpointerSignal.none;
    }

    if (dbfs <= offDb) {
      _reestimateFloor(dbfs); // one-sided: only from silence samples
      if (!_enoughSpeech) {
        // Leading silence, no real speech yet — nothing to end.
        return EndpointerSignal.none;
      }
      if (stalled) return EndpointerSignal.none; // re-arm silence after a stall
      _silenceSince ??= now;
      _phase = EndpointerPhase.trailingSilence;
      if (now.difference(_silenceSince!) >= thresholds.trailingSilence) {
        _phase = EndpointerPhase.done;
        _consecutiveCapOuts = 0; // a clean finish breaks the cap-out streak
        return EndpointerSignal.endpoint;
      }
      return EndpointerSignal.none;
    }

    // Hysteresis dead-zone (between off and on): hold whatever state we're in.
    return EndpointerSignal.none;
  }

  void _reestimateFloor(double observedQuietDb) {
    final double lo = _calibratedFloorDb - thresholds.floorReestimateClampDb;
    final double hi = _calibratedFloorDb + thresholds.floorReestimateClampDb;
    final double stepped = _floorDb +
        (observedQuietDb - _floorDb) * thresholds.floorReestimateAlpha;
    _floorDb = stepped.clamp(lo, hi);
  }
}
