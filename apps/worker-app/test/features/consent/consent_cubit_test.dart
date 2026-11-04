import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';

class MockConsentRepository extends Mock implements ConsentRepository {}

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

void main() {
  setUpAll(() {
    registerFallbackValue(const <String>[]);
    registerFallbackValue(false);
  });

  late MockConsentRepository repo;
  setUp(() => repo = MockConsentRepository());

  blocTest<ConsentCubit, ConsentState>(
    'setAccepted toggles the checkbox state',
    build: () => ConsentCubit(repo),
    act: (ConsentCubit c) => c.setAccepted(true),
    expect: () => const <ConsentState>[ConsentState(accepted: true)],
  );

  blocTest<ConsentCubit, ConsentState>(
    'setAge18Plus records the yes/no answer',
    build: () => ConsentCubit(repo),
    act: (ConsentCubit c) => c.setAge18Plus(true),
    expect: () => const <ConsentState>[ConsentState(age18Plus: true)],
  );

  blocTest<ConsentCubit, ConsentState>(
    'submit ignored until accepted and answered',
    build: () => ConsentCubit(repo),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[],
    verify: (_) => verifyNever(
      () => repo.acceptConsent(
        purposes: any(named: 'purposes'),
        age18Plus: any(named: 'age18Plus'),
      ),
    ),
  );

  blocTest<ConsentCubit, ConsentState>(
    'submit ignored until the age question is answered',
    build: () => ConsentCubit(repo),
    seed: () => const ConsentState(accepted: true),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[],
    verify: (_) => verifyNever(
      () => repo.acceptConsent(
        purposes: any(named: 'purposes'),
        age18Plus: any(named: 'age18Plus'),
      ),
    ),
  );

  blocTest<ConsentCubit, ConsentState>(
    'submit when accepted and answered -> submitting then success',
    build: () {
      when(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      ).thenAnswer((_) async {});
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(accepted: true, age18Plus: true),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.submitting,
      ),
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.success,
      ),
    ],
    verify: (_) => verify(
      () => repo.acceptConsent(
        purposes: <String>[
          'profiling',
          'resume_generation',
          'voice_processing',
        ],
        age18Plus: true,
      ),
    ).called(1),
  );

  // TD62: a successful consent submit must release the router's consent gate
  // via AuthSessionManager.markConsentAccepted (resolved through the locator —
  // guarded, so the plain-cubit tests above run without any registration).
  blocTest<ConsentCubit, ConsentState>(
    'submit success calls AuthSessionManager.markConsentAccepted (TD62)',
    build: () {
      when(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      ).thenAnswer((_) async {});
      final MockAuthSessionManager auth = MockAuthSessionManager();
      locator.registerSingleton<AuthSessionManager>(auth);
      addTearDown(() => locator.unregister<AuthSessionManager>());
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(accepted: true, age18Plus: true),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.submitting,
      ),
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.success,
      ),
    ],
    verify: (_) => verify(
      () => locator<AuthSessionManager>().markConsentAccepted(),
    ).called(1),
  );

  // The DPDP consent surface's only user-facing error path: a submit failure
  // must surface the failure status with the generic, PII-safe message only.
  blocTest<ConsentCubit, ConsentState>(
    'submit failure -> submitting then failure with a generic message',
    build: () {
      when(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      ).thenThrow(const ServerFailure(500));
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(accepted: true, age18Plus: true),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.submitting,
      ),
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.failure,
        message: 'Something went wrong. Please try again.',
      ),
    ],
  );

  blocTest<ConsentCubit, ConsentState>(
    'under-18 403 -> ageBlocked, never a generic failure',
    build: () {
      when(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      ).thenThrow(const AgeBelowMinimumFailure());
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(accepted: true, age18Plus: false),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[
      ConsentState(
        accepted: true,
        age18Plus: false,
        status: ConsentStatus.submitting,
      ),
      ConsentState(
        accepted: true,
        age18Plus: false,
        status: ConsentStatus.ageBlocked,
      ),
    ],
  );

  blocTest<ConsentCubit, ConsentState>(
    'AGE_CONFIRMATION_REQUIRED -> generic update/try-again failure',
    build: () {
      when(
        () => repo.acceptConsent(
          purposes: any(named: 'purposes'),
          age18Plus: any(named: 'age18Plus'),
        ),
      ).thenThrow(const AgeConfirmationRequiredFailure());
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(accepted: true, age18Plus: true),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.submitting,
      ),
      ConsentState(
        accepted: true,
        age18Plus: true,
        status: ConsentStatus.failure,
        message: 'App update karein, phir dobara koshish karein.',
      ),
    ],
  );

  blocTest<ConsentCubit, ConsentState>(
    'acknowledging the under-18 screen discards the local session',
    build: () {
      final MockAuthSessionManager auth = MockAuthSessionManager();
      when(auth.discardSession).thenAnswer((_) async {});
      locator.registerSingleton<AuthSessionManager>(auth);
      addTearDown(() => locator.unregister<AuthSessionManager>());
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(
      accepted: true,
      age18Plus: false,
      status: ConsentStatus.ageBlocked,
    ),
    act: (ConsentCubit c) => c.acknowledgeAgeBlock(),
    expect: () => const <ConsentState>[],
    verify: (_) =>
        verify(() => locator<AuthSessionManager>().discardSession()).called(1),
  );
}
