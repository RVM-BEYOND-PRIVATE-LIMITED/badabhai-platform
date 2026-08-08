/// Verdict of the quiet-place pre-flight (#627): how usable the ambient sound is
/// for a spoken-answer session, decided from a 5-second noise-floor measurement.
///
/// The tiers are cut on HEADROOM — how far the calibrated floor sits below
/// full-scale (0 dBFS) — never on an absolute SPL. A factory and a quiet room
/// have wildly different baselines, so a floor of -40 dBFS is "quiet" only
/// relative to itself; what matters is whether speech can still rise clear of
/// the din. Below [PreflightThresholds.autoAdvanceMinHeadroomDb] of headroom it
/// cannot, and auto-advance is switched off.
enum PreflightVerdict {
  /// Plenty of headroom — auto-advance is reliable.
  quiet,

  /// Some background noise; auto-advance still works, a quieter spot is better.
  loud,

  /// Headroom below the auto-advance floor — speech can no longer be told apart
  /// from the noise, so auto-advance is OFF and the worker taps to advance.
  veryLoud,

  /// The mic delivered effectively no signal (permission granted, but a muted /
  /// broken / virtual device). Distinct from [quiet]: silence this total is a
  /// dead mic, not a calm room, so auto-advance is off and the copy points at
  /// the mic — the worker can still answer by tapping a choice.
  micDead,
}

/// Injectable knobs for the pre-flight measurement and the verdict cut-points.
/// Defaults are production values; tests shrink the window and move the
/// cut-points to exercise each tier deterministically.
class PreflightThresholds {
  const PreflightThresholds({
    this.calibrateWindow = const Duration(seconds: 5),
    this.warmupDrop = const Duration(milliseconds: 500),
    this.sampleInterval = const Duration(milliseconds: 100),
    this.autoAdvanceMinHeadroomDb = 8.0,
    this.quietHeadroomDb = 20.0,
    this.micDeadFloorDb = -100.0,
  });

  /// Total listen window. The FIRST [warmupDrop] of samples is discarded so the
  /// mic's power-on / AGC settling transient never poisons the floor.
  final Duration calibrateWindow;
  final Duration warmupDrop;

  /// Cadence of amplitude reads from the recorder's `levels()` stream.
  final Duration sampleInterval;

  /// The ONE load-bearing number here (#627 acceptance): below this many dB of
  /// headroom (full-scale minus the measured floor), auto-advance is disabled.
  final double autoAdvanceMinHeadroomDb;

  /// At/above this headroom the room is [PreflightVerdict.quiet]; between this
  /// and [autoAdvanceMinHeadroomDb] it is [PreflightVerdict.loud].
  final double quietHeadroomDb;

  /// A floor at/below this dBFS is a DEAD mic (digital silence), not a quiet
  /// room — a real room never reads this low.
  final double micDeadFloorDb;

  /// Number of `levels()` samples that span the whole [calibrateWindow].
  int get totalSamples =>
      calibrateWindow.inMilliseconds ~/ sampleInterval.inMilliseconds;

  /// Leading samples to discard as warm-up.
  int get warmupSamples =>
      warmupDrop.inMilliseconds ~/ sampleInterval.inMilliseconds;
}

/// Pure verdict function: maps a measured noise [floorDb] (dBFS, negative) to a
/// [PreflightVerdict] under [t]. Kept free of streams and IO so it is trivially
/// unit-testable.
PreflightVerdict verdictFor(double floorDb, PreflightThresholds t) {
  if (floorDb <= t.micDeadFloorDb) return PreflightVerdict.micDead;
  final double headroom = -floorDb; // distance below full-scale
  if (headroom < t.autoAdvanceMinHeadroomDb) return PreflightVerdict.veryLoud;
  if (headroom < t.quietHeadroomDb) return PreflightVerdict.loud;
  return PreflightVerdict.quiet;
}

/// Whether auto-advance (silence-endpointing) is trustworthy for [verdict]. Only
/// [PreflightVerdict.quiet] and [PreflightVerdict.loud] keep it on.
bool autoAdvanceFor(PreflightVerdict verdict) =>
    verdict == PreflightVerdict.quiet || verdict == PreflightVerdict.loud;
