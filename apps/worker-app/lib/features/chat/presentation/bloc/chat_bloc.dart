import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
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

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? initializing,
    bool? sending,
    List<String>? followups,
    bool? sessionFailed,
    bool? extractionReady,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
      sending: sending ?? this.sending,
      followups: followups ?? this.followups,
      sessionFailed: sessionFailed ?? this.sessionFailed,
      // Latch: once ready, always ready (see the field doc).
      extractionReady: this.extractionReady || (extractionReady ?? false),
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
/// WHY THE FALLBACK IS STILL CANNED. Fetching the engine's first turn any other
/// way needs a worker message to exist, and this constant predates the opener
/// seam:
///   * `POST /chat/session` returns `{session_id, status, started_at}` only —
///     no reply (`apps/api/src/chat/chat.service.ts` `startSession`).
///   * `POST /chat/message` is the only path into the engine and its body is
///     validated by `PostMessageSchema` with `nonEmptyMessageSchema`
///     (`apps/api/src/chat/chat.dto.ts`), so an empty-history / empty-text call
///     is rejected — and faking a worker message to trigger turn 1 would put a
///     message the worker never said into the stored transcript that extraction
///     later reads.
///   * The engine DOES expose `first_question()`
///     (`apps/ai-service/app/profiling/interview_engine.py`), but it has zero
///     callers and no route on the FastAPI app — nothing serves it.
///
/// So the copy is instead ALIGNED with the contract the rest of the flow obeys:
///   * Hinglish, aap-form, warm — matching the mentor voice in `question_bank`.
///   * The engine's ACTUAL first topic is `role`, not machines, and this asks
///     that question verbatim from the `role` topic — so the engine's turn 1
///     (which serves the first UNANSWERED topic) advances to `machines` rather
///     than repeating itself, and the worker is never asked the wrong thing
///     first.
///   * NO vocative. The persona's `"{{worker_name}} ji, "` slot is filled
///     server-side after the event is emitted; the client holds no name here
///     and must not render one, so we take the engine's documented
///     `worker_name=None` shape (no vocative) rather than inventing one.
///
/// Residual gap, NARROWED: this string still duplicates engine copy client-side
/// and can drift from `question_bank.py`. It is now only what a DEGRADED session
/// shows, and the server-served opener above is the live path — but the drift is
/// not gone, so keep this aligned with the `role` topic if that copy changes.
const String kChatOpeningText =
    'Namaste! Main Bada Bhai. Koi test nahi, bas baat karni hai. '
    'Aap kaunsa kaam karte hain — CNC, VMC, HMC operator, setter ya programmer?';

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
    emit(state.copyWith(
      initializing: false,
      sessionFailed: failed,
      messages: _withOpener(opener),
    ));
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
      ));
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
  }
}
