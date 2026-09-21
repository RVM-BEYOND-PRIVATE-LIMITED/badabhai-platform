import '../../../core/api/api_client.dart' show ApiClient;
import '../../../core/api/api_models.dart' show RelayMessageDto, RelayThreadDto;
import '../../../core/error/failure_mapper.dart';
import '../../../core/error/failure.dart';
import '../../../core/session/session_repository.dart';
import '../domain/inbox_models.dart';
import '../domain/inbox_repository.dart';

/// Live [InboxRepository] over [ApiClient] (E0 relay, FE #1628).
///
/// No business rule lives here — the repository only maps the wire to the
/// feature's models and translates errors to a typed [Failure]. The worker id
/// is the session's; it is never a parameter.
class InboxRepositoryImpl implements InboxRepository {
  InboxRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  @override
  Future<List<InboxThread>> threads() async {
    final String token = _requireToken();
    try {
      final List<RelayThreadDto> rows = await _api.getRelayThreads(
        authToken: token,
      );
      return rows.map(InboxThread.fromDto).toList();
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<List<InboxMessage>?> thread(String unlockId) async {
    final String token = _requireToken();
    try {
      final List<RelayMessageDto>? rows = await _api.getRelayThread(
        authToken: token,
        unlockId: unlockId,
      );
      return rows?.map(InboxMessage.fromDto).toList();
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<bool> reply(String unlockId, String text) async {
    final String token = _requireToken();
    try {
      return await _api.sendRelayReply(
        authToken: token,
        unlockId: unlockId,
        text: text,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> markRead(String unlockId) async {
    final String token = _requireToken();
    try {
      await _api.markRelayThreadRead(authToken: token, unlockId: unlockId);
    } catch (error) {
      throw mapError(error);
    }
  }
}
