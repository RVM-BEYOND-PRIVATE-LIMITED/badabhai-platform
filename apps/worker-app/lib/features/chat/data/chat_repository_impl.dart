import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/observability/crash_reporter.dart';
import '../../../core/session/session_repository.dart';
import '../domain/chat_message.dart';
import '../domain/chat_repository.dart';
import '../domain/chat_turn.dart';

/// Reports a caught, NON-FATAL error to the app's observability sink.
///
/// A thin seam over [CrashReporter.recordNonFatal] so [ChatRepositoryImpl] can be
/// unit-tested for "this failure was LOGGED, not swallowed" without a live
/// Firebase (which makes `recordNonFatal` a no-op in tests). Production wiring
/// uses [_recordNonFatal]; a test injects a spy.
typedef NonFatalReporter = void Function(
  Object error,
  StackTrace stack, {
  required String reason,
});

/// Default [NonFatalReporter] — routes to the same crash/observability sink every
/// other caught error in the app uses. [reason] is a short, STATIC, PII-free key.
void _recordNonFatal(Object error, StackTrace stack, {required String reason}) =>
    CrashReporter.recordNonFatal(error, stack, reason: reason);

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

/// The Devanagari read-aloud script for a hydrated OUTBOUND bubble (#896), with
/// the same `{{worker_name}}` vocative stripped as the visible body. Null on an
/// older API build (no `tts_text`) or when the strip leaves nothing — read-aloud
/// then falls back to speaking the visible body text.
String? _hydratedTts(String? raw) {
  if (raw == null || raw.trim().isEmpty) return null;
  final String stripped = _stripWorkerName(raw);
  return stripped.isEmpty ? null : stripped;
}

class ChatRepositoryImpl implements ChatRepository {
  ChatRepositoryImpl(
    this._api,
    this._session, {
    NonFatalReporter reportNonFatal = _recordNonFatal,
  }) : _report = reportNonFatal;

  final ApiClient _api;
  final SessionRepository _session;
  final NonFatalReporter _report;

  /// The open-session call currently in flight, or null when none is (#1198).
  ///
  /// The `_session.sessionId != null` short-circuit only fences a SECOND entry
  /// once the FIRST has already stored an id — it does nothing during the window
  /// where the first open is still awaiting the network. A fast double entry in
  /// that window (e.g. `ChatStarted` racing the lazy re-open inside [sendMessage],
  /// which bloc 8.x runs concurrently) would otherwise fire two `POST /chat/session`
  /// and mint two sessions. Memoising the in-flight future makes concurrent callers
  /// await the SAME open, so exactly one session is minted. Cleared on completion
  /// so a later entry (or a self-heal after a failed open) starts fresh.
  Future<String?>? _inFlightOpen;

  @override
  Future<String?> ensureSession() async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    if (_session.sessionId != null) return null; // already open (in-memory)
    // In-flight guard (#1198): kept `async` so the synchronous throw above
    // surfaces as a rejected future (the callers await it). No `await` runs
    // between the checks above and this assignment, so two concurrent callers
    // cannot both pass it — the second reuses the first's in-flight future and
    // only ONE `_openSession` (hence one `POST /chat/session`) runs.
    return _inFlightOpen ??=
        _openSession(token).whenComplete(() => _inFlightOpen = null);
  }

  /// Resumes the worker's latest session, or opens a new one. Wrapped so any
  /// transport error becomes a mapped [Failure] for the caller.
  Future<String?> _openSession(String token) async {
    try {
      // RESUME the worker's latest session before opening a new one. The session
      // id lives in memory only, so after a cold restart (or opening the "Bada
      // Bhai" tab later) it is null even though the signup profiling session — and
      // its whole Q&A — is still server-side. Re-attaching to it means
      // [loadHistory] redraws that transcript instead of a fresh empty thread, and
      // any further chat appends to the SAME session. A resume serves no opener
      // (the client renders its canned greeting, then the history redraw follows).
      final String? latest = await _resumeLatest(token);
      if (latest != null) {
        _session.setSession(latest);
        return null;
      }
      final ChatSessionStart start = await _api.startSession(authToken: token);
      // An old-build POST that returns the worker's EXISTING session (once the
      // backend reattach guard, #1197, ships) carries no `opening_text`, so
      // [ChatSessionStart.openingText] is null and the caller keeps its canned
      // greeting — no re-greet, no regression.
      _session.setSession(start.sessionId);
      return start.openingText;
    } catch (error) {
      throw mapError(error);
    }
  }

  /// `GET /chat/session/latest` with ONE retry (#1198).
  ///
  /// Resume is an optimisation, never a gate, so a failure must never BLOCK the
  /// chat — but it must not be SWALLOWED either. The old code caught-and-dropped
  /// silently, so a routine 2G timeout or a 5xx fell straight through to
  /// `POST /chat/session`, minting a FRESH session and orphaning the worker's
  /// whole signup Q&A. Now: try once, retry once, and only if BOTH attempts fail
  /// map the error to the app's [Failure] type, LOG it as a non-fatal through the
  /// same sink every other caught error uses (never a raw print, never PII), and
  /// return null so the caller falls through to opening a new session.
  ///
  /// A `null` result (the worker simply has no prior session) is NOT a failure —
  /// it returns immediately and the caller opens a new session.
  Future<String?> _resumeLatest(String token) async {
    for (int attempt = 0; attempt < 2; attempt++) {
      try {
        return await _api.latestChatSessionId(authToken: token);
      } catch (error, stack) {
        if (attempt == 1) {
          _report(
            mapError(error),
            stack,
            reason: 'chat_resume_latest_failed',
          );
          return null;
        }
        // First attempt failed — fall round the loop for the single retry.
      }
    }
    return null;
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
        // adds the key conditionally. Both callers now pass one (chat composer +
        // the voice-merge path, #944); a null would simply be omitted.
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
        // #896 — the Devanagari read-aloud script for THIS reply; null on an
        // older API build, and read-aloud then speaks the romanized reply.
        ttsText: reply.ttsText,
        // #761 — carried for the optimistic-lookahead reconcile in ChatBloc:
        // asked_question_id attributes THIS turn, lookahead predicts the next.
        askedQuestionId: reply.askedQuestionId,
        lookahead: reply.lookahead,
        // #1339/#1340 — the handover card's data, null on every ordinary turn.
        formOffer: reply.formOffer,
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
        messages.add(ChatMessage(
          text: text,
          fromWorker: row.fromWorker,
          // #896 — the Devanagari read-aloud script rides the BOT bubble only;
          // a worker bubble leaves it null. Strip the {{worker_name}} vocative
          // exactly as the body is stripped (the client holds no name, §2), and
          // treat a name-only strip as absent → read-aloud falls back to `text`.
          ttsText: row.fromWorker ? null : _hydratedTts(row.ttsText),
        ));
      }
      return messages;
    } catch (_) {
      // Swallow: a failed history read leaves the worker on the canned opener,
      // exactly as before #502 — never a crash, never a blocked chat.
      return const <ChatMessage>[];
    }
  }
}
