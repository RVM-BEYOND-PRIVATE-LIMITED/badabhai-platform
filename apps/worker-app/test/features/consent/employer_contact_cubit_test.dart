import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_contact.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/employer_contact_cubit.dart';
import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockConsentRepository extends Mock implements ConsentRepository {}

EmployerContactInfo _info(bool enabled) =>
    EmployerContactInfo(enabled: enabled, purposes: const <String>[]);

void main() {
  late MockConsentRepository repo;

  setUp(() => repo = MockConsentRepository());

  blocTest<EmployerContactCubit, EmployerContactState>(
    'load renders server truth ON when both purposes are present',
    build: () {
      when(() => repo.employerContactState())
          .thenAnswer((_) async => _info(true));
      return EmployerContactCubit(repo);
    },
    act: (EmployerContactCubit c) => c.load(),
    expect: () => <EmployerContactState>[
      const EmployerContactState(status: EmployerContactStatus.loading),
      const EmployerContactState(
        status: EmployerContactStatus.ready,
        enabled: true,
      ),
    ],
  );

  blocTest<EmployerContactCubit, EmployerContactState>(
    'load renders OFF when the row omits the employer purposes',
    build: () {
      when(() => repo.employerContactState())
          .thenAnswer((_) async => _info(false));
      return EmployerContactCubit(repo);
    },
    act: (EmployerContactCubit c) => c.load(),
    expect: () => <EmployerContactState>[
      const EmployerContactState(status: EmployerContactStatus.loading),
      const EmployerContactState(status: EmployerContactStatus.ready),
    ],
  );

  blocTest<EmployerContactCubit, EmployerContactState>(
    'a load Failure is surfaced — never a guessed state',
    build: () {
      when(() => repo.employerContactState()).thenThrow(const NetworkFailure());
      return EmployerContactCubit(repo);
    },
    act: (EmployerContactCubit c) => c.load(),
    expect: () => <EmployerContactState>[
      const EmployerContactState(status: EmployerContactStatus.loading),
      const EmployerContactState(
        status: EmployerContactStatus.failed,
        failure: NetworkFailure(),
      ),
    ],
  );

  test('withdraw writes, re-reads server state, and never logs out', () async {
    when(() => repo.employerContactState())
        .thenAnswer((_) async => _info(true));
    when(() => repo.withdrawEmployerContact()).thenAnswer((_) async {});
    final EmployerContactCubit cubit = EmployerContactCubit(repo);
    await cubit.load();
    expect(cubit.state.enabled, isTrue);

    // The re-read after the write must come back OFF.
    when(() => repo.employerContactState())
        .thenAnswer((_) async => _info(false));
    final bool ok = await cubit.withdraw();

    expect(ok, isTrue);
    expect(cubit.state.status, EmployerContactStatus.ready);
    expect(cubit.state.enabled, isFalse,
        reason: 'state comes from the server re-read, not the tap');
    verify(() => repo.withdrawEmployerContact()).called(1);
  });

  test('a failed withdraw keeps the prior state and reports the failure',
      () async {
    when(() => repo.employerContactState())
        .thenAnswer((_) async => _info(true));
    when(() => repo.withdrawEmployerContact()).thenThrow(const NetworkFailure());
    final EmployerContactCubit cubit = EmployerContactCubit(repo);
    await cubit.load();

    final bool ok = await cubit.withdraw();

    expect(ok, isFalse);
    expect(cubit.state.status, EmployerContactStatus.failed);
    expect(cubit.state.enabled, isTrue, reason: 'prior truth is kept');
  });
}
