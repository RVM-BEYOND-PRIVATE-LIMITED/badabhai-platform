import 'package:equatable/equatable.dart';

/// Delivery state of a WORKER message (#343).
///
/// Bada bhai's own messages are always [sent] — they exist because the server
/// already answered. Only the worker's bubbles can fail, and a failed one must
/// SAY so and offer a retry: silently rendering an undelivered message as if it
/// landed is what let a whole profiling session be discarded unnoticed.
enum ChatSendStatus {
  /// Delivered to the server (or a bada-bhai message, which is always this).
  sent,

  /// The send threw. The bubble stays in the transcript, marked, tap-to-retry.
  failed,
}

/// One message in the "bada bhai" profiling chat. UI state (an ordered,
/// append-only transcript) — not an API shape, so it lives in the domain.
class ChatMessage extends Equatable {
  const ChatMessage({
    required this.text,
    required this.fromWorker,
    this.status = ChatSendStatus.sent,
  });

  final String text;
  final bool fromWorker;

  /// Delivery state — meaningful only when [fromWorker]. Defaults to [sent] so
  /// bada-bhai bubbles and the optimistic worker bubble read as normal.
  final ChatSendStatus status;

  ChatMessage copyWith({ChatSendStatus? status}) => ChatMessage(
        text: text,
        fromWorker: fromWorker,
        status: status ?? this.status,
      );

  @override
  List<Object?> get props => <Object?>[text, fromWorker, status];
}
