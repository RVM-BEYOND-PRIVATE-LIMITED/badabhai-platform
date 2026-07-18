import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/auth/payer_auth_api.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/payer_account_api.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';

/// A hand fake for `GET /payer/me` — returns a canned [PayerMe] (or throws to
/// exercise the fallback). Counts fetches so we can prove the REAL path ran.
class _FakeAccountApi implements PayerAccountApi {
  _FakeAccountApi(this._me, {this.throwOnFetch = false});
  final PayerMe _me;
  final bool throwOnFetch;
  int fetchCount = 0;

  @override
  Future<PayerMe> fetchMe() async {
    fetchCount++;
    if (throwOnFetch) throw Exception('boom');
    return _me;
  }

  @override
  Future<PayerMe> updateMe({String? orgName, String? phone}) async => _me;

  @override
  Future<void> logout() async {}
}

/// Mimics PayerHttp's force-reauth on an unrecoverable 401: the `/payer/me`
/// probe WIPES the bearer (and would fire signOut) before throwing. Bootstrap
/// must not then flash a logged-in shell over the emptied store.
class _ReauthClearingAccountApi implements PayerAccountApi {
  _ReauthClearingAccountApi(this._tokens);
  final PayerTokenStore _tokens;

  @override
  Future<PayerMe> fetchMe() async {
    await _tokens.clear();
    throw Exception('401');
  }

  @override
  Future<PayerMe> updateMe({String? orgName, String? phone}) async =>
      throw UnimplementedError();

  @override
  Future<void> logout() async {}
}

PayerLoginResult _login(String role) => PayerLoginResult(
      accessToken: 't',
      payerId: 'p',
      role: role,
      isNewPayer: false,
    );

void main() {
  // NOTE: post-P3 the payer test binary runs with kUseMocks=false, so
  // signInFromLogin/bootstrap take the REAL branch and use the injected account
  // api — exactly what these assertions rely on (fetchCount > 0).
  const PayerMe companyMe = PayerMe(
    id: 'p1',
    role: 'employer',
    status: 'active',
    orgName: 'Kalyani Industries',
    email: 'demo@badabhai.in',
    phoneLast4: '3210',
  );
  const PayerMe agencyMe = PayerMe(
    id: 'p2',
    role: 'agent',
    status: 'active',
    orgName: 'Apex Staffing',
    email: 'demo@badabhai.in',
    phoneLast4: '3210',
  );

  group('P2 — signInFromLogin adopts /payer/me identity', () {
    test('REAL company: name=orgName, plan=Company account, initials, no PII',
        () async {
      final _FakeAccountApi api = _FakeAccountApi(companyMe);
      final AppSessionCubit cubit = AppSessionCubit(accountApi: api);

      await cubit.signInFromLogin(_login('employer'));

      expect(api.fetchCount, 1); // REAL path ran
      final account = cubit.state!.account;
      expect(cubit.state!.role, PayerRole.company);
      expect(account.name, 'Kalyani Industries');
      expect(account.plan, 'Company account');
      expect(account.initials, 'KI');
      // PII-light: email + phoneLast4 are dropped — never on the display model.
      expect(account.props, isNot(contains('demo@badabhai.in')));
      expect(account.props, isNot(contains('3210')));
    });

    test('REAL agency: plan=Agency · supply + demand', () async {
      final AppSessionCubit cubit =
          AppSessionCubit(accountApi: _FakeAccountApi(agencyMe));

      await cubit.signInFromLogin(_login('agent'));

      expect(cubit.state!.role, PayerRole.agency);
      expect(cubit.state!.account.name, 'Apex Staffing');
      expect(cubit.state!.account.plan, 'Agency · supply + demand');
    });

    // #356 — this used to assert the CANNED accountFor() identity on failure,
    // which meant a real payer whose /payer/me timed out was shown another
    // company's name ("Kalyani Industries") as their own signed-in account for
    // the whole session. Fabricated identity is worse than an honest unknown.
    test('#356: fetchMe failure → NEUTRAL unknown identity, never a canned '
        'company name', () async {
      final AppSessionCubit cubit = AppSessionCubit(
          accountApi: _FakeAccountApi(companyMe, throwOnFetch: true));

      await cubit.signInFromLogin(_login('employer'));

      final PayerAccount account = cubit.state!.account;
      expect(account.name, isNot('Kalyani Industries'),
          reason: 'never show one payer another payer\'s org name');
      expect(account.name, isNot('Apex Staffing'));
      expect(account.name, 'Your account');
      expect(account.initials, '?', reason: 'no monogram can be derived');
      // The ROLE is genuinely known (server-decided), so the plan stays honest.
      expect(account.plan, 'Company account');
    });

    test('#356: the agency role also degrades neutrally (plan stays honest)',
        () async {
      final AppSessionCubit cubit = AppSessionCubit(
          accountApi: _FakeAccountApi(agencyMe, throwOnFetch: true));

      await cubit.signInFromLogin(_login('agent'));

      expect(cubit.state!.account.name, 'Your account');
      expect(cubit.state!.account.plan, 'Agency · supply + demand');
    });

    test('no account api wired → canned accountFor (mock/test path)', () async {
      final AppSessionCubit cubit = AppSessionCubit();

      await cubit.signInFromLogin(_login('agent'));

      expect(cubit.state!.account.name, 'Apex Staffing');
    });
  });

  group('P1 — bootstrap cold-restart rehydrate', () {
    test('persisted bearer → restores session (role from token, real identity)',
        () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 'tok', payerId: 'p2', role: 'agent');
      final _FakeAccountApi api = _FakeAccountApi(agencyMe);
      final AppSessionCubit cubit =
          AppSessionCubit(accountApi: api, tokenStore: tokens);

      await cubit.bootstrap();

      expect(cubit.state, isNotNull);
      expect(cubit.state!.role, PayerRole.agency);
      expect(cubit.state!.account.name, 'Apex Staffing');
      expect(api.fetchCount, 1);
    });

    test('no persisted bearer → stays signed out (null → Login)', () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      final AppSessionCubit cubit = AppSessionCubit(
          accountApi: _FakeAccountApi(companyMe), tokenStore: tokens);

      await cubit.bootstrap();

      expect(cubit.state, isNull);
    });

    test('persisted bearer but /payer/me fails (transient) → still restores the '
        'session, with a NEUTRAL identity (offline-friendly, token intact)',
        () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 'tok', payerId: 'p1', role: 'employer');
      final AppSessionCubit cubit = AppSessionCubit(
        accountApi: _FakeAccountApi(companyMe, throwOnFetch: true),
        tokenStore: tokens,
      );

      await cubit.bootstrap();

      // The POINT of this test: a transient /payer/me failure must NOT log the
      // payer out — the bearer is intact, so the session resumes.
      expect(cubit.state, isNotNull);
      expect(cubit.state!.role, PayerRole.company);
      expect(tokens.hasSession, isTrue);
      // #356: but the identity is unknown, so it is not invented.
      expect(cubit.state!.account.name, 'Your account');
      expect(cubit.state!.account.name, isNot('Kalyani Industries'));
    });

    test('expired token: /payer/me 401 clears the bearer mid-resolve → stays '
        'signed out (no broken logged-in flash over an empty store)', () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 'stale', payerId: 'p1', role: 'employer');
      final AppSessionCubit cubit = AppSessionCubit(
        accountApi: _ReauthClearingAccountApi(tokens),
        tokenStore: tokens,
      );

      await cubit.bootstrap();

      // The bearer was wiped during resolution → land on Login, not a shell.
      expect(cubit.state, isNull);
      expect(tokens.hasSession, isFalse);
    });
  });

  // #369 — CreditsCubit is an app-wide lazySingleton, so unlike every per-mount
  // cubit its state SURVIVES sign-out. On a shared office device that means the
  // next payer to sign in reads the previous payer's balance.
  group('signOut clears app-wide singleton state (#369)', () {
    test('the sign-out hook fires AFTER the session and bearer are cleared',
        () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 'tok', payerId: 'p1', role: 'employer');
      bool cleared = false;
      AppSession? stateWhenCalled;
      final AppSessionCubit cubit = AppSessionCubit(tokenStore: tokens);
      final AppSessionCubit wired = AppSessionCubit(
        tokenStore: tokens,
        onSessionCleared: () {
          cleared = true;
          stateWhenCalled = cubit.state;
        },
      );

      await wired.signOut();

      expect(cleared, isTrue, reason: 'singletons must be told to reset');
      expect(stateWhenCalled, isNull);
      expect(tokens.hasSession, isFalse);
    });

  });

  // #377 — main() awaits PayerTokenStore.load() BEFORE runApp, so a throw here
  // escapes main and the first frame never renders: the payer sits on the native
  // splash on EVERY launch with no way out but clearing app data. The trigger is
  // a restored Google backup — EncryptedSharedPreferences' XML comes across but
  // the Keystore master key does not, so every read throws.
  group('PayerTokenStore.load — unreadable store (#377)', () {
    test('degrades to a cleared, signed-out state instead of wedging the boot',
        () async {
      final PayerTokenStore store = PayerTokenStore(_ThrowingSecureStore());

      // The assertion IS that this does not throw.
      await store.load();

      expect(store.accessToken, isNull);
      expect(store.payerId, isNull);
      expect(store.role, isNull);
      expect(store.hasSession, isFalse,
          reason: 'an unreadable store is indistinguishable from an empty one');
    });

    test('a session bootstrapped over an unreadable store lands on Login',
        () async {
      final PayerTokenStore store = PayerTokenStore(_ThrowingSecureStore());
      await store.load();
      final AppSessionCubit cubit = AppSessionCubit(
        accountApi: _FakeAccountApi(companyMe),
        tokenStore: store,
      );

      await cubit.bootstrap();

      expect(cubit.state, isNull);
    });
  });
}

/// A secure store whose EVERY operation throws (#377) — the post-backup-restore
/// reality. `delete` throws too, so the best-effort wipe on the failure path is
/// exercised as well: failing to clear must still not resurrect the boot wedge.
class _ThrowingSecureStore implements SecureKeyValueStore {
  @override
  Future<String?> read(String key) async =>
      throw Exception('keystore: BadPaddingException');

  @override
  Future<void> write(String key, String value) async =>
      throw Exception('keystore: BadPaddingException');

  @override
  Future<void> delete(String key) async =>
      throw Exception('keystore: BadPaddingException');
}
