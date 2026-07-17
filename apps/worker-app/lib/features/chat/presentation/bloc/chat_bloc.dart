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

  ChatState copyWith({
    List<ChatMessage>? messages,
    bool? initializing,
    bool? sending,
    List<String>? followups,
  }) {
    return ChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
      sending: sending ?? this.sending,
      followups: followups ?? this.followups,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[messages, initializing, sending, followups];
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
    try {
      await _repo.ensureSession();
    } on Failure catch (_) {
      // The original left a stuck spinner on session-start failure; we instead
      // drop it below so the worker can still type.
    }
    emit(state.copyWith(initializing: false));
  }

  Future<void> _onMessageSent(
    ChatMessageSent event,
    Emitter<ChatState> emit,
  ) async {
    final String text = event.text.trim();
    if (text.isEmpty) return;

    // Show the typing indicator and drop the previous turn's chips (they belong
    // to a question already answered).
    emit(state.copyWith(
      messages: <ChatMessage>[
        ...state.messages,
        ChatMessage(text: text, fromWorker: true),
      ],
      sending: true,
      followups: const <String>[],
    ));

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
          ...state.messages,
          ChatMessage(text: turn.reply, fromWorker: false),
        ],
        sending: _inFlightSends > 0,
        followups: turn.followups,
      ));
    } on Failure catch (_) {
      _inFlightSends--;
      // The frozen UI has no send-failure affordance — keep the worker's
      // message and just drop the typing indicator rather than inventing new
      // error copy.
      emit(state.copyWith(sending: _inFlightSends > 0));
    }
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
