import 'package:equatable/equatable.dart';

import '../../../core/api/api_client.dart'
    show RelayMessageDto, RelayThreadDto;

/// One of the worker's relay threads (E0 in-app relay, FE #1628).
///
/// FACELESS BY CONTRACT: the wire carries an opaque [unlockId], a time and an
/// unread count — never a payer identity. Nothing here may be rendered as who
/// the other party is.
class InboxThread extends Equatable {
  const InboxThread({
    required this.unlockId,
    required this.lastMessageAt,
    required this.unreadCount,
  });

  final String unlockId;
  final DateTime lastMessageAt;
  final int unreadCount;

  bool get hasUnread => unreadCount > 0;

  factory InboxThread.fromDto(RelayThreadDto dto) => InboxThread(
        unlockId: dto.unlockId,
        lastMessageAt: dto.lastMessageAt,
        unreadCount: dto.unreadCount,
      );

  @override
  List<Object?> get props => <Object?>[unlockId, lastMessageAt, unreadCount];
}

/// One message on a thread. [text] is the server-rendered string; no payer
/// identity and no raw body column exists on this wire.
class InboxMessage extends Equatable {
  const InboxMessage({
    required this.messageId,
    required this.fromWorker,
    required this.text,
    required this.createdAt,
  });

  final String messageId;

  /// True when the worker wrote it; false when a payer did. Drives which side
  /// the bubble sits on.
  final bool fromWorker;
  final String text;
  final DateTime createdAt;

  factory InboxMessage.fromDto(RelayMessageDto dto) => InboxMessage(
        messageId: dto.messageId,
        fromWorker: dto.fromWorker,
        text: dto.text,
        createdAt: dto.createdAt,
      );

  @override
  List<Object?> get props =>
      <Object?>[messageId, fromWorker, text, createdAt];
}
