import 'chat_turn.dart';

/// Chat boundary for the profiling conversation. Implementations read the
/// session token / session id from the session (never the widget) and throw a
/// [Failure] on error.
abstract interface class ChatRepository {
  /// Ensures a chat session exists (starts one if needed) and stores its id in
  /// the session. No-op when a session is already open.
  Future<void> ensureSession();

  /// Sends [text] and returns bada bhai's reply plus any tap-to-answer
  /// [ChatTurn.followups].
  Future<ChatTurn> sendMessage(String text);
}
