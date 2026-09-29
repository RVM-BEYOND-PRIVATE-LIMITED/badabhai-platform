import 'package:equatable/equatable.dart';

import '../../../core/api/api_models.dart'
    show
        ChatAnswerType,
        ChatInputMode,
        ChatOption,
        ChatProgress,
        ChatQuestionKind,
        FormOffer,
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
    this.answerType,
    this.occupationLabel,
    this.askedQuestionId,
    this.ttsText,
    this.lookahead = const <String, PredictedQuestion?>{},
    this.formOffer,
    this.resumeUpdate,
    this.gateKind,
    this.generalFormOffer,
    this.companion = false,
    this.digestKey,
    this.sessionEnded = false,
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

  /// HOW this turn's question is answered (`answer_type`, #1559 / #1583),
  /// carried from `ChatReply.answerType`. Null on an older API build and on
  /// every turn that is not serving a pack item — the UI then renders exactly
  /// today's chips and composer.
  final ChatAnswerType? answerType;

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

  /// THE INTERVIEW HANDED OVER TO A FORM (`form_offer`, #1339/#1340), carried
  /// from `ChatReply.formOffer` — null on every turn except the ONE that hands
  /// over. Drives the handover card + its CTA in [ChatProfilingScreen], IN
  /// PLACE OF the "build my profile" CTA (see that screen's `_doneCta`): the
  /// two must never both render, which is why the backend also sends
  /// `extraction_ready: false` on this same turn.
  final FormOffer? formOffer;

  /// #1689 — the server's word on the worker's answer to "Aapki nayi jaankari
  /// se resume update kar doon?", carried from `ChatReply.resumeUpdate`.
  /// `'queued'` on the ONE terminal turn that settled a Haan; null on an
  /// "Abhi nahi", on every ordinary turn, and on every older server.
  ///
  /// Kept RAW rather than as a bool so an unknown future value stays visible
  /// and still reads as "not queued" — see [resumeUpdateQueued].
  final String? resumeUpdate;

  /// ADR-0045 — the server's word on whether the skills gate is open this turn.
  /// `skills` means the skills gate ("Kya aur koi skill jodni hai?") is open.
  /// When absent or unknown the keyboard stays unlocked. Turn-scoped: cleared
  /// on the next turn, like [formOffer].
  final String? gateKind;

  /// ADR-0045 — the server's offer to open the general form after the skills
  /// gate closes. Both `headline` and `cta_label` are required. The key is
  /// ABSENT (never `null`) when unset. Turn-scoped: cleared on the next turn.
  final Map<String, String>? generalFormOffer;

  /// The only value that changes what the app does. Fails closed.
  bool get resumeUpdateQueued => resumeUpdate == 'queued';

  /// ADR-0044 — this turn came from the post-completion COMPANION
  /// (`/chat/companion`), not the interview. Set ONLY by the repository's
  /// companion mapping; every interview turn keeps the default `false`.
  ///
  /// What it changes: the chat stays in companion mode for the next send, and
  /// the turn is NOT an answered interview ask — so it never feeds the per-ask
  /// funnel (#1316), the answered-facts store, or `asked_question_id`.
  final bool companion;

  /// ADR-0044 — the companion recap's `digest_key`: a short hash of the facts
  /// it states, compared on a tab refocus to tell "nothing changed" from "your
  /// counts moved". Null on every other turn. Never shown.
  final String? digestKey;

  /// The server's `session_ended`: this reply CLOSED the interview session, or
  /// came from one that was already closed. Only the interview mapping carries
  /// it; a companion turn belongs to no session and keeps `false`.
  ///
  /// Read with [isMock] to tell the two apart: a reply from a session that was
  /// ALREADY over (the stateless résumé menu, or "Aapki baat poori ho chuki
  /// hai" for a send that raced the close) is served with `is_mock: true`, and
  /// a live interview turn never is.
  final bool sessionEnded;

  /// See [sessionEnded].
  bool get fromClosedSession => sessionEnded && isMock;

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
        answerType,
        occupationLabel,
        askedQuestionId,
        ttsText,
        lookahead,
        formOffer,
        resumeUpdate,
        gateKind,
        generalFormOffer,
        companion,
        digestKey,
        sessionEnded,
      ];
}
