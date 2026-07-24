import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/chat_message.dart';
import '../domain/chat_repository.dart';
import '../domain/chat_turn.dart';

/// Strips the persona's `{{worker_name}}` vocative from a STORED outbound line.
///
/// The live POST /chat/message reply interpolates the worker's real name over
/// this slot server-side (post-store), but the transcript route returns the RAW
/// placeholder (chat.dto.ts) — and the client holds no name (§2), so it must
/// render name-less, exactly as the backend's own no-name fallback does. Removes
/// the token plus any immediately-following vocative (` ji, ` / `, ` / a space)
/// and trims the leading gap, so `"{{worker_name}} ji, Namaste"` → `"Namaste"`.
String _stripWorkerName(String text) => text
    .replaceAll(
      RegExp(r'\{\{\s*worker_name\s*\}\}\s*(ji)?[,\s]*', caseSensitive: false),
      '',
    )
    .trimLeft();

class ChatRepositoryImpl implements ChatRepository {
  ChatRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<String?> ensureSession() async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    if (_session.sessionId != null) return null; // already open
    try {
      final ChatSessionStart start = await _api.startSession(authToken: token);
      _session.setSession(start.sessionId);
      return start.openingText;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<ChatTurn> sendMessage(String text) async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();

    // SELF-HEAL (#343): this used to throw UnauthorizedFailure whenever
    // sessionId was null and never re-attempt, so ONE failed session-open — a
    // routine 2G timeout — made every later message throw forever. The worker
    // kept answering into a dead session with no error, and extraction then ran
    // against an empty transcript. Re-open lazily instead; ensureSession throws
    // a mapped Failure if it genuinely cannot, which the caller now surfaces.
    if (_session.sessionId == null) {
      await ensureSession();
    }

    final String? sessionId = _session.sessionId;
    if (sessionId == null) throw const UnauthorizedFailure();
    try {
      final ChatReply reply = await _api.sendMessage(
        sessionId: sessionId,
        authToken: token,
        text: text,
      );
      // Carry the backend's tap-to-answer suggestions through to the UI. A
      // blocked reply (pseudonymize fail-closed) arrives with an empty list.
      // `extractionReady` is the engine's interview-completeness decision
      // (#421) — it gates the "build my profile" CTA downstream.
      // `unansweredEssentials` (#478) drives the named "what's still missing"
      // helper; `blocked`/`isMock` drive the honesty cues (see [ChatTurn]).
      return ChatTurn(
        reply: reply.reply,
        followups: reply.suggestedFollowups,
        extractionReady: reply.extractionReady,
        unansweredEssentials: reply.unansweredEssentials,
        blocked: reply.blocked,
        isMock: reply.isMock,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<List<ChatMessage>> loadHistory() async {
    final String? token = _session.sessionToken;
    final String? sessionId = _session.sessionId;
    // No open session (or no bearer) → nothing to redraw. Best-effort: this must
    // never throw, or a hydration miss would block the chat from opening.
    if (token == null || sessionId == null) return const <ChatMessage>[];
    try {
      final List<SessionMessage> rows = await _api.listSessionMessages(
        sessionId: sessionId,
        authToken: token,
      );
      final List<ChatMessage> messages = <ChatMessage>[];
      for (final SessionMessage row in rows) {
        // A voice row before its transcript lands carries a null body — drop it
        // from the redraw rather than showing an empty bubble (hydration is a
        // best-effort redraw of a completed session, not a live pending view).
        final String? raw = row.bodyText;
        if (raw == null || raw.trim().isEmpty) continue;
        final String text = row.fromWorker ? raw : _stripWorkerName(raw);
        if (text.isEmpty) continue; // a name-only outbound line strips to empty
        messages.add(ChatMessage(text: text, fromWorker: row.fromWorker));
      }
      return messages;
    } catch (_) {
      // Swallow: a failed history read leaves the worker on the canned opener,
      // exactly as before #502 — never a crash, never a blocked chat.
      return const <ChatMessage>[];
    }
  }
}
