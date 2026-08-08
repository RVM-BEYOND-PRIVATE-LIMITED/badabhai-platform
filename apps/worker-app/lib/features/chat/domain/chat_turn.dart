import 'package:equatable/equatable.dart';

import '../../../core/api/api_models.dart' show ChatProgress, ChatQuestionKind;

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
    this.extractionReady = false,
    this.unansweredEssentials = const <String>[],
    this.blocked = false,
    this.isMock = false,
    this.progress,
    this.questionKind = ChatQuestionKind.ask,
    this.occupationLabel,
  });

  final String reply;
  final List<String> followups;

  /// How far through the pinned pack the worker is (OIE Phase 8 / #649), or null
  /// when no pack has resolved yet. Drives the progress bar.
  final ChatProgress? progress;

  /// The kind of turn — only [ChatQuestionKind.disambiguate] changes the UI, to
  /// a vertical single-select (#649).
  final ChatQuestionKind questionKind;

  /// The worker's trade in their own vernacular once retrieval pins it (#649),
  /// or null before it pins. The interview's trust moment.
  final String? occupationLabel;

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
        extractionReady,
        unansweredEssentials,
        blocked,
        isMock,
        progress,
        questionKind,
        occupationLabel,
      ];
}
