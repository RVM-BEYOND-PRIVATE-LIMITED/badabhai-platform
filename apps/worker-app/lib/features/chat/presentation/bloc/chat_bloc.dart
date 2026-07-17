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
  const ChatVoiceMerged({required this.transcript, required this.reply});

  final String transcript;
  final String reply;

  @override
  List<Object?> get props => <Object?>[transcript, reply];
}

// ---------------- State ----------------

class ChatState extends Equatable {
  const ChatState({
    required this.messages,
    this.initializing = true,
    this.sending = false,
    this.followups = const <String>[],
    this.sessionFailed = false,
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

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? initializing,
    bool? sending,
    List<String>? followups,
    bool? sessionFailed,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
      sending: sending ?? this.sending,
      followups: followups ?? this.followups,
      sessionFailed: sessionFailed ?? this.sessionFailed,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[messages, initializing, sending, followups, sessionFailed];
}

// ---------------- Bloc ----------------

/// The opening bada-bhai prompt (unchanged copy).
const ChatMessage _openingMessage = ChatMessage(
  text: 'Bada Bhai here. Which machines do you run?',
  fromWorker: false,
);

class ChatBloc extends Bloc<ChatEvent, ChatState> {
  ChatBloc(this._repo)
      : super(const ChatState(messages: <ChatMessage>[_openingMessage])) {
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
    try {
      await _repo.ensureSession();
    } on Failure catch (_) {
      // Do NOT swallow this (#343). The spinner still drops so the worker can
      // type, but the failure is now SURFACED: the repository re-opens the
      // session lazily on the next send, and until that succeeds the banner
      // tells the worker the connection is not established.
      failed = true;
    }
    emit(state.copyWith(initializing: false, sessionFailed: failed));
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
    ));
  }
}
