import 'package:equatable/equatable.dart';

/// The shape of a question, which decides how it is answered (#630). 85% of the
/// 466-item pack is a choice question, and the capture layer has no fuzzy
/// speech→option_key path, so a choice question MUST be answerable by chip.
enum VoiceQuestionKind {
  /// A free-spoken answer (no chips).
  open,

  /// Pick exactly one option (chips from [VoiceQuestion.options]).
  singleSelect,

  /// Pick any number of options (chips accumulate, then submit).
  multiSelect,

  /// Yes/no. The 236 boolean pack items carry ZERO options, so the CLIENT
  /// renders the Haan / Nahi chips.
  boolean,
}

/// One selectable option: the engine's [key] (what is submitted, never the
/// label) and the [label] shown on the chip.
class VoiceChoice extends Equatable {
  const VoiceChoice({required this.key, required this.label});

  final String key;
  final String label;

  @override
  List<Object?> get props => <Object?>[key, label];
}

/// One question in the voice-profiling form.
///
/// PII NOTE: a question is engine-authored prompt copy — never worker PII.
class VoiceQuestion extends Equatable {
  const VoiceQuestion({
    required this.id,
    required this.prompt,
    this.kind = VoiceQuestionKind.open,
    this.options = const <VoiceChoice>[],
    this.whyText,
    this.ttsAssetKey,
  });

  /// Stable engine id for the question (used to key TTS assets + answer routing).
  final String id;

  /// Hinglish prompt shown on screen and read aloud.
  final String prompt;

  /// How this question is answered (#630).
  final VoiceQuestionKind kind;

  /// Options for a single/multi-select question. Empty for [open] and [boolean]
  /// (boolean's Haan/Nahi are client-rendered).
  final List<VoiceChoice> options;

  /// "Why are we asking this?" copy (#629, `whyText` from `TurnResult`, backend
  /// B10). Null until the engine supplies it; the ⓘ affordance hides when null.
  final String? whyText;

  /// Bundled TTS asset key for [prompt], when one exists (#631). Null ⇒ the
  /// player degrades to text.
  final String? ttsAssetKey;

  bool get isChoice => kind != VoiceQuestionKind.open;
  bool get isBoolean => kind == VoiceQuestionKind.boolean;
  bool get isMultiSelect => kind == VoiceQuestionKind.multiSelect;

  @override
  List<Object?> get props =>
      <Object?>[id, prompt, kind, options, whyText, ttsAssetKey];
}

/// How an answer was produced — decides the wire shape the gateway sends and
/// whether STT runs (a chip/boolean/text answer makes NO STT call).
enum VoiceAnswerKind { spoken, chips, boolean, text }

/// The worker's answer to one question. Exactly one payload field is set,
/// selected by [kind]:
///  - [spoken] — a registered [voiceNoteId] (the only kind that triggers STT),
///  - [chips]  — [optionKeys] (single or multi select; NEVER label text),
///  - [boolean]— [boolValue] (a Haan/Nahi tap),
///  - [text]   — literal [text] (e.g. "Nahi pata", which the engine maps to
///    `declined` — there is no client-side skip concept).
///
/// A SPOKEN ANSWER CARRIES AN ID, NOT A CLIP (#717, owner ruling 2026-08-08). The upload is
/// the CUBIT's job: it registers the clip through [VoiceNoteRegistrar] and hands the
/// resulting id here, so `VoiceFormGateway` stays a pure wire adapter — one HTTP call per
/// method, the same shape as every other member of that interface. Carrying a `RecordedClip`
/// instead would have forced the gateway to grow an uploader and a second round trip inside
/// `submit`, and it is the id, not the bytes, that the engine's `{kind:'spoken',
/// voice_note_id}` body has ever wanted. It also means the raw audio has already left the
/// device (and been deleted) before an answer object exists.
class VoiceAnswer extends Equatable {
  const VoiceAnswer.spoken(String this.voiceNoteId)
      : kind = VoiceAnswerKind.spoken,
        optionKeys = const <String>[],
        boolValue = null,
        text = null;

  const VoiceAnswer.chips(this.optionKeys)
      : kind = VoiceAnswerKind.chips,
        voiceNoteId = null,
        boolValue = null,
        text = null;

  const VoiceAnswer.boolean(bool this.boolValue)
      : kind = VoiceAnswerKind.boolean,
        voiceNoteId = null,
        optionKeys = const <String>[],
        text = null;

  const VoiceAnswer.text(String this.text)
      : kind = VoiceAnswerKind.text,
        voiceNoteId = null,
        optionKeys = const <String>[],
        boolValue = null;

  final VoiceAnswerKind kind;

  /// The registered voice note this answer is, for a [spoken] answer. An opaque server id —
  /// never a device path, and never the transcript.
  final String? voiceNoteId;
  final List<String> optionKeys;
  final bool? boolValue;
  final String? text;

  bool get isSpoken => kind == VoiceAnswerKind.spoken;

  @override
  List<Object?> get props =>
      <Object?>[kind, voiceNoteId, optionKeys, boolValue, text];
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

/// NOTHING WAS WRITTEN AND THE WORKER MAY SEND THAT AGAIN — the engine's third outcome
/// (#717), which until now had nowhere to land.
///
/// `ProfilingStepSchema` carries this variant precisely so a lost CAS or a failed
/// transcription is NOT an error: its own doc says a 5xx there "would make an offline queue
/// treat a recoverable turn as a dead letter". With only [NextQuestion] and [VoiceFormDone]
/// to return, the gateway had no choice but to throw — and a thrown `Failure` becomes
/// `VoiceFormError`, whose single action on the screen is `onExit`. The server said "say
/// that again" and the client ended the interview.
///
/// [reply] is the ENGINE'S OWN LINE, not client copy: it is on-persona, already inside the
/// reply closure, and therefore has rendered audio — which matters on the surface where the
/// worker cannot read the text fallback.
class RetryCurrentQuestion extends VoiceFormStep {
  const RetryCurrentQuestion(this.reply);

  /// What to say before re-arming. Never empty — the gateway substitutes the honest
  /// fallback line when the server sends no reply.
  final String reply;

  @override
  List<Object?> get props => <Object?>[reply];
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
