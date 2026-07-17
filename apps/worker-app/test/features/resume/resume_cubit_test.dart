import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

void main() {
  late MockResumeRepository repo;
  setUp(() => repo = MockResumeRepository());

  // bloc emits the first state even when it equals the initial `loading`.
  blocTest<ResumeCubit, ResumeState>(
    'generate success -> ready with the resume text',
    build: () {
      when(() => repo.generateResume()).thenAnswer((_) async => 'RESUME TEXT');
      return ResumeCubit(repo);
    },
    act: (ResumeCubit c) => c.generate(),
    expect: () => const <ResumeState>[
      ResumeState(status: ResumeStatus.loading),
      ResumeState(status: ResumeStatus.ready, resumeText: 'RESUME TEXT'),
    ],
    verify: (_) => verify(() => repo.generateResume()).called(1),
  );

  blocTest<ResumeCubit, ResumeState>(
    'generate failure -> failed (not a stuck spinner)',
    build: () {
      when(() => repo.generateResume()).thenThrow(const NetworkFailure());
      return ResumeCubit(repo);
    },
    act: (ResumeCubit c) => c.generate(),
    expect: () => const <ResumeState>[
      ResumeState(status: ResumeStatus.loading),
      ResumeState(status: ResumeStatus.failed),
    ],
  );

  test('resolveDownloadUrl returns the signed url on success', () async {
    when(() => repo.resumeDownloadUrl())
        .thenAnswer((_) async => 'https://signed/u?token=x');
    final ResumeCubit cubit = ResumeCubit(repo);
    expect(await cubit.resolveDownloadUrl(), 'https://signed/u?token=x');
    verify(() => repo.resumeDownloadUrl()).called(1);
  });

  test('resolveDownloadUrl PROPAGATES the Failure (so the launcher shows the '
      'real reason, not a blank generic line)', () {
    when(() => repo.resumeDownloadUrl()).thenThrow(const UnauthorizedFailure());
    final ResumeCubit cubit = ResumeCubit(repo);
    expect(() => cubit.resolveDownloadUrl(), throwsA(isA<UnauthorizedFailure>()));
  });

  // T4 — the Resume tab refetches when it comes back into view. It must REUSE
  // the existing resume: a forced generate on every tab switch would overwrite
  // the row server-side, reset the PDF to 'pending', re-enqueue the render and
  // burn one of the worker's 5 daily generates — just for looking at the tab.
  group('tab-focus refresh (T4)', () {
    test('refresh NEVER forces a regenerate', () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenAnswer((_) async => 'resume text');
      final ResumeCubit cubit = ResumeCubit(repo);
      addTearDown(cubit.close);

      await cubit.refresh();

      // force: false is the reuse path — the repo only POSTs generate when there
      // genuinely is no resume yet.
      verify(() => repo.generateResume()).called(1);
      verifyNever(() => repo.generateResume(force: true));
    });

    test('a failed refresh keeps the resume already on screen', () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenThrow(const NetworkFailure());
      final ResumeCubit cubit = ResumeCubit(repo);
      addTearDown(cubit.close);

      // The worker is reading a resume; a background blip must not replace it
      // with an error screen.
      cubit.showGenerated('good resume');
      await cubit.refresh();

      expect(cubit.state.status, ResumeStatus.ready);
      expect(cubit.state.resumeText, 'good resume');
    });

    test('a failed refresh DOES surface when nothing good is on screen',
        () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenThrow(const NetworkFailure());
      final ResumeCubit cubit = ResumeCubit(repo);
      addTearDown(cubit.close);

      await cubit.refresh();

      expect(cubit.state.status, ResumeStatus.failed);
    });

    test('refresh does not emit a spinner over a readable resume', () async {
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        return 'fresh';
      });
      final ResumeCubit cubit = ResumeCubit(repo);
      addTearDown(cubit.close);
      cubit.showGenerated('stale');

      final List<ResumeStatus> seen = <ResumeStatus>[];
      final sub = cubit.stream.listen((ResumeState s) => seen.add(s.status));
      addTearDown(sub.cancel);

      await cubit.refresh();

      expect(seen, isNot(contains(ResumeStatus.loading)),
          reason: 'the worker must not watch their resume flash to a spinner');
      expect(cubit.state.resumeText, 'fresh');
    });

    test('overlapping loads are ignored', () async {
      int calls = 0;
      when(() => repo.generateResume(force: any(named: 'force')))
          .thenAnswer((_) async {
        calls++;
        await Future<void>.delayed(const Duration(milliseconds: 50));
        return 'resume text';
      });
      final ResumeCubit cubit = ResumeCubit(repo);
      addTearDown(cubit.close);

      // Tab focus can fire while the create:-time generate is still in flight.
      await Future.wait<void>(<Future<void>>[cubit.generate(), cubit.refresh()]);

      expect(calls, 1, reason: 'the second load must be ignored, not stacked');
    });
  });
}
