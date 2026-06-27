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

  test('resolveDownloadUrl returns null on a Failure (user-safe, never throws)',
      () async {
    when(() => repo.resumeDownloadUrl()).thenThrow(const UnauthorizedFailure());
    final ResumeCubit cubit = ResumeCubit(repo);
    expect(await cubit.resolveDownloadUrl(), isNull);
  });
}
