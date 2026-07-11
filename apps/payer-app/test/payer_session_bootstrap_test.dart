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

    test('fetchMe failure → canned accountFor(role) fallback (never blank)',
        () async {
      final AppSessionCubit cubit = AppSessionCubit(
          accountApi: _FakeAccountApi(companyMe, throwOnFetch: true));

      await cubit.signInFromLogin(_login('employer'));

      expect(cubit.state!.account.name, 'Kalyani Industries'); // accountFor
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

    test('persisted bearer but /payer/me fails (transient) → restores via canned '
        'fallback (offline-friendly, token intact)', () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 'tok', payerId: 'p1', role: 'employer');
      final AppSessionCubit cubit = AppSessionCubit(
        accountApi: _FakeAccountApi(companyMe, throwOnFetch: true),
        tokenStore: tokens,
      );

      await cubit.bootstrap();

      expect(cubit.state!.role, PayerRole.company);
      expect(cubit.state!.account.name, 'Kalyani Industries');
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
}
