import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_withdraw_cubit.dart';

class MockConsentRepository extends Mock implements ConsentRepository {}

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

void main() {
  late MockConsentRepository repo;
  setUp(() => repo = MockConsentRepository());

  // The POST-withdraw contract: the SERVER revoked every session (this device
  // included), so a SUCCESS must drive a hard-logout via AuthSessionManager —
  // the honest local response. Resolved through the locator (guarded), so the
  // plain-cubit tests below run without any registration.
  blocTest<ConsentWithdrawCubit, ConsentWithdrawState>(
    'withdraw success calls the endpoint AND hard-logs-out (AuthSessionManager.logout)',
    build: () {
      when(() => repo.withdrawConsent()).thenAnswer((_) async {});
      final MockAuthSessionManager auth = MockAuthSessionManager();
      when(() => auth.logout()).thenAnswer((_) async {});
      locator.registerSingleton<AuthSessionManager>(auth);
      addTearDown(() => locator.unregister<AuthSessionManager>());
      return ConsentWithdrawCubit(repo);
    },
    act: (ConsentWithdrawCubit c) => c.withdraw(),
    // With a manager wired the cubit does NOT emit `success` — the manager flips
    // AuthStatus and the router tears the screen down, so the last emitted state
    // is `submitting` (the screen is on its way out).
    expect: () => const <ConsentWithdrawState>[
      ConsentWithdrawState(status: ConsentWithdrawStatus.submitting),
    ],
    verify: (_) {
      verify(() => repo.withdrawConsent()).called(1);
      verify(() => locator<AuthSessionManager>().logout()).called(1);
    },
  );

  blocTest<ConsentWithdrawCubit, ConsentWithdrawState>(
    'a failed withdraw surfaces the typed failure and NEVER logs out',
    build: () {
      when(() => repo.withdrawConsent()).thenThrow(const NetworkFailure());
      final MockAuthSessionManager auth = MockAuthSessionManager();
      when(() => auth.logout()).thenAnswer((_) async {});
      locator.registerSingleton<AuthSessionManager>(auth);
      addTearDown(() => locator.unregister<AuthSessionManager>());
      return ConsentWithdrawCubit(repo);
    },
    act: (ConsentWithdrawCubit c) => c.withdraw(),
    expect: () => const <ConsentWithdrawState>[
      ConsentWithdrawState(status: ConsentWithdrawStatus.submitting),
      ConsentWithdrawState(
        status: ConsentWithdrawStatus.failure,
        failure: NetworkFailure(),
      ),
    ],
    verify: (_) =>
        verifyNever(() => locator<AuthSessionManager>().logout()),
  );

  // Plugin-free graph (no manager wired): the cubit cannot drive the router, so
  // it emits `success` as the honest terminal state.
  blocTest<ConsentWithdrawCubit, ConsentWithdrawState>(
    'with no AuthSessionManager wired, a success emits the success state',
    build: () {
      when(() => repo.withdrawConsent()).thenAnswer((_) async {});
      return ConsentWithdrawCubit(repo);
    },
    act: (ConsentWithdrawCubit c) => c.withdraw(),
    expect: () => const <ConsentWithdrawState>[
      ConsentWithdrawState(status: ConsentWithdrawStatus.submitting),
      ConsentWithdrawState(status: ConsentWithdrawStatus.success),
    ],
  );
}
