import 'package:equatable/equatable.dart';

/// One row on the end-of-session review screen (#632): a short FIELD LABEL (not
/// the full question) and the engine's CAPTURED, NORMALIZED value.
///
/// The label + normalized value come from the engine's `AnswerMap`
/// (`GET /profiling/session/:id`, backend B6). PII NOTE: [displayValue] is
/// worker-authored content shown for confirmation — held transiently, never
/// logged. [clipPath] is a LOCAL file path (the worker's own recording, replayed
/// on ⟲/🔊 — never a synthesized read-back), never sent or logged.
class VoiceReviewRow extends Equatable {
  const VoiceReviewRow({
    required this.questionId,
    required this.fieldLabel,
    required this.displayValue,
    this.declined = false,
    this.numeric = false,
    this.hasChoices = false,
    this.clipPath,
  });

  /// The engine's stable question id — what a correction is ADDRESSED BY.
  ///
  /// Never the list position. The engine is adaptive (answer n picks question
  /// n+1), so a refreshed `AnswerMap` can gain or lose conditional rows and
  /// shift every index. A correction sheet is open across an await; if it
  /// carried an index, a refresh underneath it would silently re-target the
  /// correction at a question the worker never chose — writing an answer they
  /// did not give. Every other model in this feature already keys on a stable
  /// id ([VoiceQuestion.id], [VoiceChoice.key]); this one now does too.
  final String questionId;

  /// Short field label, e.g. "Kaam" — never the full question.
  final String fieldLabel;

  /// The normalized captured value, e.g. "Welder" or "₹18,000".
  final String displayValue;

  /// The worker declined (engine `declined`) — the row shows "Nahi bataya".
  final bool declined;

  /// Render [displayValue] monospace (numbers, salary) so digits line up.
  final bool numeric;

  /// The question offered options — correction can start with chips (#632's
  /// chips → mic → typing order).
  final bool hasChoices;

  /// The worker's own recorded clip for a spoken answer (local path), replayed
  /// on the review row. Null for chip/boolean/text answers.
  final String? clipPath;

  @override
  List<Object?> get props => <Object?>[
        questionId,
        fieldLabel,
        displayValue,
        declined,
        numeric,
        hasChoices,
        clipPath,
      ];
}
