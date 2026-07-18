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
  DateTime? get deletionScheduledFor => _session.deletionScheduledFor;

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

  /// Drops ONLY the bearer, keeping the worker/session ids (#368).
  ///
  /// The re-lock fence: [AuthSessionManager.relock] nulls the AuthedClient's
  /// copy of the access token, but THIS is the bearer every legacy ApiClient
  /// call actually sends. Leaving it meant a request queued just before the app
  /// paused still authenticated happily behind the PIN screen — contradicting
  /// relock's own "no authed call slips through while locked".
  ///
  /// Cannot be done with copyWith, which resolves `?? this.sessionToken` and so
  /// can never null a field. The ids stay: unlockWithPin re-bridges a fresh
  /// token onto the same worker, and the chat session must survive the lock.
  ///
  /// EVERY non-token field must be carried forward explicitly — the raw
  /// constructor is the ONLY place that can silently drop one, and omitting
  /// `deletionScheduledFor` here destroyed the ADR-0031 pending-deletion flag on
  /// every re-lock. `_syncDeletionState` re-reads it from `/auth/me` on unlock and
  /// so hid the bug on a good connection, but its documented contract is to leave
  /// a known-pending flag untouched when that read FAILS — and by then the value
  /// was already gone. The worker then lost the "Delete cancel karein" affordance
  /// (account_delete_cubit reads this field alone, with no server fallback) for the
  /// rest of the session, inside a 7-day window that ends in irreversible deletion.
  void clearSessionToken() {
    _session = Session(
      phoneE164: _session.phoneE164,
      workerId: _session.workerId,
      sessionId: _session.sessionId,
      profileId: _session.profileId,
      resumeId: _session.resumeId,
      deletionScheduledFor: _session.deletionScheduledFor,
    );
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

  /// Records — or clears, with null — the pending account-deletion due time
  /// (ADR-0031 grace window). Written from the OTP-verify login response (the
  /// server flag is authoritative, including clearing a stale one) and by the
  /// delete confirm/cancel flows. Rebuilt explicitly rather than via [Session.copyWith]
  /// so a null CLEARS the flag instead of being swallowed by `??`.
  void setDeletionScheduledFor(DateTime? scheduledFor) {
    _session = Session(
      phoneE164: _session.phoneE164,
      workerId: _session.workerId,
      sessionToken: _session.sessionToken,
      sessionId: _session.sessionId,
      profileId: _session.profileId,
      resumeId: _session.resumeId,
      deletionScheduledFor: scheduledFor,
    );
  }

  /// Wipes all in-memory session state on logout — token, ids, the transient
  /// phone, and the pending-deletion flag. Resets to a fresh empty [Session]
  /// so every getter returns null and
  /// the next login starts clean. This holder is a passive value object (not a
  /// ChangeNotifier — nothing listens to it), so there is no notify to fire; the
  /// logout flow navigates back to the login route explicitly.
  void clear() {
    _session = const Session();
  }
}
