import 'package:equatable/equatable.dart';

/// The result of a `POST /profiling/correct` (#700): the engine's targeted
/// re-write of ONE already-settled answer, echoed back so the review screen can
/// redraw a single row without re-fetching the whole session on a 2G link.
///
/// PII NOTE: [displayValue] is the worker's corrected, normalized value — shown
/// for confirmation, held transiently, never logged.
class VoiceCorrectionOutcome extends Equatable {
  const VoiceCorrectionOutcome({
    required this.questionId,
    required this.displayValue,
    required this.declined,
    required this.correctionCount,
    required this.profileRebuildRequired,
  });

  /// The question that was corrected (its stable key) — what the review row is
  /// addressed by, never a list position.
  final String questionId;

  /// The corrected normalized value to show, e.g. "Welder" or "₹18,000". Null
  /// when the corrected answer is itself a decline / unanswered.
  final String? displayValue;

  /// The corrected answer is a decline — the row shows "Nahi bataya".
  final bool declined;

  /// Corrections this session has taken, so the screen can show the cap
  /// (`MAX_CORRECTIONS_PER_SESSION`) approaching.
  final int correctionCount;

  /// TRUE means the stored answer is now right but a profile had ALREADY been
  /// built, so it is stale and being rebuilt (#700's fourth trigger). Surfaced
  /// for the screen to signal — never silently decided.
  final bool profileRebuildRequired;

  @override
  List<Object?> get props => <Object?>[
    questionId,
    displayValue,
    declined,
    correctionCount,
    profileRebuildRequired,
  ];
}
