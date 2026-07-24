import 'chat_message.dart';
import 'chat_turn.dart';

/// Chat boundary for the profiling conversation. Implementations read the
/// session token / session id from the session (never the widget) and throw a
/// [Failure] on error.
abstract interface class ChatRepository {
  /// Ensures a chat session exists (starts one if needed) and stores its id in
  /// the session. No-op when a session is already open.
  ///
  /// Returns the server-served one-shot opener when this call actually OPENED a
  /// session and the API supplied one; null otherwise — including on the
  /// already-open no-op path and on the lazy re-open inside [sendMessage], where
  /// the worker is mid-conversation and re-greeting them would be wrong.
  Future<String?> ensureSession();

  /// Sends [text] and returns bada bhai's reply plus any tap-to-answer
  /// [ChatTurn.followups].
  Future<ChatTurn> sendMessage(String text);

  /// The persisted transcript for the CURRENT session, oldest-first, as
  /// redrawable bubbles (#502 transcript hydration). Empty when there is no open
  /// session or the session has no stored turns yet (a brand-new chat) — the
  /// caller then leaves its opener untouched. BEST-EFFORT: implementations
  /// return `[]` rather than throw, so a hydration miss can never block the chat
  /// from opening.
  Future<List<ChatMessage>> loadHistory();
}
