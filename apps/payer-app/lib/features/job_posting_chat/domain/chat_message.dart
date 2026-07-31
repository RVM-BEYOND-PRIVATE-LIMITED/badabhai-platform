import 'package:equatable/equatable.dart';

/// Delivery state of a PAYER message.
///
/// The assistant's own messages are always [sent] — they exist because the
/// server already answered. Only the payer's bubbles can fail, and a failed one
/// must SAY so and offer a retry: silently rendering an undelivered message as
/// if it landed is how a whole interview gets discarded unnoticed (the exact bug
/// the worker chat fixed in #343).
enum ChatSendStatus { sent, failed }

/// One bubble in the job-posting chat. UI state (an ordered, append-only
/// transcript) — not an API shape, so it lives in the domain.
class ChatMessage extends Equatable {
  const ChatMessage({
    required this.text,
    required this.fromPayer,
    this.status = ChatSendStatus.sent,
  });

  final String text;
  final bool fromPayer;

  /// Meaningful only when [fromPayer]. Defaults to [sent] so assistant bubbles
  /// and the optimistic payer bubble read as normal.
  final ChatSendStatus status;

  ChatMessage copyWith({ChatSendStatus? status}) => ChatMessage(
        text: text,
        fromPayer: fromPayer,
        status: status ?? this.status,
      );

  @override
  List<Object?> get props => <Object?>[text, fromPayer, status];
}
