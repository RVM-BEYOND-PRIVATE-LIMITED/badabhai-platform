import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_edit_cubit.dart';

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

const ResumeSafeFields _fields = ResumeSafeFields(
  displayName: 'Ramesh Kumar',
  showPhoto: true,
  nightShiftReady: false,
);

void main() {
  late MockResumeEditRepository repo;

  setUp(() {
    repo = MockResumeEditRepository();
    registerFallbackValue(_fields);
  });

  // bloc emits the first state even when it equals the initial `loading`.
  blocTest<ResumeEditCubit, ResumeEditState>(
    'load -> loading then ready with the canned fields',
    build: () {
      when(() => repo.load()).thenAnswer((_) async => _fields);
      return ResumeEditCubit(repo);
    },
    act: (ResumeEditCubit c) => c.load(),
    expect: () => const <ResumeEditState>[
      ResumeEditState(status: ResumeEditStatus.loading),
      ResumeEditState(status: ResumeEditStatus.ready, fields: _fields),
    ],
    verify: (_) => verify(() => repo.load()).called(1),
  );

  blocTest<ResumeEditCubit, ResumeEditState>(
    'setNightShiftReady(true) -> ready with the flag flipped',
    build: () => ResumeEditCubit(repo),
    seed: () =>
        const ResumeEditState(status: ResumeEditStatus.ready, fields: _fields),
    act: (ResumeEditCubit c) => c.setNightShiftReady(true),
    expect: () => <ResumeEditState>[
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(nightShiftReady: true),
      ),
    ],
  );

  blocTest<ResumeEditCubit, ResumeEditState>(
    'save -> saving then saving:false with savedNonce bumped',
    build: () {
      when(() => repo.save(any())).thenAnswer((_) async {});
      return ResumeEditCubit(repo);
    },
    seed: () =>
        const ResumeEditState(status: ResumeEditStatus.ready, fields: _fields),
    act: (ResumeEditCubit c) => c.save(),
    expect: () => const <ResumeEditState>[
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields,
        saving: true,
      ),
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields,
        savedNonce: 1,
      ),
    ],
    verify: (_) => verify(() => repo.save(_fields)).called(1),
  );

  blocTest<ResumeEditCubit, ResumeEditState>(
    'save failure -> saving:false + saveErrorNonce bumped (surfaces, not swallowed)',
    build: () {
      when(() => repo.save(any()))
          .thenThrow(const NetworkFailure());
      return ResumeEditCubit(repo);
    },
    seed: () =>
        const ResumeEditState(status: ResumeEditStatus.ready, fields: _fields),
    act: (ResumeEditCubit c) => c.save(),
    expect: () => <ResumeEditState>[
      const ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields,
        saving: true,
      ),
      const ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields,
        saveErrorNonce: 1,
        saveFailure: NetworkFailure(),
      ),
    ],
  );
}
