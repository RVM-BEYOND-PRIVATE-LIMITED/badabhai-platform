import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart'
    show
        ChatInputMode,
        ChatOption,
        ChatProgress,
        ChatQuestionKind,
        PredictedQuestion;
import '../../../../core/error/failure.dart';
import '../../../../core/observability/analytics.dart';
import '../../domain/chat_message.dart';
import '../../domain/chat_repository.dart';
import '../../domain/chat_turn.dart';

// ---------------- Events ----------------

sealed class ChatEvent extends Equatable {
  const ChatEvent();

  @override
  List<Object?> get props => <Object?>[];
}

/// Fired once when the screen mounts: opens the chat session.
class ChatStarted extends ChatEvent {
  const ChatStarted();
}

/// The worker sent a message.
///
/// [optionKey] is set ONLY when the message came from tapping a suggested-option
/// chip (#761): it is the key to index the previous turn's `lookahead` by — the
/// tapped label on chat, or `'__declined'` for the decline/escape chip. A typed
/// send leaves it null and never renders a prediction. It does NOT change the
/// submit: the wire body stays `{session_id, text}` with `text` = [text].
class ChatMessageSent extends ChatEvent {
  const ChatMessageSent(this.text, {this.optionKey});

  final String text;
  final String? optionKey;

  @override
  List<Object?> get props => <Object?>[text, optionKey];
}

/// Re-send the failed worker message at [index] (#343). The transcript is
/// append-only, so an index stays stable once emitted.
class ChatRetryRequested extends ChatEvent {
  const ChatRetryRequested(this.index);

  final int index;

  @override
  List<Object?> get props => <Object?>[index];
}

/// A voice note completed on the voice screen: its transcript was ALREADY sent
/// server-side (merged like a typed message by the voice pipeline) and [reply]
/// is bada bhai's answer. This appends both bubbles locally — NO network call,
/// or the message would be sent twice.
class ChatVoiceMerged extends ChatEvent {
  const ChatVoiceMerged({
    required this.transcript,
    required this.reply,
    this.extractionReady = false,
  });

  final String transcript;
  final String reply;

  /// The engine's readiness decision for the turn the voice note produced
  /// (#421) — a worker who finishes the interview BY VOICE must unlock the
  /// same CTA as one who typed.
  final bool extractionReady;

  @override
  List<Object?> get props => <Object?>[transcript, reply, extractionReady];
}

// ---------------- State ----------------

class ChatState extends Equatable {
  const ChatState({
    required this.messages,
    this.initializing = true,
    this.sending = false,
    this.followups = const <String>[],
    this.suggestedOptions = const <ChatOption>[],
    this.sessionFailed = false,
    this.extractionReady = false,
    this.unansweredEssentials = const <String>[],
    this.lastReplyBlocked = false,
    this.lastReplyMock = false,
    this.progress,
    this.questionKind = ChatQuestionKind.ask,
    this.inputMode = ChatInputMode.text,
    this.occupationLabel,
    this.lookahead = const <String, PredictedQuestion?>{},
    this.predictedQuestionKey,
  });

  /// Ordered, append-only transcript.
  final List<ChatMessage> messages;

  /// True while the session is being opened (shows a spinner, as before).
  final bool initializing;

  /// True while a reply is in flight — drives the "Bada Bhai type kar raha
  /// hai…" indicator so a real (1–3s) LLM turn does not look frozen.
  final bool sending;

  /// Tap-to-answer suggestions for the LATEST reply (backend
  /// `suggested_followups`). Cleared the moment the worker sends again.
  final List<String> followups;

  /// The LATEST reply's `suggested_options` (#761), served ALONGSIDE [followups].
  /// When non-empty the screen renders chips from THIS list so each carries its
  /// stable `option_key` (indexed against [lookahead] on tap); empty falls back
  /// to the label-keyed [followups]. Cleared on send exactly like [followups].
  final List<ChatOption> suggestedOptions;

  /// True when opening the chat session failed and no send has healed it yet
  /// (#343) — drives a banner, so the worker is TOLD rather than typing into a
  /// session that was never opened.
  final bool sessionFailed;

  /// True once the interview engine has reported `extraction_ready` on any turn
  /// of this session (#421) — i.e. it has enough answers to build a profile.
  ///
  /// STICKY by design: it latches on the first `true` and never falls back to
  /// false. The engine's own signal is monotonic in practice (past readiness it
  /// wraps up and keeps returning true), and a transient false — a degraded
  /// reply, a field lost in a partial parse — must never yank the CTA out from
  /// under a worker who was already told they could finish.
  final bool extractionReady;

  /// ESSENTIAL topics the worker has not answered yet (`unanswered_essentials`,
  /// #478), from the LATEST non-blocked turn — topic ids only, never PII. Drives
  /// the named "what's still missing" helper. NOT latched: it must reflect the
  /// current gaps, which shrink as the worker answers. A blocked turn leaves it
  /// unchanged (blocked → "unknown", never "complete").
  final List<String> unansweredEssentials;

  /// True when the MOST RECENT reply was blocked (pseudonymize fail-closed): the
  /// worker's last answer was not processed, so the screen cues them to repeat
  /// it. Turn-scoped (not latched) — the next good turn clears it.
  final bool lastReplyBlocked;

  /// True when the most recent reply came from the mock/AI-down fallback
  /// (`is_mock`). Surfaced only as a non-release demo cue (see [ChatTurn.isMock]).
  final bool lastReplyMock;

  /// How far through the pinned pack the worker is (#649). STICKY-FORWARD: once a
  /// pack pins (first non-null), it stays and reflects the latest count; a null
  /// on a later/blocked turn leaves the last known value rather than flickering
  /// the finish line away. Null until the first pack resolves — the bar is hidden.
  final ChatProgress? progress;

  /// The latest turn's kind (#649). TURN-SCOPED — reset to [ChatQuestionKind.ask]
  /// on send, set from the reply; only [ChatQuestionKind.disambiguate] changes
  /// how the followups render.
  final ChatQuestionKind questionKind;

  /// The latest turn's input mode (#770). TURN-SCOPED exactly like [questionKind]
  /// — reset to [ChatInputMode.text] on send, set from the reply. When
  /// [ChatInputMode.optionsOnly] the composer is suppressed and the chips are the
  /// only answer path. Never latched: the composer returns on the next turn
  /// unless the server re-imposes options-only.
  final ChatInputMode inputMode;

  /// The worker's pinned trade in their own vernacular (#649). STICKY: latches on
  /// the first non-null and stays (the trust moment, shown for the rest of the
  /// interview). A fresh chat rebuilds the bloc, so it clears there.
  final String? occupationLabel;

  /// The LATEST turn's advisory next-turn predictions (#761), keyed by the tapped
  /// option (+ `'__declined'`). Consumed by the NEXT [ChatMessageSent] to render
  /// the predicted question optimistically. Empty = no predictions.
  final Map<String, PredictedQuestion?> lookahead;

  /// The `question_key` of the optimistic predicted bubble currently on screen
  /// (#761), or null when there is none — which is EITHER no prediction rendered
  /// OR a `close`-shaped prediction (those carry a null key and so are never
  /// rendered optimistically; the client waits the round trip for the closing
  /// line). Non-null therefore means "an optimistic bubble is awaiting reconcile":
  /// the next real turn replaces it, and its `asked_question_id` is compared
  /// against this to tell whether the prediction was right.
  final String? predictedQuestionKey;

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? initializing,
    bool? sending,
    List<String>? followups,
    List<ChatOption>? suggestedOptions,
    bool? sessionFailed,
    bool? extractionReady,
    List<String>? unansweredEssentials,
    bool? lastReplyBlocked,
    bool? lastReplyMock,
    ChatProgress? progress,
    ChatQuestionKind? questionKind,
    ChatInputMode? inputMode,
    String? occupationLabel,
    Map<String, PredictedQuestion?>? lookahead,
    String? predictedQuestionKey,
    // predictedQuestionKey is nullable AND must be settable back to null on
    // reconcile — which `?? this` cannot express — so clearing it takes an
    // explicit flag (the standard copyWith idiom for a clearable nullable).
    bool clearPredictedQuestionKey = false,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
      sending: sending ?? this.sending,
      followups: followups ?? this.followups,
      suggestedOptions: suggestedOptions ?? this.suggestedOptions,
      sessionFailed: sessionFailed ?? this.sessionFailed,
      // Latch: once ready, always ready (see the field doc).
      extractionReady: this.extractionReady || (extractionReady ?? false),
      unansweredEssentials: unansweredEssentials ?? this.unansweredEssentials,
      lastReplyBlocked: lastReplyBlocked ?? this.lastReplyBlocked,
      lastReplyMock: lastReplyMock ?? this.lastReplyMock,
      // Sticky-forward / sticky: a null keeps the last known (see field docs).
      progress: progress ?? this.progress,
      questionKind: questionKind ?? this.questionKind,
      inputMode: inputMode ?? this.inputMode,
      occupationLabel: occupationLabel ?? this.occupationLabel,
      lookahead: lookahead ?? this.lookahead,
      predictedQuestionKey: clearPredictedQuestionKey
          ? null
          : (predictedQuestionKey ?? this.predictedQuestionKey),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        messages,
        initializing,
        sending,
        followups,
        suggestedOptions,
        sessionFailed,
        extractionReady,
        unansweredEssentials,
        lastReplyBlocked,
        lastReplyMock,
        progress,
        questionKind,
        inputMode,
        occupationLabel,
        lookahead,
        predictedQuestionKey,
      ];
}

// ---------------- Bloc ----------------

/// The opening bada-bhai prompt — a CLIENT-side line shown before the engine's
/// first turn exists (#422).
///
/// NOW THE FALLBACK, NOT THE ONLY PATH. `POST /chat/session` can serve the
/// engine's own one-shot opener (`opening_text`, behind
/// CHAT_ONE_SHOT_OPENER_ENABLED), and [ChatBloc] swaps it into bubble 0 when it
/// arrives. This constant is what the worker sees when it does not: flag off, AI
/// service unreachable, mock client, or an API build that predates the field.
/// Keeping it is the point — the chat must never open on a blank bubble.
///
/// THE COPY. Warm "bada bhai" Hinglish, aap-form, framing the chat as building
/// the worker's resume — no "test" language, no machine list, no worker-name
/// vocative (the persona's `"{{worker_name}} ji, "` slot is filled server-side
/// after the event is emitted; the client holds no name and must not render
/// one). It asks the engine's ACTUAL first topic — `role`
/// (`aap kaunsa kaam karte hain?`) — verbatim, so the engine's turn 1 (which
/// serves the first UNANSWERED topic) advances to the next question rather than
/// repeating itself. Exactly one question per turn (B-5).
///
/// Residual gap, NARROWED: this string still duplicates engine copy client-side
/// and can drift from `question_bank.py`. It is now only what a DEGRADED session
/// shows, and the server-served opener above is the live path — but the drift is
/// not gone, so keep this aligned with the `role` topic if that copy changes.
///
/// BYTE-IDENTICAL CONTRACT (drift S4). This string and the ai-service's
/// `ONE_SHOT_OPENER` (`apps/ai-service/app/profiling/question_bank.py`) are the
/// SAME copy served from two places, so a worker sees the same first line
/// whether `CHAT_ONE_SHOT_OPENER_ENABLED` is on or off. They must stay byte-for-
/// byte equal — if you edit one, edit the other in the same change.
///
/// PENDING SERVER EDIT: the opener now reads "Namaste." here, not "Namaste!".
/// An exclamation mark in bot copy violates the persona's Ten Laws (enforced by
/// `test/persona_neutrality_test.dart`), so the client half is fixed. The Python
/// constant still says "Namaste!" and needs the identical one-character edit —
/// until it lands, a flag-ON session differs from this fallback by that one
/// character. Tracked in the change that introduced this note.
const String kChatOpeningText =
    'Namaste. Main aapka Bada Bhai. Chalo, ab aapka accha sa resume banate hain. '
    'Chaliye shuru karte hain — aap kaunsa kaam karte hain?';

/// The opening bada-bhai prompt as a transcript bubble.
const ChatMessage kChatOpeningMessage = ChatMessage(
  text: kChatOpeningText,
  fromWorker: false,
);

class ChatBloc extends Bloc<ChatEvent, ChatState> {
  ChatBloc(this._repo)
      : super(const ChatState(messages: <ChatMessage>[kChatOpeningMessage])) {
    on<ChatStarted>(_onStarted);
    on<ChatMessageSent>(_onMessageSent);
    on<ChatRetryRequested>(_onRetryRequested);
    on<ChatVoiceMerged>(_onVoiceMerged);
  }

  final ChatRepository _repo;

  /// True once the wrap-up milestone has been logged for this session (#B7).
  /// [ChatState.extractionReady] LATCHES, so without this the milestone would
  /// re-fire on every turn after the interview completes and the funnel would
  /// read as many wrap-ups per worker.
  bool _wrapUpLogged = false;

  /// Log the "interview complete" funnel milestone the first time the engine
  /// says so. PII-free: a turn COUNT, never a message, id, or topic.
  void _logWrapUpOnce({required bool ready}) {
    if (!ready || _wrapUpLogged) return;
    _wrapUpLogged = true;
    unawaited(BbAnalytics.instance.log(BbAnalytics.chatWrapUp(
      turnCount:
          state.messages.where((ChatMessage m) => m.fromWorker).length,
    )));
  }

  /// How many sends are awaiting a reply right now.
  ///
  /// bloc 8.x processes events CONCURRENTLY by default (no transformer is
  /// registered), so two quick sends — or a send racing a [ChatVoiceMerged] —
  /// overlap. The counter keeps [ChatState.sending] honest: the typing indicator
  /// must stay up until the LAST in-flight reply lands, not the first (#344).
  int _inFlightSends = 0;

  Future<void> _onStarted(ChatStarted event, Emitter<ChatState> emit) async {
    bool failed = false;
    String? opener;
    try {
      opener = await _repo.ensureSession();
    } on Failure catch (_) {
      // Do NOT swallow this (#343). The spinner still drops so the worker can
      // type, but the failure is now SURFACED: the repository re-opens the
      // session lazily on the next send, and until that succeeds the banner
      // tells the worker the connection is not established.
      failed = true;
    }

    // Drop the spinner + apply the served opener NOW — before any hydration
    // await. A concurrent first send (the fast-typist race, #344) must not be
    // reordered behind a slow transcript read: this emit is what the existing
    // ordering contract depends on, so it stays a single await deep, exactly as
    // before #502.
    emit(state.copyWith(
      initializing: false,
      sessionFailed: failed,
      messages: _withOpener(opener),
    ));

    if (failed) return;

    // #502 transcript hydration, as a FOLLOW-UP emit: redraw a prior session's
    // turns that live only server-side. After a >5min background re-lock the app
    // rebuilds [ChatBloc] with just its opener bubble while `chat_messages` still
    // holds every answer — the worker would otherwise land on a BLANK thread
    // mid-interview. BEST-EFFORT and decorative: a hydration hiccup degrades to
    // "no history" (the repo returns [] on error; the catch guards a
    // mock/regression too) and never blocks the already-open chat.
    List<ChatMessage> history;
    try {
      history = await _repo.loadHistory();
    } catch (_) {
      history = const <ChatMessage>[];
    }
    final List<ChatMessage>? redrawn = _historyRedraw(history);
    if (redrawn != null) emit(state.copyWith(messages: redrawn));
  }

  /// The transcript with bubble 0 swapped for the server-served [opener].
  ///
  /// Returns null (= "leave messages alone", the [ChatState.copyWith] contract)
  /// whenever there is no opener to apply, which is every flag-off, AI-service-
  /// down, mock-client and older-API session. Those keep rendering
  /// [kChatOpeningText], so this is additive in the strict sense.
  ///
  /// REPLACES rather than APPENDS. Appending would greet the worker twice with
  /// two different openers, and the canned one asks the `role` question outright
  /// — the worker would answer it, then be invited to answer everything at once,
  /// which reads as the app not having listened.
  ///
  /// Rebuilt from `state.messages` AT EMIT TIME, not from a list captured before
  /// the await. bloc 8.x runs events CONCURRENTLY (no transformer is registered
  /// here), so a fast worker can have typed before the session call returned; a
  /// captured list would silently drop their message. Index 0 is stable under
  /// that race because the transcript is append-only and the constructor seeds
  /// bubble 0 as the opener — nothing can ever insert ahead of it.
  List<ChatMessage>? _withOpener(String? opener) {
    if (opener == null || opener.trim().isEmpty) return null;
    final List<ChatMessage> messages = state.messages;
    if (messages.isEmpty || messages.first.fromWorker) return null;
    if (messages.first.text == opener) return null; // already applied
    return <ChatMessage>[
      ChatMessage(text: opener, fromWorker: false),
      ...messages.skip(1),
    ];
  }

  /// The greeting bubble (0) followed by the server-side transcript (#502), or
  /// null — "leave messages alone", the [ChatState.copyWith] contract — when
  /// there is nothing to redraw. Rebuilt from `state.messages` AT EMIT TIME for
  /// the same bloc-8.x concurrency reason as [_withOpener].
  ///
  /// REDRAWS ONLY WHEN THE WORKER HAS NOT TYPED YET — the transcript is still
  /// just the opener. A worker who has already sent a message (the same-instance
  /// live path, or a fast-typist race during the hydration await) must never
  /// have their bubbles replaced; and on a fresh mount a non-empty [history] is
  /// exactly the re-lock case this fixes. The canned/served opener is never
  /// itself stored server-side (rendered-only), so this cannot duplicate it.
  List<ChatMessage>? _historyRedraw(List<ChatMessage> history) {
    if (history.isEmpty) return null;
    final List<ChatMessage> base = state.messages;
    if (base.any((ChatMessage m) => m.fromWorker)) return null;
    final List<ChatMessage> opening = base.isNotEmpty && !base.first.fromWorker
        ? <ChatMessage>[base.first]
        : const <ChatMessage>[];
    return <ChatMessage>[...opening, ...history];
  }

  Future<void> _onMessageSent(
    ChatMessageSent event,
    Emitter<ChatState> emit,
  ) async {
    final String text = event.text.trim();
    if (text.isEmpty) return;

    // The transcript is append-only, so this index stays valid for marking the
    // worker bubble failed later (#343).
    final int index = state.messages.length;
    // #761 — OPTIMISTIC LOOKAHEAD. If the tapped option carries a server
    // prediction WITH a next question (a `close`-shaped prediction has a null
    // key and is skipped — its closing line is not latency-critical), render the
    // predicted next turn NOW so a 2G worker does not wait the round trip.
    // ADVISORY ONLY: nothing here is banked as an answer, the [_deliver] below
    // still submits the byte-identical `text`, and the real reply reconciles.
    final PredictedQuestion? predicted =
        event.optionKey == null ? null : state.lookahead[event.optionKey];

    if (predicted != null && predicted.questionKey != null) {
      emit(state.copyWith(
        messages: <ChatMessage>[
          ...state.messages,
          ChatMessage(text: text, fromWorker: true),
          // The optimistic bada-bhai bubble — REPLACED by the real reply in
          // [_deliver]. It is never persisted to history: it lives only in this
          // in-memory transcript until reconcile.
          ChatMessage(text: predicted.promptText, fromWorker: false),
        ],
        sending: true,
        followups: predicted.options,
        // The prediction carries LABELS only (no option objects), so clear the
        // option list and let the predicted chips render from [followups] — the
        // label-keyed path, which is correct until the real turn brings its own
        // `suggested_options`.
        suggestedOptions: const <ChatOption>[],
        // Sticky-forward: a null predicted progress keeps the last known bar.
        progress: predicted.progress,
        questionKind: predicted.questionKind,
        // #770 — the composer returns the moment the worker answers, on the
        // optimistic path too: an options-only turn must never outlive the
        // question that imposed it, and the predicted turn brings its own mode.
        inputMode: ChatInputMode.text,
        predictedQuestionKey: predicted.questionKey,
      ));
    } else {
      // No usable prediction → EXACTLY today's behaviour: show the typing
      // indicator and drop the previous turn's chips (they belong to a question
      // already answered).
      emit(state.copyWith(
        messages: <ChatMessage>[
          ...state.messages,
          ChatMessage(text: text, fromWorker: true),
        ],
        sending: true,
        followups: const <String>[],
        // The previous turn's options belong to a question already answered —
        // drop them alongside the followups (#761).
        suggestedOptions: const <ChatOption>[],
        // The previous turn's kind belongs to a question already answered — reset
        // so a stale disambiguate layout can't outlive its chips (#649).
        questionKind: ChatQuestionKind.ask,
        // Same reason (#770): bring the composer back the moment the worker answers.
        inputMode: ChatInputMode.text,
      ));
    }

    await _deliver(text, index, emit);
  }

  /// Sends [text] (already appended at [index]) and records the outcome.
  ///
  /// Shared by a first send and a retry so both surface failure identically.
  Future<void> _deliver(String text, int index, Emitter<ChatState> emit) async {
    _inFlightSends++;
    try {
      final ChatTurn turn = await _repo.sendMessage(text);
      _inFlightSends--;
      // #761 — RECONCILE the optimistic lookahead render. The real reply is
      // ALWAYS authoritative: when an optimistic predicted bubble is on screen
      // (predictedQuestionKey != null) we REPLACE it rather than append a second
      // bot bubble. If the prediction was RIGHT (its question_key matches the real
      // turn's asked_question_id) the rendered bubble is kept and only the
      // metadata refreshes; if WRONG, its text/chips are overwritten with the
      // real turn. Either way the transcript ends with exactly one bot bubble for
      // this turn, and the prediction is cleared.
      //
      // Append to CURRENT state, never to a list captured before the await
      // (#344): while this reply was in flight, a second send or a voice merge
      // may have appended bubbles. Re-emitting a pre-await snapshot ERASED them
      // from the visible transcript — the worker watched their own answers
      // vanish mid-profiling.
      final List<ChatMessage> healed =
          _withStatus(state.messages, index, ChatSendStatus.sent);
      final bool reconciling = state.predictedQuestionKey != null;
      final bool predictionWasRight =
          reconciling && turn.askedQuestionId == state.predictedQuestionKey;
      final List<ChatMessage> nextMessages;
      if (!reconciling) {
        // No optimistic bubble — today's behaviour: append the reply.
        nextMessages = <ChatMessage>[
          ...healed,
          ChatMessage(text: turn.reply, fromWorker: false),
        ];
      } else if (predictionWasRight) {
        // The prediction stood — keep the optimistic bubble as-is (metadata
        // refreshes below), so an agreeing turn causes no visible flicker.
        nextMessages = healed;
      } else {
        // The prediction was wrong — overwrite the optimistic bubble in place.
        nextMessages = _replaceLastBot(healed, turn.reply);
      }
      emit(state.copyWith(
        messages: nextMessages,
        sending: _inFlightSends > 0,
        followups: turn.followups,
        // #761 — the option objects for THIS turn (with their stable keys); the
        // screen renders chips from these when present, else from [followups].
        suggestedOptions: turn.suggestedOptions,
        // A delivered message proves the session is open again.
        sessionFailed: false,
        // The engine's interview-completeness decision for this turn (#421).
        // copyWith LATCHES this, so a later turn cannot un-ready the CTA.
        extractionReady: turn.extractionReady,
        // #478 — the named "what's still missing" gaps. TRUST ONLY a non-blocked
        // turn: a blocked turn degrades `unanswered_essentials` to [] = "unknown"
        // (not "complete"), so keep the previous known gaps rather than wrongly
        // declaring the profile finished.
        unansweredEssentials:
            turn.blocked ? state.unansweredEssentials : turn.unansweredEssentials,
        // Turn-scoped honesty cues (see [ChatTurn]).
        lastReplyBlocked: turn.blocked,
        lastReplyMock: turn.isMock,
        // OIE Phase 8 (#649): progress + occupation are sticky-forward (a null on
        // a blocked turn keeps the last known); questionKind drives the followup
        // layout for THIS turn (disambiguate → vertical single-select).
        progress: turn.progress,
        questionKind: turn.questionKind,
        // #770 — this turn's composer decision; text on a blocked/older turn, so
        // the worker is never left without a way to answer.
        inputMode: turn.inputMode,
        occupationLabel: turn.occupationLabel,
        // #761 — the fresh predictions for the NEXT tap; the current one is done.
        lookahead: turn.lookahead,
        clearPredictedQuestionKey: true,
      ));
      _logWrapUpOnce(ready: turn.extractionReady);
    } on Failure catch (_) {
      _inFlightSends--;
      // Do NOT silently keep the bubble looking delivered (#343). Mark it FAILED
      // so it reads as undelivered and offers tap-to-retry — a worker whose
      // answers never reached the server must find out here, not when their
      // profile comes out empty.
      //
      // #761 — a failed send retracts any optimistic bubble: the predicted next
      // question never actually happened, so drop it (and its chips) rather than
      // leave a phantom turn above the worker's failed answer.
      final bool reconciling = state.predictedQuestionKey != null;
      final List<ChatMessage> reverted =
          reconciling ? _removeLastBot(state.messages) : state.messages;
      emit(state.copyWith(
        messages: _withStatus(reverted, index, ChatSendStatus.failed),
        sending: _inFlightSends > 0,
        followups: reconciling ? const <String>[] : state.followups,
        // Mirror [followups]: a retracted optimistic turn drops its options too;
        // a plain failure keeps the current turn's options so the chips remain.
        suggestedOptions:
            reconciling ? const <ChatOption>[] : state.suggestedOptions,
        questionKind: reconciling ? ChatQuestionKind.ask : state.questionKind,
        clearPredictedQuestionKey: true,
      ));
    }
  }

  /// Returns [messages] with the LAST message replaced by a bot bubble carrying
  /// [reply] (the #761 optimistic-bubble overwrite). Defensive, mirroring
  /// [_withStatus]: an empty list or a worker-bubble tail is returned unchanged.
  List<ChatMessage> _replaceLastBot(List<ChatMessage> messages, String reply) {
    if (messages.isEmpty || messages.last.fromWorker) return messages;
    final List<ChatMessage> next = List<ChatMessage>.of(messages);
    next[next.length - 1] = ChatMessage(text: reply, fromWorker: false);
    return next;
  }

  /// Returns [messages] with a trailing bot bubble removed (the #761 optimistic
  /// bubble, retracted on a failed send). Unchanged when the tail is not a bot
  /// bubble.
  List<ChatMessage> _removeLastBot(List<ChatMessage> messages) {
    if (messages.isEmpty || messages.last.fromWorker) return messages;
    return messages.sublist(0, messages.length - 1);
  }

  /// Returns [messages] with the entry at [index] set to [status]. Out-of-range
  /// indices are returned unchanged (defensive — the list is append-only).
  List<ChatMessage> _withStatus(
    List<ChatMessage> messages,
    int index,
    ChatSendStatus status,
  ) {
    if (index < 0 || index >= messages.length) return messages;
    if (messages[index].status == status) return messages;
    final List<ChatMessage> next = List<ChatMessage>.of(messages);
    next[index] = next[index].copyWith(status: status);
    return next;
  }

  /// Re-sends a failed bubble in place — no duplicate bubble is appended.
  Future<void> _onRetryRequested(
    ChatRetryRequested event,
    Emitter<ChatState> emit,
  ) async {
    final int index = event.index;
    if (index < 0 || index >= state.messages.length) return;
    final ChatMessage message = state.messages[index];
    // Only a worker bubble that actually failed is retryable.
    if (!message.fromWorker || message.status != ChatSendStatus.failed) return;

    // Optimistically un-fail it while the retry is in flight.
    emit(state.copyWith(
      messages: _withStatus(state.messages, index, ChatSendStatus.sent),
      sending: true,
      followups: const <String>[],
      suggestedOptions: const <ChatOption>[], // #761 — drop with the followups
      questionKind: ChatQuestionKind.ask, // #649 — drop a stale disambiguate
      inputMode: ChatInputMode.text, // #770 — bring the composer back on retry
    ));

    await _deliver(message.text, index, emit);
  }

  /// Appends the already-server-merged voice transcript + reply. Local only —
  /// the voice pipeline sent the transcript through ChatRepository.sendMessage.
  void _onVoiceMerged(ChatVoiceMerged event, Emitter<ChatState> emit) {
    // The voice pipeline returns only the reply text (no followups), so clear
    // any stale chips from the previous typed turn.
    emit(state.copyWith(
      messages: <ChatMessage>[
        ...state.messages,
        ChatMessage(text: event.transcript, fromWorker: true),
        ChatMessage(text: event.reply, fromWorker: false),
      ],
      // A voice merge must not clear a TYPED send's indicator that is still
      // awaiting its reply (#344) — only report idle when nothing is in flight.
      sending: _inFlightSends > 0,
      followups: const <String>[],
      // The voice pipeline returns no options — clear with the followups (#761).
      suggestedOptions: const <ChatOption>[],
      // A voice answer is never a disambiguation turn — reset the layout (#649).
      questionKind: ChatQuestionKind.ask,
      // A voice merge returns no chips, so the worker must be able to type the
      // next turn — never leave them on an options-only lock (#770).
      inputMode: ChatInputMode.text,
      // The voice turn went through the SAME chat endpoint, so it carries the
      // same readiness decision (#421).
      extractionReady: event.extractionReady,
    ));
    _logWrapUpOnce(ready: event.extractionReady);
  }
}
