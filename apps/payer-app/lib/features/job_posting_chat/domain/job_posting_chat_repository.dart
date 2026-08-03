import '../../../core/data/job_posting_chat_models.dart';
import '../../../core/data/models.dart';

/// The chat boundary for the AI job-posting conversation (ADR-0035).
///
/// Implementations hold the session id themselves (the widget never passes one)
/// and let transport failures through as a [PayerApiException] or a plain throw
/// — the bloc surfaces them, never swallows them.
abstract interface class JobPostingChatRepository {
  /// The session currently bound to this repository, or null before
  /// [openSession] / [resumeSession] has succeeded.
  String? get sessionId;

  /// Opens a NEW chat session and binds it, returning the engine's opening turn
  /// (reply + chips + any seeded draft). Returns null when a session is already
  /// bound — a second open would strand the payer's answers in the first one.
  Future<JobPostingChatTurn?> openSession();

  /// Binds an EXISTING session by id — the cross-device pickup path. Does no
  /// network call by itself; [loadTranscript] then hydrates it.
  void resumeSession(String id);

  /// Sends [text] as the payer's turn and returns the engine's next turn.
  Future<JobPostingChatTurn> sendMessage(String text);

  /// Full hydration of the bound session: transcript (oldest-first) PLUS the
  /// current draft, the engine's readiness decision and the live chips — which
  /// is what lets a resumed chat show the draft with no extra message.
  ///
  /// BEST-EFFORT: returns null rather than throwing, so a hydration miss can
  /// never block the chat from opening. A neutral 404 (unknown OR not-owned) is
  /// indistinguishable from "no history" by design.
  Future<JobPostingChatTranscript?> loadTranscript();

  /// This payer's resumable sessions, newest-activity first — the cross-device
  /// "continue where you left off" list.
  Future<List<JobPostingChatSessionSummary>> listSessions();

  /// Publishes the bound session's draft through the existing job-posting create
  /// path. Returns the [PublishJobResult] — the created posting's id PLUS any
  /// collected fields the server could not fold onto the live posting, which the
  /// chat surfaces as a non-blocking honesty notice. Throws [PayerApiException]
  /// on 400 (draft incomplete) / 409 (already published or not ready) / 404.
  Future<PublishJobResult> publish();
}
