import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/settings/presentation/cubit/account_delete_cubit.dart';

import '../../core/auth/fakes.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient api;
  late SessionRepository session;
  late FakeSecureStore secureBacking;
  late SecureTokenStore store;
  late ReauthSignal reauth;

  AccountDeleteCubit build() => AccountDeleteCubit(
        api: api,
        session: session,
        tokenStore: store,
        reauthSignal: reauth,
      );

  setUp(() {
    api = MockApiClient();
    session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
    secureBacking = FakeSecureStore();
    store = SecureTokenStore(secureBacking);
    reauth = ReauthSignal();
  });

  tearDown(() => reauth.dispose());

  test('requestDelete -> otpSent carrying the resend cooldown', () async {
    when(() => api.requestAccountDelete(authToken: any(named: 'authToken')))
        .thenAnswer((_) async =>
            const AccountDeleteRequestResult(success: true, resendInSeconds: 45));
    final AccountDeleteCubit cubit = build();

    await cubit.requestDelete();

    verify(() => api.requestAccountDelete(authToken: 'tok')).called(1);
    expect(cubit.state.status, AccountDeleteStatus.otpSent);
    expect(cubit.state.resendInSeconds, 45);
  });

  test('confirmDelete success -> wipes session + store, fires reauth, deleted',
      () async {
    await store.writeRefreshToken('r1');
    when(() => api.confirmAccountDelete(
          authToken: any(named: 'authToken'),
          otp: any(named: 'otp'),
        )).thenAnswer((_) async {});
    final AccountDeleteCubit cubit = build();
    final Future<void> reauthFired = reauth.stream.first;

    await cubit.confirmDelete('1234');

    verify(() => api.confirmAccountDelete(authToken: 'tok', otp: '1234'))
        .called(1);
    expect(cubit.state.status, AccountDeleteStatus.deleted);
    // Local credentials gone.
    expect(session.sessionToken, isNull);
    expect(await store.readRefreshToken(), isNull);
    // Reauth signal fired (router flips to logged-out).
    await reauthFired;
  });

  test('confirmDelete 401 -> OtpInvalidFailure (session NOT wiped)', () async {
    await store.writeRefreshToken('r1');
    when(() => api.confirmAccountDelete(
          authToken: any(named: 'authToken'),
          otp: any(named: 'otp'),
        )).thenThrow(ApiException(401, 'invalid otp'));
    final AccountDeleteCubit cubit = build();

    await cubit.confirmDelete('0000');

    expect(cubit.state.status, AccountDeleteStatus.error);
    expect(cubit.state.failure, isA<OtpInvalidFailure>());
    // Fail-closed: nothing wiped when the delete was NOT confirmed.
    expect(session.sessionToken, 'tok');
    expect(await store.readRefreshToken(), 'r1');
  });

  test('confirmDelete 429 -> RateLimitedFailure', () async {
    when(() => api.confirmAccountDelete(
          authToken: any(named: 'authToken'),
          otp: any(named: 'otp'),
        )).thenThrow(ApiException(429, 'too many'));
    final AccountDeleteCubit cubit = build();

    await cubit.confirmDelete('1234');

    expect(cubit.state.status, AccountDeleteStatus.error);
    expect(cubit.state.failure, isA<RateLimitedFailure>());
  });

  test('no session token -> UnauthorizedFailure (no network call)', () async {
    session = SessionRepository(); // no token
    final AccountDeleteCubit cubit = build();

    await cubit.requestDelete();

    expect(cubit.state.status, AccountDeleteStatus.error);
    expect(cubit.state.failure, isA<UnauthorizedFailure>());
    verifyNever(
        () => api.requestAccountDelete(authToken: any(named: 'authToken')));
  });
}
