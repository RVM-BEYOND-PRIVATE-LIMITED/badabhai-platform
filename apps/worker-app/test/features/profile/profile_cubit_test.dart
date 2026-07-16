import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile/presentation/cubit/profile_cubit.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';

class MockProfileRepository extends Mock implements ProfileRepository {}

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

void main() {
  late MockProfileRepository repo;
  late MockProfileSummaryRepository summaryRepo;

  // The real extracted profile read back after extraction — trade / city /
  // strength — which the confirm step must reflect (not a placeholder).
  const ProfileSummary realSummary = ProfileSummary(
    tradeLabel: 'VMC Operator',
    city: 'Pune',
    verified: false,
    strengthSignals: 5,
  );

  setUp(() {
    repo = MockProfileRepository();
    summaryRepo = MockProfileSummaryRepository();
    // Default: the summary read succeeds with real data.
    when(() => summaryRepo.summary()).thenAnswer((_) async => realSummary);
  });

  // bloc emits the first state even when it equals the initial state, so the
  // leading `extracting` is observed before the terminal state.
  blocTest<ProfileCubit, ProfileState>(
    'extract success -> ready carrying the REAL summary (trade/city/strength)',
    build: () {
      when(() => repo.extractProfile()).thenAnswer((_) async => 'p1');
      return ProfileCubit(repo, summaryRepo);
    },
    act: (ProfileCubit c) => c.extract(),
    expect: () => const <ProfileState>[
      ProfileState(status: ProfileStatus.extracting),
      ProfileState(status: ProfileStatus.ready, summary: realSummary),
    ],
    verify: (_) => verify(() => summaryRepo.summary()).called(1),
  );

  // A summary-read miss is NON-fatal: extraction succeeded, so the screen still
  // goes ready (with a null summary) rather than failing — the view then
  // degrades honestly instead of showing fabricated rows.
  blocTest<ProfileCubit, ProfileState>(
    'extract success but summary read fails -> ready with null summary',
    build: () {
      when(() => repo.extractProfile()).thenAnswer((_) async => 'p1');
      when(() => summaryRepo.summary()).thenThrow(const NetworkFailure());
      return ProfileCubit(repo, summaryRepo);
    },
    act: (ProfileCubit c) => c.extract(),
    expect: () => const <ProfileState>[
      ProfileState(status: ProfileStatus.extracting),
      ProfileState(status: ProfileStatus.ready),
    ],
  );

  blocTest<ProfileCubit, ProfileState>(
    'extract failure -> failed (summary never read)',
    build: () {
      when(() => repo.extractProfile()).thenThrow(const NetworkFailure());
      return ProfileCubit(repo, summaryRepo);
    },
    act: (ProfileCubit c) => c.extract(),
    expect: () => const <ProfileState>[
      ProfileState(status: ProfileStatus.extracting),
      ProfileState(status: ProfileStatus.failed, failure: NetworkFailure()),
    ],
    verify: (_) => verifyNever(() => summaryRepo.summary()),
  );

  blocTest<ProfileCubit, ProfileState>(
    'confirm from ready -> confirmed (keeps the summary)',
    build: () {
      when(() => repo.confirmProfile()).thenAnswer((_) async {});
      return ProfileCubit(repo, summaryRepo);
    },
    seed: () =>
        const ProfileState(status: ProfileStatus.ready, summary: realSummary),
    act: (ProfileCubit c) => c.confirm(),
    expect: () => const <ProfileState>[
      ProfileState(status: ProfileStatus.confirmed, summary: realSummary),
    ],
    verify: (_) => verify(() => repo.confirmProfile()).called(1),
  );

  blocTest<ProfileCubit, ProfileState>(
    'confirm is ignored unless ready',
    build: () => ProfileCubit(repo, summaryRepo),
    act: (ProfileCubit c) => c.confirm(),
    expect: () => const <ProfileState>[],
    verify: (_) => verifyNever(() => repo.confirmProfile()),
  );

  // The frozen UI has no confirm-error affordance: a confirm failure is
  // swallowed and the screen stays on the ready view (emits nothing).
  blocTest<ProfileCubit, ProfileState>(
    'confirm failure -> stays ready, no emission',
    build: () {
      when(() => repo.confirmProfile()).thenThrow(const NetworkFailure());
      return ProfileCubit(repo, summaryRepo);
    },
    seed: () => const ProfileState(status: ProfileStatus.ready),
    act: (ProfileCubit c) => c.confirm(),
    expect: () => const <ProfileState>[],
    verify: (_) => verify(() => repo.confirmProfile()).called(1),
  );

  // Re-entrancy guard: a concurrent double-confirm must not fire confirmProfile
  // twice while the first call is in flight.
  blocTest<ProfileCubit, ProfileState>(
    'concurrent confirm calls only invoke the repo once',
    build: () {
      when(() => repo.confirmProfile()).thenAnswer(
        (_) => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      return ProfileCubit(repo, summaryRepo);
    },
    seed: () => const ProfileState(status: ProfileStatus.ready),
    act: (ProfileCubit c) {
      c.confirm(); // in flight — do not await
      c.confirm(); // dropped by the guard
    },
    wait: const Duration(milliseconds: 50),
    expect: () =>
        const <ProfileState>[ProfileState(status: ProfileStatus.confirmed)],
    verify: (_) => verify(() => repo.confirmProfile()).called(1),
  );

  // Emit-after-close guard: popping the screen mid-extraction (the ~14s poll)
  // must not throw a StateError when the in-flight future finally resolves.
  test('extract resolving after close does not throw', () async {
    when(() => repo.extractProfile()).thenAnswer(
      (_) => Future<String>.delayed(
        const Duration(milliseconds: 30),
        () => 'p1',
      ),
    );
    final ProfileCubit cubit = ProfileCubit(repo, summaryRepo);
    final Future<void> inFlight = cubit.extract();
    await cubit.close(); // screen popped before extraction resolved
    await expectLater(inFlight, completes); // no StateError on the late emit
  });
}
