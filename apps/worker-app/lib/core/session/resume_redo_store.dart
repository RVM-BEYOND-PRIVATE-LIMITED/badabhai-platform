import 'package:shared_preferences/shared_preferences.dart';

/// Which chat session is a RE-DO of a résumé the worker already built.
///
/// "Chat se resume banayein" (the post-completion résumé menu) mints a new chat
/// session for a worker who already has a résumé. When that chat hands over to
/// the form, the form must open from the FIRST question with nothing selected —
/// otherwise it resumes on the last question of the résumé being replaced, at
/// 100%, with only "Submit karein" left to press.
///
/// WHY THIS IS PERSISTED and not just held by the chat: the hand-over can come
/// after the app was closed and reopened, and a re-do that forgot it was a re-do
/// would open exactly the broken form it exists to prevent.
///
/// SCOPED BY SESSION ID: only the session that was minted for the re-do is one.
/// Any later session — a normal interview, a second re-do — is judged on its
/// own id, so a stale mark can never blank an unrelated form.
///
/// Best-effort like the other session stores: every method swallows a plugin
/// error. A miss only costs the re-do its blank form, which is what the app did
/// before this existed. Cleared on logout so the next worker on a shared phone
/// starts clean.
abstract interface class ResumeRedoStore {
  /// Records [sessionId] as a re-do session. NEVER throws.
  Future<void> markRedo(String sessionId);

  /// Whether [sessionId] is the re-do session. NEVER throws.
  Future<bool> isRedo(String? sessionId);

  /// Forgets it. NEVER throws.
  Future<void> clear();
}

/// [ResumeRedoStore] over `shared_preferences`, resolved lazily per call so
/// registering it never touches the platform channel.
class SharedPrefsResumeRedoStore implements ResumeRedoStore {
  const SharedPrefsResumeRedoStore({
    Future<SharedPreferences> Function() prefs = SharedPreferences.getInstance,
  }) : _prefs = prefs;

  final Future<SharedPreferences> Function() _prefs;

  /// `bb_`-prefixed to match the existing key convention.
  static const String kRedoSessionKey = 'bb_resume_redo_session';

  @override
  Future<void> markRedo(String sessionId) async {
    if (sessionId.isEmpty) return;
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.setString(kRedoSessionKey, sessionId);
    } catch (_) {
      // Best-effort: a lost mark only costs the re-do its blank form.
    }
  }

  @override
  Future<bool> isRedo(String? sessionId) async {
    if (sessionId == null || sessionId.isEmpty) return false;
    try {
      final SharedPreferences prefs = await _prefs();
      return prefs.getString(kRedoSessionKey) == sessionId;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> clear() async {
    try {
      final SharedPreferences prefs = await _prefs();
      await prefs.remove(kRedoSessionKey);
    } catch (_) {
      // Best-effort: a teardown failure must never block sign-out.
    }
  }
}

/// In-memory [ResumeRedoStore]: the seam unit tests inject.
class InMemoryResumeRedoStore implements ResumeRedoStore {
  String? _sessionId;

  @override
  Future<void> markRedo(String sessionId) async {
    if (sessionId.isEmpty) return;
    _sessionId = sessionId;
  }

  @override
  Future<bool> isRedo(String? sessionId) async =>
      sessionId != null && sessionId.isNotEmpty && sessionId == _sessionId;

  @override
  Future<void> clear() async => _sessionId = null;
}
