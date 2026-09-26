import 'chat_message.dart';
import 'chat_session_opening.dart';
import 'chat_turn.dart';

/// Chat boundary for the profiling conversation. Implementations read the
/// session token / session id from the session (never the widget) and throw a
/// [Failure] on error.
abstract interface class ChatRepository {
  /// Ensures a chat session exists (starts one if needed) and stores its id in
  /// the session. No-op when a session is already open.
  ///
  /// Returns the server-served opening when this call actually OPENED a session
  /// and the API supplied one — the ordinary one-shot opener OR the résumé-confirm
  /// first turn (#1523); null otherwise, including on the already-open no-op path
  /// and on the lazy re-open inside [sendMessage], where the worker is
  /// mid-conversation and re-greeting them would be wrong. A null keeps the
  /// client's canned `kChatOpeningText` opener.
  Future<ChatSessionOpening?> ensureSession();

  /// Mint a GENUINELY NEW session, bypassing the `GET /session/latest` resume
  /// (#1566). The post-completion menu's "Chat se resume banayein" must open a
  /// fresh interview, and the resume-first guard in [ensureSession] would
  /// otherwise re-attach to the just-ended session (the server reattaches to a
  /// LIVE session only, but the client never asks). The prior session and its
  /// transcript are preserved server-side; only the cached id is replaced.
  ///
  /// Returns the server-served opening when the new session supplies one (the
  /// one-shot opener), else null — the caller then renders the canned opener,
  /// exactly like an ordinary open.
  Future<ChatSessionOpening?> startNewSession();

  /// Sends [text] and returns bada bhai's reply plus any tap-to-answer
  /// [ChatTurn.followups].
  ///
  /// [submissionId] is the per-submission id (#870), forwarded to the wire body
  /// when non-null. Minted once per physical send and re-sent verbatim on a
  /// retry, so the server can tell a retried POST from a worker repeating the
  /// same words. Both callers now supply one — the chat composer (#870) and the
  /// voice-merge path (#944); it stays optional so the contract does not force it.
  Future<ChatTurn> sendMessage(String text, {String? submissionId});

  /// The persisted transcript for the CURRENT session, oldest-first, as
  /// redrawable bubbles (#502 transcript hydration). Empty when there is no open
  /// session or the session has no stored turns yet (a brand-new chat) — the
  /// caller then leaves its opener untouched. BEST-EFFORT: implementations
  /// return `[]` rather than throw, so a hydration miss can never block the chat
  /// from opening.
  Future<List<ChatMessage>> loadHistory();

  /// ADR-0044 — the post-completion COMPANION's opening recap, or null.
  ///
  /// Null means "run today's chat": the worker is not a companion worker, the
  /// server flag is off, the server predates the route (404), the network failed,
  /// or the body was malformed. BEST-EFFORT like [loadHistory]: implementations
  /// never throw, so the tab can never be blocked by the companion.
  ///
  /// NEVER opens, resumes or mints a chat session: a companion worker has no
  /// interview in flight, and minting one here is exactly the bug this fixes for
  /// workers whose profile came from a form.
  Future<ChatTurn?> openCompanion();

  /// ADR-0044 — one companion answer (`POST /chat/companion/message`), with
  /// [ChatTurn.companion] set. Null when the server answers 409 (this worker is
  /// no longer in companion mode — a new interview went live, or the flag was
  /// turned off); the caller then sends the same text down [sendMessage].
  /// Throws a [Failure] on any other error, like [sendMessage].
  Future<ChatTurn?> sendCompanionMessage(String text, {String? submissionId});
}
