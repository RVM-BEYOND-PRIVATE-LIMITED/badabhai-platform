import 'package:equatable/equatable.dart';

/// One message in the "bada bhai" profiling chat. UI state (an ordered,
/// append-only transcript) — not an API shape, so it lives in the domain.
class ChatMessage extends Equatable {
  const ChatMessage({required this.text, required this.fromWorker});

  final String text;
  final bool fromWorker;

  @override
  List<Object?> get props => <Object?>[text, fromWorker];
}
