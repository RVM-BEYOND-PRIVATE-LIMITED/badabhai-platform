import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../../core/auth/auth_api.dart';
import '../../../core/auth/auth_failure.dart';
import '../../../core/auth/reauth_signal.dart';
import '../../../core/auth/secure_token_store.dart';
import '../../../core/config/app_config.dart';
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
/// across restarts are active ONLY when [persistentAuthEnabled] is true (mock mode,
/// or staging via `--dart-define=PERSISTENT_AUTH=true`). With the layer OFF — the
/// default in REAL builds, because the backend `/auth/pin/*` + `/auth/token/refresh`
/// contract is not live — [bootstrap] always starts at phone login, OTP success
/// goes straight to authenticated, and [relock] is a no-op (there is no persisted
/// refresh token on the real path to unlock against).
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

  /// Set true once [bootstrap] has resolved the cold-start state, so the router
  /// can hold on splash until the secure store has been read exactly once.
  bool _ready = false;
  bool get isReady => _ready;

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
  /// With the persistent-auth layer OFF (the default in REAL builds) there is no
  /// persisted refresh token and no PIN gate, so the app always starts at phone
  /// login — exactly as on main. We short-circuit BEFORE touching the store.
  Future<AuthStatus> bootstrap() async {
    if (!_persistentAuthEnabled) {
      _setStatus(AuthStatus.loggedOut);
      return AuthStatus.loggedOut;
    }
    final String? refresh = await _tokenStore.readRefreshToken();
    final AuthStatus next =
        (refresh != null && refresh.isNotEmpty) ? AuthStatus.locked : AuthStatus.loggedOut;
    _setStatus(next);
    return next;
  }

  // --- OTP login ------------------------------------------------------------

  /// Request an OTP for [phoneE164]. Throws [AuthFailure] (e.g. OTP_RATE_LIMITED).
  Future<OtpRequestResult> requestOtp(String phoneE164) =>
      _authApi.otpRequest(phoneE164);

  /// Verify [otp] for [phoneE164]. On success the fresh access token is bridged
  /// into [SessionRepository]; with the persistent-auth layer ON the tokens +
  /// worker id + pin_set flag are also persisted (by [AuthApi]/MockAuthApi into
  /// [SecureTokenStore]).
  ///
  /// Returns the routing flags `{isNewUser, pinSet}`. With the layer ON a new
  /// user / no PIN routes to set-PIN ([locked]) while an existing PIN goes
  /// straight to authenticated. With the layer OFF (default in REAL builds) OTP
  /// success always goes straight to authenticated — the proven OTP→shell flow,
  /// exactly as on main. Throws [AuthFailure] on a bad / expired code.
  Future<OtpVerifyResult> verifyOtp(String phoneE164, String otp) async {
    final OtpVerifyResult result = await _authApi.otpVerify(phoneE164, otp);
    _bridge(
      accessToken: result.tokens.access,
      workerId: result.workerId,
      phone: phoneE164,
    );
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
    _setStatus(AuthStatus.authenticated);
  }

  /// Unlock with the PIN: verifies against the persisted refresh token, mints a
  /// FRESH token pair, bridges it into [SessionRepository], and authenticates.
  /// On [AuthErrorCode.pinInvalid] / [AuthErrorCode.pinLocked] it throws the
  /// typed failure (attempts-left / countdown) for the screen to render; the
  /// status stays [locked]. Throws [AuthFailure].
  Future<void> unlockWithPin(String pin) async {
    final String? refresh = await _tokenStore.readRefreshToken();
    if (refresh == null || refresh.isEmpty) {
      // Nothing to unlock against — force a fresh OTP login.
      await _wipeAndLogOut();
      throw const AuthFailure(AuthErrorCode.requiresOtp);
    }
    final AuthTokens tokens = await _authApi.pinVerify(pin, refreshToken: refresh);
    final String? workerId = await _tokenStore.readWorkerId();
    _bridge(accessToken: tokens.access, workerId: workerId);
    _setStatus(AuthStatus.authenticated);
  }

  /// On-demand refresh (e.g. silent re-validate). Mints fresh tokens from the
  /// persisted refresh token and re-bridges. Throws [AuthFailure] on a transport
  /// failure; an unrecoverable refresh triggers the reauth signal via [AuthApi].
  Future<void> refresh() async {
    final String? refresh = await _tokenStore.readRefreshToken();
    if (refresh == null || refresh.isEmpty) {
      await _wipeAndLogOut();
      throw const AuthFailure(AuthErrorCode.requiresOtp);
    }
    final AuthTokens tokens = await _authApi.tokenRefresh(refresh);
    final String? workerId = await _tokenStore.readWorkerId();
    _bridge(accessToken: tokens.access, workerId: workerId);
    _setStatus(AuthStatus.authenticated);
  }

  /// Forgot-PIN: re-runs the OTP flow for [phoneE164]; the screen then routes to
  /// set-PIN to choose a fresh one. Just a thin alias over [requestOtp] kept as a
  /// named intent so the forgot-PIN screen reads clearly.
  Future<OtpRequestResult> forgotPin(String phoneE164) => requestOtp(phoneE164);

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
    } else {
      _session.setSessionToken(accessToken);
    }
  }

  void _onReauthRequired() {
    // PASS 1's interceptor already cleared SecureTokenStore before firing.
    _session.clear();
    _setStatus(AuthStatus.loggedOut);
  }

  Future<void> _wipeAndLogOut() async {
    await _tokenStore.clear();
    _session.clear();
    _setStatus(AuthStatus.loggedOut);
  }

  @override
  void dispose() {
    _reauthSub?.cancel();
    super.dispose();
  }
}
