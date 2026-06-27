import 'session.dart';

/// The single in-memory source of truth for the worker's cross-feature session
/// state — replaces the old global `AppState` singleton.
///
/// Registered as a get_it lazySingleton (one instance app-wide). It is a passive
/// value holder, NOT a ChangeNotifier/Cubit: no widget rebuilds off it (nothing
/// ever listened to the old AppState either), so a reactive holder would be
/// gold-plating. Repositories read its synchronous getters and write through its
/// mutators; the real [ApiClient]'s rolling-refresh callback writes
/// [setSessionToken] (wired in DI). Token stays in memory only — never logged or
/// persisted.
class SessionRepository {
  Session _session = const Session();

  Session get current => _session;

  String? get phoneE164 => _session.phoneE164;
  String? get workerId => _session.workerId;
  String? get sessionToken => _session.sessionToken;
  String? get sessionId => _session.sessionId;
  String? get profileId => _session.profileId;
  String? get resumeId => _session.resumeId;

  void setWorker({
    required String phone,
    required String workerId,
    String? sessionToken,
  }) {
    _session = _session.copyWith(
      phoneE164: phone,
      workerId: workerId,
      sessionToken: sessionToken,
    );
  }

  /// Replaces the in-memory bearer token. Wired to the [ApiClient]'s
  /// `onSessionTokenRefreshed` so a fresh `x-session-token` keeps the session
  /// alive without a separate refresh call.
  void setSessionToken(String token) {
    _session = _session.copyWith(sessionToken: token);
  }

  void setSession(String sessionId) {
    _session = _session.copyWith(sessionId: sessionId);
  }

  void setProfile(String profileId) {
    _session = _session.copyWith(profileId: profileId);
  }

  void setResume(String resumeId) {
    _session = _session.copyWith(resumeId: resumeId);
  }

  /// Wipes all in-memory session state on logout — token, ids, and the transient
  /// phone. Resets to a fresh empty [Session] so every getter returns null and
  /// the next login starts clean. This holder is a passive value object (not a
  /// ChangeNotifier — nothing listens to it), so there is no notify to fire; the
  /// logout flow navigates back to the login route explicitly.
  void clear() {
    _session = const Session();
  }
}
