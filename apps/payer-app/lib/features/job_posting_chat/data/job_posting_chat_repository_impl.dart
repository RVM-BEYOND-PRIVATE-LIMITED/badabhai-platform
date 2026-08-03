import '../../../core/data/job_posting_chat_models.dart';
import '../../../core/data/models.dart';
import '../../../core/data/payer_api_client.dart';
import '../domain/job_posting_chat_repository.dart';

/// [JobPostingChatRepository] over the single [PayerApiClient] seam — so MOCK
/// (`USE_MOCKS=true`, widget tests) and REAL both work with no branch here.
///
/// Owns the session id for the life of one chat. It is NEVER read from a widget
/// and NEVER sent as a `payer_id` — the server derives the payer from the
/// bearer (ADR-0019 / the never-trust-body-IDs rule).
class JobPostingChatRepositoryImpl implements JobPostingChatRepository {
  JobPostingChatRepositoryImpl(this._api);

  final PayerApiClient _api;

  String? _sessionId;

  @override
  String? get sessionId => _sessionId;

  @override
  Future<JobPostingChatTurn?> openSession() async {
    // Already bound (a resumed session, or a second mount) → no-op. Opening a
    // second session would strand the payer's answers in the first one.
    if (_sessionId != null) return null;
    final JobPostingChatTurn turn = await _api.startJobPostingChatSession();
    _sessionId = turn.sessionId;
    return turn;
  }

  @override
  void resumeSession(String id) {
    if (id.isEmpty) return;
    _sessionId = id;
  }

  @override
  Future<JobPostingChatTurn> sendMessage(String text) async {
    // SELF-HEAL (the worker chat's #343 lesson): a single failed session-open
    // must not make every later message throw forever. Re-open lazily instead;
    // openSession throws if it genuinely cannot, which the bloc surfaces.
    if (_sessionId == null) await openSession();
    final String? id = _sessionId;
    if (id == null) throw const PayerApiException(401);
    return _api.sendJobPostingChatMessage(sessionId: id, text: text);
  }

  @override
  Future<JobPostingChatTranscript?> loadTranscript() async {
    final String? id = _sessionId;
    if (id == null) return null;
    try {
      return await _api.fetchJobPostingChatTranscript(id);
    } catch (_) {
      // Swallow: a failed hydration leaves the payer on the opener, exactly as
      // a brand-new chat would. Never a crash, never a blocked chat.
      return null;
    }
  }

  @override
  Future<List<JobPostingChatSessionSummary>> listSessions() =>
      _api.fetchJobPostingChatSessions();

  @override
  Future<PublishJobResult> publish() async {
    final String? id = _sessionId;
    if (id == null) throw const PayerApiException(400);
    // Pass the full result through — the id the caller routes to PLUS any
    // fields the server could not fold onto the live posting, which the chat
    // surfaces as a non-blocking honesty notice.
    return _api.publishJobPostingChatSession(id);
  }
}
