import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../../core/auth/auth_api.dart';
import '../../../core/auth/auth_failure.dart';
import '../../../core/auth/reauth_signal.dart';
import '../../../core/auth/secure_token_store.dart';
import '../../../core/config/app_config.dart';
import '../../../core/observability/crash_reporter.dart';
import '../../../core/session/session_repository.dart';

/// The three states the whole app is ever in, from the router's point of view.
///
///  - [loggedOut] — no remembered worker; must start at phone login.
///  - [locked] — a refresh token is remembered but the app is locked; must
///    enter the PIN (the fast path on every cold start / re-lock).
///  - [authenticated] — unlocked, fresh tokens in hand; the shell is reachable.
enum AuthStatus { loggedOut, locked, authenticated }

/// The single source of truth for "am I logged in / locked", exposed as a
/// [Listenable] so go_router can drive its `redirect` off it
/// (`refreshListenable`).
///
/// It owns the persistent-auth orchestration on top of PASS 1's pieces:
///  - reads the [SecureTokenStore] on [bootstrap] to decide the cold-start state,
///  - runs the OTP / PIN / refresh / logout flows through [AuthApi],
///  - and — critically — BRIDGES every fresh access token into the existing
///    [SessionRepository] (`sessionToken` + `workerId`) so the app's
///    worker-scoped calls (chat / feed / resume), which still read
///    `SessionRepository.sessionToken` as their bearer, keep working unchanged.
///    This bridge is what fixes "the app forgets me": after a PIN unlock the
///    SessionRepository is repopulated from the refreshed tokens, so the worker
///    stays logged in and skips re-profiling.
///
/// The PIN gate (lock / unlock / cold-start lock / re-lock) and token persistence
/// across restarts are active whenever [persistentAuthEnabled] is true — which is
/// the DEFAULT in every build (`kPersistentAuth` = `kUseMocks ||
/// bool.fromEnvironment('PERSISTENT_AUTH', defaultValue: true)`, app_config.dart),
/// now that the ADR-0026 backend contract is live. So the DEFAULT cold start is
/// bootstrap → locked → [unlockWithPin] → authenticated; the OTP path is only the
/// FIRST login on a device.
///
/// The layer is OFF only when a build explicitly passes
/// `--dart-define=PERSISTENT_AUTH=false` (and never in mock mode, where it is
/// forced on). With it OFF, [bootstrap] always starts at phone login, OTP success
/// goes straight to authenticated, and [relock] is a no-op (there is no persisted
/// refresh token to unlock against). Note: `kPersistentAuth` is false under a
/// plain `flutter test` (no dart-define), so tests that walk the PIN flow must
/// pass `persistentAuthEnabled: true` explicitly.
///
/// Every path that reaches [AuthStatus.authenticated] must leave the SAME
/// observable state, including the ADR-0031 pending-deletion flag — see
/// [_syncDeletionState]. Anything that resumes a session without it would strand
/// a worker mid-grace with no way to reach "cancel".
///
/// SECURITY: the refresh token + device id live only in [SecureTokenStore]
/// (Keystore-backed); the access token is in memory only; the PIN is NEVER held
/// here — it is passed straight through to [AuthApi] and dropped. Nothing here
/// logs a token.
class AuthSessionManager extends ChangeNotifier {
  AuthSessionManager({
    required AuthApi authApi,
    required SecureTokenStore tokenStore,
    required SessionRepository session,
    required ReauthSignal reauthSignal,
    bool persistentAuthEnabled = kPersistentAuth,
  })  : _authApi = authApi,
        _tokenStore = tokenStore,
        _session = session,
        _reauthSignal = reauthSignal,
        _persistentAuthEnabled = persistentAuthEnabled {
    // A dead session (refresh failure / reuse / device revoke) bounces the
    // worker back to a fresh OTP login. PASS 1's interceptor already cleared the
    // store before firing, so we only flip the status + clear the bridge.
    _reauthSub = _reauthSignal.stream.listen((_) => _onReauthRequired());
  }

  final AuthApi _authApi;
  final SecureTokenStore _tokenStore;
  final SessionRepository _session;
  final ReauthSignal _reauthSignal;
  final bool _persistentAuthEnabled;

  /// Whether the PIN / cold-start-lock / re-lock layer is active. Exposed so the
  /// lifecycle observer / router can skip lock UX when the layer is off.
  bool get persistentAuthEnabled => _persistentAuthEnabled;

  StreamSubscription<void>? _reauthSub;

  AuthStatus _status = AuthStatus.loggedOut;
  AuthStatus get status => _status;

  /// TD62 — the DPDP consent signal riding the OTP/PIN verify responses.
  ///
  /// TRI-STATE by design: `true`/`false` when the server sent a definitive
  /// `consent_accepted`; `null` when unknown (old server without the field, or
  /// no login yet). The router forces `/consent` ONLY on a definitive `false` —
  /// null passes through, so an older API can never brick routing.
  bool? _consentAccepted;
  bool? get consentAccepted => _consentAccepted;

  /// Marks consent as accepted CLIENT-SIDE right after a successful
  /// `consent.accepted` submit (ConsentCubit), so the router's consent gate
  /// releases without waiting for a re-login. Notifies the router's
  /// `refreshListenable` on change.
  void markConsentAccepted() {
    if (_consentAccepted == true) return;
    _consentAccepted = true;
    notifyListeners();
  }

  /// Set true once [bootstrap] has resolved the cold-start state, so the router
  /// can hold on splash until the secure store has been read exactly once.
  bool _ready = false;
  bool get isReady => _ready;

  /// Whether this device has a PIN to unlock WITH (#352).
  ///
  /// [AuthStatus.locked] alone cannot tell "enter your PIN" apart from "choose
  /// your first PIN": a brand-new worker is locked between OTP verify and
  /// setPin. Persisted (SecureTokenStore `pin_set`, wiped by `clear()`) so a
  /// cold start knows the difference — without it, a worker who killed the app
  /// on the Set-PIN screen restarted into Enter-PIN and was asked for a PIN that
  /// never existed, with no way out but the forgot-PIN OTP.
  ///
  /// Server-sourced: written from `OtpVerifyResult.pinSet`, never a client
  /// guess.
  bool _pinSet = false;
  bool get pinSet => _pinSet;

  /// Where the worker was when the app re-locked, so unlocking returns them
  /// there instead of dumping them on the Resume tab (#349).
  ///
  /// Relock replaces the whole stack from ANY location, and post-unlock routing
  /// used to hardcode Routes.resume. A worker 10 questions into the profiling
  /// chat who took a >5-minute phone call came back to "Abhi resume nahi ban
  /// sakta", with consent + name to re-tap and no visible transcript — it looked
  /// like everything they had said was lost.
  ///
  /// PEEK + explicit [clearResumeLocation], not a consuming take: the router
  /// redirect and EnterPinScreen both resolve the post-unlock target, and a
  /// consuming read would let whichever ran first strand the other on the
  /// fallback. Cleared once the worker has actually landed off the auth surface.
  ///
  /// Deliberately does NOT notifyListeners — it is written from inside the
  /// router's redirect, and notifying there would re-enter it.
  String? _resumeLocation;
  String? get resumeLocation => _resumeLocation;

  /// The ADR-0026 session block from the last OTP/PIN verify or refresh (F5).
  ///
  /// Parsed and retained rather than dropped on the floor. [requiresOtpAfter] is
  /// the useful part: the server states when a refresh/PIN will STOP being
  /// enough, so the app can pre-empt a forced re-OTP instead of finding out by
  /// being rejected mid-action. Null on an older server that omits the block —
  /// callers must treat null as "unknown", never as "never".
  AuthSession? _authSession;
  AuthSession? get authSession => _authSession;

  /// When a full OTP re-login becomes mandatory, or null if unknown/not
  /// scheduled. Convenience over [authSession].
  DateTime? get requiresOtpAfter => _authSession?.requiresOtpAfter;

  /// Absolute expiry of the persisted refresh token, or null when the server did
  /// not say. Past it, the remembered device cannot silently re-auth.
  DateTime? _refreshExpiresAt;
  DateTime? get refreshExpiresAt => _refreshExpiresAt;

  void stashResumeLocation(String location) => _resumeLocation = location;

  void clearResumeLocation() => _resumeLocation = null;

  void _setStatus(AuthStatus next) {
    if (_status == next && _ready) return;
    _status = next;
    _ready = true;
    notifyListeners();
  }

  /// App open (cold start): read the persisted refresh token. Present → [locked]
  /// (needs PIN); absent → [loggedOut] (needs phone). Never auto-unlocks: a
  /// remembered device always goes through the PIN, never straight to the shell.
  ///
  /// With the persistent-auth layer OFF (only via an explicit
  /// `--dart-define=PERSISTENT_AUTH=false`; it is ON by default) there is no
  /// persisted refresh token and no PIN gate, so the app always starts at phone
  /// login — exactly as on main. We short-circuit BEFORE touching the store.
  Future<AuthStatus> bootstrap() async {
    if (!_persistentAuthEnabled) {
      _setStatus(AuthStatus.loggedOut);
      return AuthStatus.loggedOut;
    }
    final String? refresh;
    try {
      refresh = await _tokenStore.readRefreshToken();
      // #352: read the persisted PIN flag BEFORE the status flip, so the redirect
      // that fires on notify can route locked → set-PIN (no PIN yet) vs enter-PIN.
      _pinSet = await _tokenStore.readPinSet();
    } catch (_) {
      // #355 — FAIL SOFT, never wedge the boot.
      //
      // main() awaits bootstrap() BEFORE runApp, so anything thrown here escaped
      // main and runApp never executed: the worker sat on the native splash on
      // EVERY launch, with no way out but manually clearing app data — an
      // unrecoverable-looking break for a low-literacy worker.
      //
      // The realistic trigger is a restored Google backup: flutter_secure_storage
      // runs on EncryptedSharedPreferences, and a restore brings the prefs XML
      // across but NOT the Keystore master key, so every read throws
      // (BadPadding / keystore error). allowBackup=false stops new backups, but a
      // device restoring one made by an older install still lands here.
      //
      // An unreadable store is indistinguishable from an empty one, so treat it
      // as "no token": drop the unusable material and start at phone login. The
      // worker logs in again — annoying, but recoverable.
      await _discardUnreadableStore();
      _pinSet = false;
      _setStatus(AuthStatus.loggedOut);
      return AuthStatus.loggedOut;
    }
    final AuthStatus next =
        (refresh != null && refresh.isNotEmpty) ? AuthStatus.locked : AuthStatus.loggedOut;
    _setStatus(next);
    return next;
  }

  /// Best-effort wipe of a store we could not read (#355).
  ///
  /// clear() goes through the same backing store that just threw, so it may
  /// throw too — swallow that. Failing to clear must not resurrect the boot
  /// wedge this exists to prevent; the worker still reaches phone login, and a
  /// successful login overwrites the bad entries anyway.
  Future<void> _discardUnreadableStore() async {
    try {
      await _tokenStore.clear();
    } catch (_) {
      // Nothing more we can do — deliberately ignored.
    }
    _session.clear();
  }

  // --- OTP login ------------------------------------------------------------

  /// Request an OTP for [phoneE164]. Throws [AuthFailure] (e.g. OTP_RATE_LIMITED).
  Future<OtpRequestResult> requestOtp(String phoneE164) =>
      _authApi.otpRequest(phoneE164);

  /// Verify [otp] for [phoneE164]. On success the fresh access token is bridged
  /// into [SessionRepository]; with the persistent-auth layer ON the manager
  /// also persists the tokens + worker id into [SecureTokenStore] (GAP A) so a
  /// later cold start can reach the device-bound PIN fast path. Routing keys off
  /// the SERVER `result.pinSet` + `result.isNewUser` (NOT a client flag).
  ///
  /// Returns the routing flags `{isNewUser, pinSet}`. With the layer ON (the
  /// default) a new user / no PIN routes to set-PIN ([locked]) while an existing
  /// PIN goes straight to authenticated. With the layer OFF (explicit
  /// dart-define only) OTP success always goes straight to authenticated — the
  /// proven OTP→shell flow, exactly as on main. Throws [AuthFailure] on a bad /
  /// expired code.
  Future<OtpVerifyResult> verifyOtp(String phoneE164, String otp) async {
    final OtpVerifyResult result = await _authApi.otpVerify(phoneE164, otp);
    // F5: retain the session view + refresh expiry the response carries — in
    // every build, not just the persistent-auth one.
    _captureSessionView(result.tokens);
    // GAP A: persist the freshly minted tokens on the REAL path so a later cold
    // start can find the refresh token and reach the device-bound PIN fast path.
    // (MockAuthApi also writes the store; this re-persists the same values.)
    // Gated on the layer being ON so the OFF/default build keeps no persisted
    // state, exactly as on main.
    if (_persistentAuthEnabled) {
      await _persistTokens(result.tokens);
      await _tokenStore.writeWorkerId(result.workerId);
      // #352: persist the SERVER's pin_set alongside the tokens. Only
      // MockAuthApi ever wrote this key, so on the real path a cold start could
      // not tell "has a PIN" from "never set one" and always sent the worker to
      // Enter-PIN.
      _pinSet = result.pinSet;
      await _tokenStore.writePinSet(result.pinSet);
    }
    // TD62: capture the server's consent signal BEFORE the status flip so the
    // router redirect that fires on the notify sees both together.
    _consentAccepted = result.consentAccepted;
    _bridge(
      accessToken: result.tokens.access,
      workerId: result.workerId,
      phone: phoneE164,
    );
    // ADR-0031 grace window: the login response is authoritative for the
    // pending-deletion flag — store it (or clear a stale one) so Settings and
    // the post-login prompt can offer the EXPLICIT cancel. Login itself never
    // auto-cancels a scheduled deletion.
    _session.setDeletionScheduledFor(result.deletionScheduledFor);
    // With the layer OFF, OTP success goes straight to the shell. With it ON, a
    // returning worker with a PIN is authenticated immediately after OTP (the OTP
    // itself is the strong factor); a new user must set a PIN before the shell, so
    // they stay "locked" until [setPin].
    if (!_persistentAuthEnabled || (result.pinSet && !result.isNewUser)) {
      _setStatus(AuthStatus.authenticated);
    } else {
      _setStatus(AuthStatus.locked);
    }
    return result;
  }

  // --- PIN ------------------------------------------------------------------

  /// Set the worker's PIN (new user / reset). On success the app is authenticated
  /// — the OTP that preceded it already minted tokens. Throws [AuthFailure].
  Future<void> setPin(String pin) async {
    await _authApi.pinSet(pin);
    // #352: the device now HAS a PIN — remember it, so a cold start routes to
    // enter-PIN rather than asking the worker to choose one all over again.
    _pinSet = true;
    if (_persistentAuthEnabled) await _tokenStore.writePinSet(true);
    _setStatus(AuthStatus.authenticated);
  }

  /// Unlock with the PIN: verifies against the persisted refresh token, mints a
  /// FRESH token pair, persists + bridges it into [SessionRepository], re-reads
  /// the ADR-0031 pending-deletion flag, and authenticates. On a failed PIN it
  /// throws the NEUTRAL [AuthErrorCode.pinVerifyFailed] (the backend gives one
  /// opaque 401, no attempts/countdown); the status stays [locked]. Throws
  /// [AuthFailure].
  Future<void> unlockWithPin(String pin) async {
    final String? refresh = await _tokenStore.readRefreshToken();
    if (refresh == null || refresh.isEmpty) {
      // Nothing to unlock against — force a fresh OTP login.
      await _wipeAndLogOut();
      throw const AuthFailure(AuthErrorCode.reauthRequired);
    }
    final PinVerifyResult result =
        await _authApi.pinVerify(pin, refreshToken: refresh);
    _captureSessionView(result.tokens); // F5
    // GAP A: persist the rotated tokens so the next cold start stays on the fast
    // path with the freshest refresh token.
    await _persistTokens(result.tokens);
    // TD62: capture the consent signal before the status flip (see verifyOtp).
    _consentAccepted = result.consentAccepted;
    final String? workerId = await _tokenStore.readWorkerId();
    _bridge(accessToken: result.tokens.access, workerId: workerId);
    // ADR-0031: the PIN-verify response carries no pending-deletion field, so
    // re-read it BEFORE the status flip (see [_syncDeletionState]).
    await _syncDeletionState();
    _setStatus(AuthStatus.authenticated);
  }

  /// On-demand refresh (e.g. silent re-validate). Mints fresh tokens from the
  /// persisted refresh token, re-bridges, and re-reads the ADR-0031
  /// pending-deletion flag. Throws [AuthFailure] on a transport failure; an
  /// unrecoverable refresh triggers the reauth signal via [AuthApi].
  Future<void> refresh() async {
    final String? refresh = await _tokenStore.readRefreshToken();
    if (refresh == null || refresh.isEmpty) {
      await _wipeAndLogOut();
      throw const AuthFailure(AuthErrorCode.reauthRequired);
    }
    final AuthTokens tokens = await _authApi.tokenRefresh(refresh);
    _captureSessionView(tokens); // F5
    // GAP A: persist the rotated tokens from the on-demand refresh too.
    await _persistTokens(tokens);
    final String? workerId = await _tokenStore.readWorkerId();
    _bridge(accessToken: tokens.access, workerId: workerId);
    // ADR-0031: a refresh can also be the first authenticated moment of a
    // process (silent re-validate), so it re-reads the flag too.
    await _syncDeletionState();
    _setStatus(AuthStatus.authenticated);
  }

  // --- Forgot-PIN (dedicated reset endpoints) -------------------------------

  /// Forgot-PIN step 1: start the dedicated PIN-reset OTP flow for [phoneE164]
  /// (POST /auth/pin/reset/request). Throws [AuthFailure] (e.g. otpRateLimited).
  Future<void> requestPinReset(String phoneE164) =>
      _authApi.pinResetRequest(phoneE164);

  /// Forgot-PIN step 2: confirm the OTP AND set the new [pin] in one call
  /// (POST /auth/pin/reset/confirm). On success, if a persisted refresh token
  /// survives the worker can unlock with the NEW PIN ([locked]); otherwise they
  /// must log in again ([loggedOut]). Throws [AuthFailure] on a bad OTP (401 →
  /// otpInvalid) or a weak/format PIN (400 → pinWeak).
  Future<void> confirmPinReset(String phoneE164, String otp, String pin) async {
    await _authApi.pinResetConfirm(phoneE164, otp, pin);
    // #352: the reset just set a NEW PIN — record it, or the worker who resets
    // and then cold-starts would be sent to set-PIN again.
    _pinSet = true;
    if (_persistentAuthEnabled) await _tokenStore.writePinSet(true);
    final String? refresh = await _tokenStore.readRefreshToken();
    _setStatus((refresh != null && refresh.isNotEmpty)
        ? AuthStatus.locked
        : AuthStatus.loggedOut);
  }

  // --- Lifecycle re-lock ----------------------------------------------------

  /// Re-lock after the app has been backgrounded past the window: drop the
  /// in-memory access token and require the PIN again — but ONLY when a refresh
  /// token is remembered (otherwise the worker is logged out, not lockable).
  ///
  /// No-op when the persistent-auth layer is OFF: there is no PIN to re-lock to
  /// (and no persisted refresh token to unlock against), so re-locking would
  /// dead-end the worker.
  Future<void> relock() async {
    if (!_persistentAuthEnabled) return;
    final String? refresh = await _tokenStore.readRefreshToken();
    if (refresh == null || refresh.isEmpty) return;
    // Drop the live bearer so no authed call slips through while locked. The
    // refresh token + device id survive; the PIN re-mints a fresh access token.
    _tokenStore.accessToken = null;
    // #368: the token above is only AuthedClient's copy. The SAME token was
    // bridged into SessionRepository, and THAT is the bearer every legacy
    // worker-scoped call (feed/chat/resume/profile/voice) actually sends — so
    // an in-flight or queued request could still authenticate behind the PIN
    // screen, making "locked" not actually fence API access as documented.
    // Ids survive; unlockWithPin re-bridges a fresh token onto them.
    _session.clearSessionToken();
    _setStatus(AuthStatus.locked);
  }

  // --- Logout / devices -----------------------------------------------------

  /// Best-effort logout: revoke this device server-side (ignored on failure —
  /// offline-safe), then wipe BOTH the secure store and the session bridge and
  /// route to phone login.
  Future<void> logout() async {
    try {
      await _authApi.logout();
    } catch (_) {
      // A failed/offline revoke must not block local sign-out.
    }
    await _wipeAndLogOut();
  }

  Future<List<AuthDevice>> listDevices() => _authApi.listDevices();

  Future<void> revokeDevice(String deviceId) => _authApi.revokeDevice(deviceId);

  // --- internals ------------------------------------------------------------

  /// How long the secondary [AuthApi.me] read may hold up an unlock before it is
  /// abandoned. The PIN/refresh call that precedes it has already proven the
  /// network, so this is a backstop, not a budget: a hung GET must never trap a
  /// worker on the PIN screen behind a spinner. Sized for a 2G round trip.
  static const Duration _deletionSyncTimeout = Duration(seconds: 10);

  /// ADR-0031: re-read the AUTHORITATIVE pending-deletion flag for the current
  /// session and mirror it into [SessionRepository], which seeds the Settings
  /// banner + its explicit "Delete cancel karein" action.
  ///
  /// The OTP-verify response carries this flag inline, but [unlockWithPin] and
  /// [refresh] have no such field — and since persistent auth is ON by default,
  /// PIN unlock is the DEFAULT cold-start path. Without this, a worker who
  /// scheduled a deletion and reopened the app would see the ordinary delete row
  /// and never reach cancel for the rest of the 7-day grace, while the shipped
  /// copy promises "Is dauraan aap kabhi bhi cancel kar sakte hain".
  ///
  /// It runs BEFORE the caller's [_setStatus] flip so the flag and the
  /// authenticated status land together — the same ordering the OTP path gets.
  /// Otherwise Settings could seed itself from a not-yet-populated session and
  /// render the wrong row.
  ///
  /// HONEST NULLS, and note the two different nulls:
  ///  - a SUCCESSFUL read is authoritative — a date sets the flag, an ABSENT
  ///    field CLEARS it (a cancelled deletion must not leave a stale banner);
  ///  - a FAILED read is UNKNOWN, not "nothing pending", so it leaves the
  ///    existing value untouched. Never fabricate a date, never clear a
  ///    known-pending one on a transport blip.
  ///
  /// Best-effort by design: this is a banner, not a gate. Cancel is always
  /// reachable later from Settings once a read succeeds, so a failure here must
  /// never block the unlock — a worker locked out of their own app is strictly
  /// worse than a late banner. Nothing here auto-cancels (ruling (a)); only the
  /// worker's explicit action does.
  Future<void> _syncDeletionState() async {
    try {
      final MeResult me = await _authApi.me().timeout(_deletionSyncTimeout);
      _session.setDeletionScheduledFor(me.deletionScheduledFor);
    } catch (_) {
      // Unknown → leave the flag exactly as it was. Swallowed deliberately: the
      // caller's unlock/refresh has already succeeded and must stand.
    }
  }

  /// GAP A: persist a freshly minted token set to [SecureTokenStore] so a cold
  /// start finds the refresh token (reaching the device-bound PIN fast path) and
  /// the proactive-refresh skew works off the real expiry. The access token is
  /// kept in memory only (the store never writes it to disk). No-op when the
  /// persistent-auth layer is OFF (an explicit `PERSISTENT_AUTH=false` build,
  /// which keeps no PIN gate and so persists nothing).
  /// Retains the ADR-0026 session view + refresh expiry from a freshly minted
  /// token set (F5). Separate from [_persistTokens] because that no-ops when the
  /// persistent-auth layer is OFF, whereas `requires_otp_after` is worth knowing
  /// in EVERY build. Absent fields leave the previous value alone rather than
  /// nulling it: a response that simply omits the block is "no news", not
  /// "cancelled".
  void _captureSessionView(AuthTokens tokens) {
    if (tokens.session != null) _authSession = tokens.session;
    if (tokens.refreshExpiresAt != null) {
      _refreshExpiresAt = tokens.refreshExpiresAt;
    }
  }

  /// Drops the retained session view — a new worker must not inherit the old
  /// one. Paired with every wipe/reauth path.
  void _clearSessionView() {
    _authSession = null;
    _refreshExpiresAt = null;
  }

  Future<void> _persistTokens(AuthTokens tokens) async {
    if (!_persistentAuthEnabled) return;
    await _tokenStore.saveTokens(
      refreshToken: tokens.refresh,
      accessExpiresAt: tokens.accessExpiresAt,
      accessToken: tokens.access,
    );
  }

  /// Mirror the fresh access token into the legacy [SessionRepository] so every
  /// worker-scoped call keeps its bearer. The worker id / phone are set on the
  /// first bridge (OTP verify); a plain unlock only refreshes the token.
  void _bridge({
    required String accessToken,
    String? workerId,
    String? phone,
  }) {
    final String wid = workerId ?? _session.workerId ?? '';
    final String ph = phone ?? _session.phoneE164 ?? '';
    if (wid.isNotEmpty) {
      _session.setWorker(phone: ph, workerId: wid, sessionToken: accessToken);
      // Attribute crash reports to this worker. workerId is an opaque UUID
      // (PII-free) — never the phone. Fail-closed no-op if Crashlytics is off.
      CrashReporter.setUser(wid);
    } else {
      _session.setSessionToken(accessToken);
    }
  }

  void _onReauthRequired() {
    // PASS 1's interceptor already cleared SecureTokenStore before firing.
    _session.clear();
    _consentAccepted = null; // TD62: unknown again until the next login
    _pinSet = false; // #352: the store's pin_set went with the clear()
    _resumeLocation = null; // #349: a new login must not land on the old screen
    _clearSessionView(); // F5
    _setStatus(AuthStatus.loggedOut);
  }

  Future<void> _wipeAndLogOut() async {
    await _tokenStore.clear(); // also deletes pin_set
    _session.clear();
    _consentAccepted = null; // TD62: unknown again until the next login
    _pinSet = false; // #352: keep the in-memory flag in step with the store
    _resumeLocation = null; // #349: a new login must not land on the old screen
    _clearSessionView(); // F5: a new worker must not inherit the old session view
    _setStatus(AuthStatus.loggedOut);
  }

  @override
  void dispose() {
    _reauthSub?.cancel();
    super.dispose();
  }
}
