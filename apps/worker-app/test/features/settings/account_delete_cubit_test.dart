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
  final DateTime scheduledFor = DateTime.utc(2026, 7, 21, 12);

  late MockApiClient api;
  late SessionRepository session;
  late SecureTokenStore store;
  late ReauthSignal reauth;
  late bool reauthFired;

  AccountDeleteCubit build() => AccountDeleteCubit(api: api, session: session);

  setUp(() {
    api = MockApiClient();
    session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
    store = SecureTokenStore(FakeSecureStore());
    // The cubit must NEVER wipe credentials or force a reauth during the grace
    // window (ADR-0031) — watch the signal to prove it stays silent.
    reauth = ReauthSignal();
    reauthFired = false;
    reauth.stream.listen((_) => reauthFired = true);
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

  test(
      'confirmDelete success -> SCHEDULED with the parsed date; credentials '
      'NOT wiped, NO reauth (ADR-0031 grace)', () async {
    await store.writeRefreshToken('r1');
    when(() => api.confirmAccountDelete(
          authToken: any(named: 'authToken'),
          otp: any(named: 'otp'),
        )).thenAnswer((_) async => AccountDeleteConfirmResult(
          success: true,
          scheduledFor: scheduledFor,
        ));
    final AccountDeleteCubit cubit = build();

    await cubit.confirmDelete('1234');

    verify(() => api.confirmAccountDelete(authToken: 'tok', otp: '1234'))
        .called(1);
    expect(cubit.state.status, AccountDeleteStatus.scheduled);
    expect(cubit.state.scheduledFor, scheduledFor);
    // The pending flag is mirrored onto the session (seeds Settings/post-login).
    expect(session.deletionScheduledFor, scheduledFor);
    // NOTHING wiped: the worker keeps their session so they CAN cancel.
    expect(session.sessionToken, 'tok');
    expect(await store.readRefreshToken(), 'r1');
    await Future<void>.delayed(Duration.zero); // drain the reauth stream
    expect(reauthFired, isFalse);
  });

  test('confirmDelete 401 -> OtpInvalidFailure (nothing scheduled/wiped)',
      () async {
    await store.writeRefreshToken('r1');
    when(() => api.confirmAccountDelete(
          authToken: any(named: 'authToken'),
          otp: any(named: 'otp'),
        )).thenThrow(ApiException(401, 'invalid otp'));
    final AccountDeleteCubit cubit = build();

    await cubit.confirmDelete('0000');

    expect(cubit.state.status, AccountDeleteStatus.error);
    expect(cubit.state.failure, isA<OtpInvalidFailure>());
    // Fail-closed: nothing scheduled when the server did NOT confirm.
    expect(session.deletionScheduledFor, isNull);
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

  test('seeds SCHEDULED when the session already has a pending deletion',
      () {
    session.setDeletionScheduledFor(scheduledFor);

    final AccountDeleteCubit cubit = build();

    expect(cubit.state.status, AccountDeleteStatus.scheduled);
    expect(cubit.state.scheduledFor, scheduledFor);
  });

  test('cancelDelete success -> idle, API called, session flag cleared',
      () async {
    session.setDeletionScheduledFor(scheduledFor);
    when(() => api.cancelAccountDelete(authToken: any(named: 'authToken')))
        .thenAnswer((_) async {});
    final AccountDeleteCubit cubit = build();

    await cubit.cancelDelete();

    verify(() => api.cancelAccountDelete(authToken: 'tok')).called(1);
    expect(cubit.state.status, AccountDeleteStatus.idle);
    expect(cubit.state.scheduledFor, isNull);
    expect(session.deletionScheduledFor, isNull);
    // The session itself survives the cancel round trip.
    expect(session.sessionToken, 'tok');
  });

  test('cancelDelete failure -> STAYS scheduled with the typed cause',
      () async {
    session.setDeletionScheduledFor(scheduledFor);
    when(() => api.cancelAccountDelete(authToken: any(named: 'authToken')))
        .thenThrow(ApiException(500, 'boom'));
    final AccountDeleteCubit cubit = build();

    await cubit.cancelDelete();

    expect(cubit.state.status, AccountDeleteStatus.scheduled);
    expect(cubit.state.scheduledFor, scheduledFor);
    expect(cubit.state.failure, isA<ServerFailure>());
    // The pending flag is NOT cleared on a failed cancel.
    expect(session.deletionScheduledFor, scheduledFor);
  });
}
