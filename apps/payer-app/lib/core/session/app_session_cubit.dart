import 'package:flutter_bloc/flutter_bloc.dart';

import '../auth/payer_auth_api.dart';
import '../auth/payer_token_store.dart';
import '../config/app_config.dart';
import '../data/models.dart';
import '../data/payer_account_api.dart';
import 'app_session.dart';

/// Holds the locked session (role + identity). `null` state = signed out.
///
/// The role is chosen ONCE at login and never changes while signed in — there is
/// no in-app switch. [signOut] revokes the server session (best-effort), wipes
/// the bearer from secure storage (guaranteed), and clears back to Login.
class AppSessionCubit extends Cubit<AppSession?> {
  AppSessionCubit({
    PayerAuthApi? authApi,
    PayerAccountApi? accountApi,
    PayerTokenStore? tokenStore,
  })  : _authApi = authApi,
        _accountApi = accountApi,
        _tokenStore = tokenStore,
        super(null);

  /// Optional so MOCK-mode / unit tests can construct a bare cubit. When wired
  /// (real app): [_authApi] revokes on [signOut], [_accountApi] resolves the
  /// real identity from `GET /payer/me`, and [_tokenStore] persists/hydrates the
  /// bearer for cold-start [bootstrap].
  final PayerAuthApi? _authApi;
  final PayerAccountApi? _accountApi;
  final PayerTokenStore? _tokenStore;

  bool get isSignedIn => state != null;

  /// MOCK boot: signs in with the chosen [role]; resolves the canned identity
  /// from the data seam. Kept for MOCK mode + existing tests.
  void signIn(PayerRole role) {
    emit(AppSession(role: role, account: accountFor(role)));
  }

  /// REAL boot from a verified [PayerLoginResult]. The role is server-decided
  /// (the wire `role` maps to [PayerRole]); the identity is now the REAL
  /// `GET /payer/me` projection (canned fallback on failure — see
  /// [_resolveAccount]).
  Future<void> signInFromLogin(PayerLoginResult result) async {
    final PayerRole role = result.payerRole;
    _emitResolved(role, await _resolveAccount(role));
  }

  /// Cold-start rehydrate: if a bearer is persisted (survived an app kill),
  /// restore the session — role from the persisted `bb_payer_role`, identity via
  /// [_resolveAccount]. No persisted bearer → stay signed out (Login). Must be
  /// awaited after [PayerTokenStore.load]; the root shows a splash until it
  /// resolves.
  Future<void> bootstrap() async {
    final PayerTokenStore? store = _tokenStore;
    if (store == null || !store.hasSession) return; // stay null → Login
    final PayerRole role =
        store.role == 'agent' ? PayerRole.agency : PayerRole.company;
    _emitResolved(role, await _resolveAccount(role));
  }

  /// Emits [account] as a live session for [role] — but ONLY if the bearer is
  /// still present. A 401 during identity resolution triggers PayerHttp's
  /// force-reauth, which clears the token store and starts [signOut]; emitting a
  /// logged-in shell over an already-empty store would flash a broken screen and
  /// fire a burst of doomed authed calls before signOut converges to Login. So
  /// when the session died mid-resolve, stay signed out and let Login render. A
  /// transient error / timeout leaves the token intact → resume normally. With
  /// no token store wired (mock / unit tests) it always emits.
  void _emitResolved(PayerRole role, PayerAccount account) {
    final PayerTokenStore? store = _tokenStore;
    if (store != null && !store.hasSession) return; // session died mid-resolve
    emit(AppSession(role: role, account: account));
  }

  /// REAL (`kUseMocks` false + an account api wired) → `GET /payer/me` mapped to
  /// the PII-light display identity; on ANY failure (network/5xx/401) — and in
  /// MOCK / when no account api is wired — the canned [accountFor] projection.
  /// Never throws: a session always resolves to a shown identity.
  Future<PayerAccount> _resolveAccount(PayerRole role) async {
    if (kUseMocks || _accountApi == null) return accountFor(role);
    try {
      // Bounded so a captive-portal / black-hole server can never pin the
      // cold-start splash open — a timeout falls through to the canned identity.
      final PayerMe me =
          await _accountApi.fetchMe().timeout(const Duration(seconds: 8));
      return _accountFromMe(me);
    } catch (_) {
      return accountFor(role);
    }
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

/// Maps the PII-light `GET /payer/me` body to the display identity. Deliberately
/// DROPS `email` + `phoneLast4` (PII, CLAUDE.md §2) — the header renders only an
/// org name, a plan label, and initials, never contact data.
PayerAccount _accountFromMe(PayerMe me) {
  final bool agent = me.role == 'agent';
  return PayerAccount(
    name: me.orgName,
    plan: agent ? 'Agency · supply + demand' : 'Company account',
    initials: _initialsFrom(me.orgName),
  );
}

/// Up to two uppercased initials from the org name ("Kalyani Industries" → "KI",
/// "Apex" → "AP"). A blank name → "?" (never crashes / fabricates).
String _initialsFrom(String orgName) {
  final List<String> words = orgName
      .trim()
      .split(RegExp(r'\s+'))
      .where((String w) => w.isNotEmpty)
      .toList();
  if (words.isEmpty) return '?';
  if (words.length == 1) {
    final String w = words.first;
    return (w.length >= 2 ? w.substring(0, 2) : w).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}
