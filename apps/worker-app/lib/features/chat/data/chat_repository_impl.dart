import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/chat_repository.dart';

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
  Future<String> sendMessage(String text) async {
    final String? token = _session.sessionToken;
    final String? sessionId = _session.sessionId;
    if (token == null || sessionId == null) throw const UnauthorizedFailure();
    try {
      final ChatReply reply = await _api.sendMessage(
        sessionId: sessionId,
        authToken: token,
        text: text,
      );
      return reply.reply;
    } catch (error) {
      throw mapError(error);
    }
  }
}
