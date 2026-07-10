import 'package:flutter_bloc/flutter_bloc.dart';

import '../auth/payer_auth_api.dart';
import '../auth/payer_token_store.dart';
import '../data/models.dart';
import 'app_session.dart';

/// Holds the locked session (role + identity). `null` state = signed out.
///
/// The role is chosen ONCE at login and never changes while signed in — there is
/// no in-app switch. [signOut] revokes the server session (best-effort), wipes
/// the bearer from secure storage (guaranteed), and clears back to Login.
class AppSessionCubit extends Cubit<AppSession?> {
  AppSessionCubit({PayerAuthApi? authApi, PayerTokenStore? tokenStore})
      : _authApi = authApi,
        _tokenStore = tokenStore,
        super(null);

  /// Optional so MOCK-mode / unit tests can construct a bare cubit. When wired
  /// (real app), [signOut] revokes + wipes the bearer through these.
  final PayerAuthApi? _authApi;
  final PayerTokenStore? _tokenStore;

  bool get isSignedIn => state != null;

  /// MOCK boot: signs in with the chosen [role]; resolves the canned identity
  /// from the data seam. Kept for MOCK mode + existing tests.
  void signIn(PayerRole role) {
    emit(AppSession(role: role, account: accountFor(role)));
  }

  /// REAL boot: sets the session from a verified [PayerLoginResult]. The role is
  /// server-decided (the wire `role` maps to [PayerRole]); the identity is still
  /// the canned [accountFor] projection until `GET /payer/me` is adopted on the
  /// Account screen (account fetch is delegated for now).
  void signInFromLogin(PayerLoginResult result) {
    final PayerRole role = result.payerRole;
    emit(AppSession(role: role, account: accountFor(role)));
  }

  /// Signs out: `POST /payer/logout` to revoke the server session (best-effort —
  /// if it throws, e.g. offline, we still continue), THEN a guaranteed local
  /// wipe of the secure token store, THEN clears the session (→ Login). The
  /// local wipe is unconditional so a failed/offline logout can never leave a
  /// live bearer on the device.
  Future<void> signOut() async {
    try {
      await _authApi?.logout();
    } catch (_) {
      // Best-effort server revoke: a network failure must not block sign-out.
    }
    await _tokenStore?.clear();
    emit(null);
  }
}
