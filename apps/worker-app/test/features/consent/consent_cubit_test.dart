import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';

class MockConsentRepository extends Mock implements ConsentRepository {}

void main() {
  setUpAll(() => registerFallbackValue(const <String>[]));

  late MockConsentRepository repo;
  setUp(() => repo = MockConsentRepository());

  blocTest<ConsentCubit, ConsentState>(
    'setAccepted toggles the checkbox state',
    build: () => ConsentCubit(repo),
    act: (ConsentCubit c) => c.setAccepted(true),
    expect: () => const <ConsentState>[ConsentState(accepted: true)],
  );

  blocTest<ConsentCubit, ConsentState>(
    'submit ignored until accepted',
    build: () => ConsentCubit(repo),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[],
    verify: (_) => verifyNever(
      () => repo.acceptConsent(purposes: any(named: 'purposes')),
    ),
  );

  blocTest<ConsentCubit, ConsentState>(
    'submit when accepted -> submitting then success',
    build: () {
      when(() => repo.acceptConsent(purposes: any(named: 'purposes')))
          .thenAnswer((_) async {});
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(accepted: true),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[
      ConsentState(accepted: true, status: ConsentStatus.submitting),
      ConsentState(accepted: true, status: ConsentStatus.success),
    ],
    verify: (_) => verify(
      () => repo.acceptConsent(
        purposes: <String>['profiling', 'resume_generation'],
      ),
    ).called(1),
  );

  // The DPDP consent surface's only user-facing error path: a submit failure
  // must surface the failure status with the generic, PII-safe message only.
  blocTest<ConsentCubit, ConsentState>(
    'submit failure -> submitting then failure with a generic message',
    build: () {
      when(() => repo.acceptConsent(purposes: any(named: 'purposes')))
          .thenThrow(const ServerFailure(500));
      return ConsentCubit(repo);
    },
    seed: () => const ConsentState(accepted: true),
    act: (ConsentCubit c) => c.submit(),
    expect: () => const <ConsentState>[
      ConsentState(accepted: true, status: ConsentStatus.submitting),
      ConsentState(
        accepted: true,
        status: ConsentStatus.failure,
        message: 'Something went wrong. Please try again.',
      ),
    ],
  );
}
