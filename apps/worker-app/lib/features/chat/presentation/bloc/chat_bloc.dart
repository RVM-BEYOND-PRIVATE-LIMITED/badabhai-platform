import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/chat_message.dart';
import '../../domain/chat_repository.dart';

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
  const ChatState({required this.messages, this.initializing = true});

  /// Ordered, append-only transcript.
  final List<ChatMessage> messages;

  /// True while the session is being opened (shows a spinner, as before).
  final bool initializing;

  ChatState copyWith({List<ChatMessage>? messages, bool? initializing}) {
    return ChatState(
      messages: messages ?? this.messages,
      initializing: initializing ?? this.initializing,
    );
  }

  @override
  List<Object?> get props => <Object?>[messages, initializing];
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

    final List<ChatMessage> withWorker = <ChatMessage>[
      ...state.messages,
      ChatMessage(text: text, fromWorker: true),
    ];
    emit(state.copyWith(messages: withWorker));

    try {
      final String reply = await _repo.sendMessage(text);
      emit(state.copyWith(messages: <ChatMessage>[
        ...withWorker,
        ChatMessage(text: reply, fromWorker: false),
      ]));
    } on Failure catch (_) {
      // The frozen UI has no send-failure affordance — keep the worker's
      // message and no-op rather than inventing new error copy.
    }
  }

  /// Appends the already-server-merged voice transcript + reply. Local only —
  /// the voice pipeline sent the transcript through ChatRepository.sendMessage.
  void _onVoiceMerged(ChatVoiceMerged event, Emitter<ChatState> emit) {
    emit(state.copyWith(messages: <ChatMessage>[
      ...state.messages,
      ChatMessage(text: event.transcript, fromWorker: true),
      ChatMessage(text: event.reply, fromWorker: false),
    ]));
  }
}
