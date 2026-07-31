import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

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
class ChatMessageSent extends ChatEvent {
  const ChatMessageSent(this.text);

  final String text;

  @override
  List<Object?> get props => <Object?>[text];
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
    this.sessionFailed = false,
    this.extractionReady = false,
    this.unansweredEssentials = const <String>[],
    this.lastReplyBlocked = false,
    this.lastReplyMock = false,
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

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? initializing,
    bool? sending,
    List<String>? followups,
    bool? sessionFailed,
    bool? extractionReady,
    List<String>? unansweredEssentials,
    bool? lastReplyBlocked,
    bool? lastReplyMock,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
      sending: sending ?? this.sending,
      followups: followups ?? this.followups,
      sessionFailed: sessionFailed ?? this.sessionFailed,
      // Latch: once ready, always ready (see the field doc).
      extractionReady: this.extractionReady || (extractionReady ?? false),
      unansweredEssentials: unansweredEssentials ?? this.unansweredEssentials,
      lastReplyBlocked: lastReplyBlocked ?? this.lastReplyBlocked,
      lastReplyMock: lastReplyMock ?? this.lastReplyMock,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        messages,
        initializing,
        sending,
        followups,
        sessionFailed,
        extractionReady,
        unansweredEssentials,
        lastReplyBlocked,
        lastReplyMock,
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

    // Show the typing indicator and drop the previous turn's chips (they belong
    // to a question already answered). The transcript is append-only, so this
    // index stays valid for marking the bubble failed later (#343).
    final int index = state.messages.length;
    emit(state.copyWith(
      messages: <ChatMessage>[
        ...state.messages,
        ChatMessage(text: text, fromWorker: true),
      ],
      sending: true,
      followups: const <String>[],
    ));

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
      // Append to CURRENT state, never to a list captured before the await
      // (#344): while this reply was in flight, a second send or a voice merge
      // may have appended bubbles. Re-emitting a pre-await snapshot ERASED
      // them from the visible transcript — the worker watched their own answers
      // vanish mid-profiling.
      // Append to CURRENT state, never to a list captured before the await
      // (#344): while this reply was in flight, a second send or a voice merge
      // may have appended bubbles. Re-emitting a pre-await snapshot ERASED them
      // from the visible transcript — the worker watched their own answers
      // vanish mid-profiling.
      emit(state.copyWith(
        messages: <ChatMessage>[
          // A retry heals its own bubble; a first send leaves it as-is.
          ..._withStatus(state.messages, index, ChatSendStatus.sent),
          ChatMessage(text: turn.reply, fromWorker: false),
        ],
        sending: _inFlightSends > 0,
        followups: turn.followups,
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
      ));
      _logWrapUpOnce(ready: turn.extractionReady);
    } on Failure catch (_) {
      _inFlightSends--;
      // Do NOT silently keep the bubble looking delivered (#343). Mark it FAILED
      // so it reads as undelivered and offers tap-to-retry — a worker whose
      // answers never reached the server must find out here, not when their
      // profile comes out empty.
      emit(state.copyWith(
        messages: _withStatus(state.messages, index, ChatSendStatus.failed),
        sending: _inFlightSends > 0,
      ));
    }
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
      // The voice turn went through the SAME chat endpoint, so it carries the
      // same readiness decision (#421).
      extractionReady: event.extractionReady,
    ));
    _logWrapUpOnce(ready: event.extractionReady);
  }
}
