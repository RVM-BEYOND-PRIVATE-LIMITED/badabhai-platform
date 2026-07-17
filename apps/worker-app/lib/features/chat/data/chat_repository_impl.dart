import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/chat_repository.dart';
import '../domain/chat_turn.dart';

class ChatRepositoryImpl implements ChatRepository {
  ChatRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<void> ensureSession() async {
    final String? token = _session.sessionToken;
    if (token == null) throw const UnauthorizedFailure();
    if (_session.sessionId != null) return; // already open
    try {
      final String sessionId = await _api.startSession(authToken: token);
      _session.setSession(sessionId);
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
      return ChatTurn(reply: reply.reply, followups: reply.suggestedFollowups);
    } catch (error) {
      throw mapError(error);
    }
  }
}
