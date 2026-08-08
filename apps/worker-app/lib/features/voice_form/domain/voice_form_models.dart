import 'package:equatable/equatable.dart';

import '../../voice/domain/voice_models.dart';

/// One question in the voice-profiling form. A [choices]-bearing question can be
/// answered EITHER by speaking or by tapping a chip (#630); an empty [choices]
/// is an open spoken answer.
///
/// PII NOTE: a question is engine-authored prompt copy — never worker PII.
class VoiceQuestion extends Equatable {
  const VoiceQuestion({
    required this.id,
    required this.prompt,
    this.ttsAssetKey,
    this.choices = const <String>[],
  });

  /// Stable engine id for the question (used to key TTS assets + answer routing).
  final String id;

  /// Hinglish prompt shown on screen and read aloud.
  final String prompt;

  /// Bundled TTS asset key for [prompt], when one exists (#631). Null ⇒ the
  /// player falls back (or the question is read by on-device TTS).
  final String? ttsAssetKey;

  /// Chip options for a choice question (#630). Empty ⇒ open spoken answer.
  final List<String> choices;

  bool get isChoice => choices.isNotEmpty;

  @override
  List<Object?> get props => <Object?>[id, prompt, ttsAssetKey, choices];
}

/// The worker's answer to one question: EITHER a recorded [clip] (spoken) or a
/// [choice] label (chip tap). Exactly one is non-null.
class VoiceAnswer extends Equatable {
  const VoiceAnswer.spoken(RecordedClip this.clip) : choice = null;
  const VoiceAnswer.chosen(String this.choice) : clip = null;

  final RecordedClip? clip;
  final String? choice;

  bool get isSpoken => clip != null;

  @override
  List<Object?> get props => <Object?>[clip, choice];
}

/// Result of starting the session or submitting an answer: the engine either
/// serves the [NextQuestion] or declares the session [VoiceFormDone].
///
/// Answers are submitted BLOCKING, one at a time: the engine needs answer n's
/// text to choose question n+1 (`next-question.ts`, `isSettled` is the first
/// servability test), so there is no optimistic advance in v1.
sealed class VoiceFormStep extends Equatable {
  const VoiceFormStep();

  @override
  List<Object?> get props => <Object?>[];
}

/// The engine's next question, with its 1-based [index] of [total].
class NextQuestion extends VoiceFormStep {
  const NextQuestion(this.question, {required this.index, required this.total});

  final VoiceQuestion question;
  final int index;
  final int total;

  @override
  List<Object?> get props => <Object?>[question, index, total];
}

/// The engine has no more questions — move to review + submit.
class VoiceFormDone extends VoiceFormStep {
  const VoiceFormDone();
}

/// Where the mic is in the answer cycle for the current question. Nested inside
/// the `Asking` state so the UI can show priming vs listening vs manual-hold vs
/// the between-questions upload without a separate top-level state per phase.
enum MicPhase {
  /// Recorder started; the ~250ms codec/mic prime before the endpointer is
  /// armed, so the first syllable is captured but not mis-detected.
  priming,

  /// Armed and listening — auto-advance is live (unless the endpointer went
  /// manual-only).
  listening,

  /// Manual-only: the endpointer capped out (or a very-loud room disabled it),
  /// so the worker taps to advance.
  holding,

  /// The just-captured clip is uploading while the engine picks the next
  /// question (the blocking submit). The mic is idle between clips.
  uploading,
}
