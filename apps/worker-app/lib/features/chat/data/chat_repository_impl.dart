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
    if (_session.sessionId != null) return null; // already open (in-memory)
    try {
      // RESUME the worker's latest session before opening a new one. The session
      // id lives in memory only, so after a cold restart (or opening the "Bada
      // Bhai" tab later) it is null even though the signup profiling session — and
      // its whole Q&A — is still server-side. Re-attaching to it means
      // [loadHistory] redraws that transcript instead of a fresh empty thread, and
      // any further chat appends to the SAME session. A resume serves no opener
      // (the client renders its canned greeting, then the history redraw follows).
      // Best-effort: a failed lookup falls through to opening a new session rather
      // than blocking the chat.
      try {
        final String? latest = await _api.latestChatSessionId(authToken: token);
        if (latest != null) {
          _session.setSession(latest);
          return null;
        }
      } catch (_) {
        // Swallow: resume is an optimisation, never a gate — fall through to open.
      }
      final ChatSessionStart start = await _api.startSession(authToken: token);
      _session.setSession(start.sessionId);
      return start.openingText;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<ChatTurn> sendMessage(String text, {String? submissionId}) async {
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
        // #870 — rides the /chat/message body only when non-null; the api client
        // adds the key conditionally, so a null (the voice-merge path) is absent.
        submissionId: submissionId,
      );
      // Carry the backend's tap-to-answer suggestions through to the UI. A
      // blocked reply (pseudonymize fail-closed) arrives with an empty list.
      // `extractionReady` is the engine's interview-completeness decision
      // (#421) — it gates the "build my profile" CTA downstream.
      // `unansweredEssentials` (#478) drives the named "what's still missing"
      // helper; `blocked`/`isMock` drive the honesty cues (see [ChatTurn]).
      // The interview is over and the server has flushed it. FORGET the session id so
      // the next entry into chat opens a fresh one instead of posting into a session
      // that can only ever reply "Aapki baat poori ho chuki hai".
      //
      // Done HERE, not in the bloc, because the cached id lives in SessionRepository and
      // every entry point goes through `ensureSession()` — the "start a new chat" button
      // on the Resume/Profile tabs, and the "Chat pe wapas jaayein" the profile preview
      // offers when a profile comes out thin. Leaving it cached silently disables both:
      // the app tells the worker to go say more, and they cannot.
      //
      // The worker stays logged in — only the chat session id is dropped.
      if (reply.sessionEnded) {
        _session.clearChatSession();
      }
      return ChatTurn(
        reply: reply.reply,
        followups: reply.suggestedFollowups,
        // #761 — the option objects carry the stable option_key the client keys
        // `lookahead` by; served alongside the followups (the display labels).
        suggestedOptions: reply.suggestedOptions,
        extractionReady: reply.extractionReady,
        unansweredEssentials: reply.unansweredEssentials,
        blocked: reply.blocked,
        isMock: reply.isMock,
        progress: reply.progress,
        questionKind: reply.questionKind,
        inputMode: reply.inputMode,
        occupationLabel: reply.occupationLabel,
        // #761 — carried for the optimistic-lookahead reconcile in ChatBloc:
        // asked_question_id attributes THIS turn, lookahead predicts the next.
        askedQuestionId: reply.askedQuestionId,
        lookahead: reply.lookahead,
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
