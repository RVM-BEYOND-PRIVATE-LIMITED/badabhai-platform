import 'package:equatable/equatable.dart';

import '../../../core/api/api_models.dart'
    show
        ChatInputMode,
        ChatOption,
        ChatProgress,
        ChatQuestionKind,
        PredictedQuestion;

/// One assistant turn from the profiling chat: bada bhai's [reply] plus any
/// [followups].
///
/// [followups] are the backend's `suggested_followups` — short tap-to-answer
/// chips so a low-literacy worker can answer without typing. Empty when the
/// backend sent none (including when the reply was blocked / a safe fallback).
class ChatTurn extends Equatable {
  const ChatTurn({
    required this.reply,
    this.followups = const <String>[],
    this.suggestedOptions = const <ChatOption>[],
    this.extractionReady = false,
    this.unansweredEssentials = const <String>[],
    this.blocked = false,
    this.isMock = false,
    this.progress,
    this.questionKind = ChatQuestionKind.ask,
    this.inputMode = ChatInputMode.text,
    this.occupationLabel,
    this.askedQuestionId,
    this.ttsText,
    this.lookahead = const <String, PredictedQuestion?>{},
  });

  final String reply;
  final List<String> followups;

  /// The backend's `suggested_options` for THIS turn (#761), served ALONGSIDE
  /// [followups]. Each carries the stable `option_key` the [lookahead] map is
  /// keyed by, so a tapped chip indexes its prediction even when the display
  /// label differs from that key (the LLM chat). Empty on a deterministic/older
  /// turn — the UI then falls back to the label-keyed [followups] path.
  final List<ChatOption> suggestedOptions;

  /// The Resume Field Set id THIS turn asked about (`asked_question_id`), or null
  /// on the wrap-up turn. NOT carried before #761 — added to reconcile the
  /// optimistic lookahead render: the client compares it against the predicted
  /// question_key to decide whether the prediction was right. It is NEVER echoed
  /// back (the POST body stays `{session_id, text}`).
  final String? askedQuestionId;

  /// ADVISORY next-turn predictions keyed by the tapped option (+ `'__declined'`,
  /// #761). Empty when the server sent none. Never an answer of record — the
  /// client renders it optimistically on the tap and this real turn is
  /// authoritative.
  final Map<String, PredictedQuestion?> lookahead;

  /// How far through the pinned pack the worker is (OIE Phase 8 / #649), or null
  /// when no pack has resolved yet. Drives the progress bar.
  final ChatProgress? progress;

  /// The kind of turn — only [ChatQuestionKind.disambiguate] changes the UI, to
  /// a vertical single-select (#649).
  final ChatQuestionKind questionKind;

  /// Whether the composer is offered this turn (#770). [ChatInputMode.optionsOnly]
  /// hides it and leaves [followups] as the only answer path.
  final ChatInputMode inputMode;

  /// The worker's trade in their own vernacular once retrieval pins it (#649),
  /// or null before it pins. The interview's trust moment.
  final String? occupationLabel;

  /// The Devanagari rendering of [reply] for read-aloud (`tts_text`, #896),
  /// carried from `ChatReply.ttsText`. Null on an older API build — read-aloud
  /// then speaks the romanized [reply]. Never displayed; the on-screen bubble
  /// always shows [reply].
  final String? ttsText;

  /// The interview engine's own completeness decision, carried from the
  /// backend's `extraction_ready` (#421). False until the engine says it has
  /// enough to build a profile — and false when the field is missing (see
  /// `ChatReply.extractionReady` for why that default is the safe one).
  final bool extractionReady;

  /// ESSENTIAL topics the worker has not answered yet (`unanswered_essentials`,
  /// #478) — topic ids only, never PII. Drives the named "what's still missing"
  /// helper. MEANINGFUL ONLY WHEN [blocked] IS FALSE: a blocked turn degrades
  /// this to `[]` = "unknown", not "complete".
  final List<String> unansweredEssentials;

  /// True when the turn was refused / pseudonymization failed closed
  /// (`blocked`). The [reply] is then a safe fallback and carries no interview
  /// state — the worker's answer was NOT processed, so the UI cues them to say
  /// it again rather than pretending it landed.
  final bool blocked;

  /// True when the reply came from the local/AI-down mock fallback (`is_mock`).
  /// Surfaced only as a demo cue in non-release builds (mock is the default in
  /// every committed env today, so a release badge would be noise on every turn).
  final bool isMock;

  @override
  List<Object?> get props => <Object?>[
        reply,
        followups,
        suggestedOptions,
        extractionReady,
        unansweredEssentials,
        blocked,
        isMock,
        progress,
        questionKind,
        inputMode,
        occupationLabel,
        askedQuestionId,
        ttsText,
        lookahead,
      ];
}
