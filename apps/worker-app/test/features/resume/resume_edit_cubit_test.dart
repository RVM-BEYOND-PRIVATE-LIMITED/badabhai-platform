import 'dart:typed_data';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/resume/domain/photo_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_edit_cubit.dart';

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class MockPhotoRepository extends Mock implements PhotoRepository {}

const ResumeSafeFields _fields = ResumeSafeFields(
  displayName: 'Ramesh Kumar',
  showPhoto: true,
  nightShiftReady: false,
);

void main() {
  late MockResumeEditRepository repo;
  late MockPhotoRepository photos;

  setUp(() {
    repo = MockResumeEditRepository();
    photos = MockPhotoRepository();
    registerFallbackValue(_fields);
    registerFallbackValue(Uint8List(0));
    // Default: no photo url — the photo leg quietly no-ops unless a test arms it.
    when(() => photos.photoUrl()).thenAnswer((_) async => null);
  });

  ResumeEditCubit build() => ResumeEditCubit(repo, photos);

  // bloc emits the first state even when it equals the initial `loading`.
  blocTest<ResumeEditCubit, ResumeEditState>(
    'load -> loading then ready with the canned fields',
    build: () {
      when(() => repo.load()).thenAnswer((_) async => _fields);
      return build();
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
    build: build,
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
      // false = prefs-only save (no name change) → the preview must NOT
      // regenerate. The name-change case is covered in its own test below.
      when(() => repo.save(any())).thenAnswer((_) async => false);
      return build();
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
      when(() => repo.save(any())).thenThrow(const NetworkFailure());
      return build();
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

  // ── ADR-0032: the photo leg ────────────────────────────────────────────────

  blocTest<ResumeEditCubit, ResumeEditState>(
    'load with hasPhoto fetches the signed thumbnail url (in-memory only)',
    build: () {
      when(() => repo.load())
          .thenAnswer((_) async => _fields.copyWith(hasPhoto: true));
      when(() => photos.photoUrl())
          .thenAnswer((_) async => 'https://signed.example/p.jpg');
      return build();
    },
    act: (ResumeEditCubit c) => c.load(),
    expect: () => <ResumeEditState>[
      const ResumeEditState(status: ResumeEditStatus.loading),
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(hasPhoto: true),
      ),
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(hasPhoto: true),
        photoUrl: 'https://signed.example/p.jpg',
      ),
    ],
  );

  blocTest<ResumeEditCubit, ResumeEditState>(
    'a failed thumbnail fetch DEGRADES to placeholder — never takes down the screen',
    build: () {
      when(() => repo.load())
          .thenAnswer((_) async => _fields.copyWith(hasPhoto: true));
      when(() => photos.photoUrl()).thenThrow(const NetworkFailure());
      return build();
    },
    act: (ResumeEditCubit c) => c.load(),
    expect: () => <ResumeEditState>[
      const ResumeEditState(status: ResumeEditStatus.loading),
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(hasPhoto: true),
      ),
      // clearPhotoUrl emit — same state values, photoUrl stays null → deduped by
      // Equatable, so no extra state. The screen stays READY.
    ],
  );

  blocTest<ResumeEditCubit, ResumeEditState>(
    'uploadPhoto -> busy, then hasPhoto:true + fresh signed url',
    build: () {
      when(() => photos.uploadPhoto(any())).thenAnswer((_) async {});
      when(() => photos.photoUrl())
          .thenAnswer((_) async => 'https://signed.example/new.jpg');
      return build();
    },
    seed: () =>
        const ResumeEditState(status: ResumeEditStatus.ready, fields: _fields),
    act: (ResumeEditCubit c) => c.uploadPhoto(Uint8List.fromList(<int>[1, 2])),
    expect: () => <ResumeEditState>[
      const ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields,
        photoBusy: true,
      ),
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(hasPhoto: true),
      ),
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(hasPhoto: true),
        photoUrl: 'https://signed.example/new.jpg',
      ),
    ],
    verify: (_) => verify(() => photos.uploadPhoto(any())).called(1),
  );

  blocTest<ResumeEditCubit, ResumeEditState>(
    'uploadPhoto failure -> busy off + the SAME honest error snackbar path as save',
    build: () {
      when(() => photos.uploadPhoto(any()))
          .thenThrow(const PhotoUnavailableFailure());
      return build();
    },
    seed: () =>
        const ResumeEditState(status: ResumeEditStatus.ready, fields: _fields),
    act: (ResumeEditCubit c) => c.uploadPhoto(Uint8List.fromList(<int>[1])),
    expect: () => <ResumeEditState>[
      const ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields,
        photoBusy: true,
      ),
      const ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields,
        saveErrorNonce: 1,
        saveFailure: PhotoUnavailableFailure(),
      ),
    ],
  );

  blocTest<ResumeEditCubit, ResumeEditState>(
    'removePhoto -> busy, then hasPhoto:false with the thumbnail cleared',
    build: () {
      when(() => photos.removePhoto()).thenAnswer((_) async {});
      return build();
    },
    seed: () => ResumeEditState(
      status: ResumeEditStatus.ready,
      fields: _fields.copyWith(hasPhoto: true),
      photoUrl: 'https://signed.example/p.jpg',
    ),
    act: (ResumeEditCubit c) => c.removePhoto(),
    expect: () => <ResumeEditState>[
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(hasPhoto: true),
        photoUrl: 'https://signed.example/p.jpg',
        photoBusy: true,
      ),
      ResumeEditState(
        status: ResumeEditStatus.ready,
        fields: _fields.copyWith(hasPhoto: false),
      ),
    ],
    verify: (_) => verify(() => photos.removePhoto()).called(1),
  );

  // F1 — the name is baked into the resume at GENERATION time, so a PATCHed name
  // stayed invisible in the preview (and in the #398 download file name) until
  // the resume was rebuilt. The repository already knows whether the name
  // changed; the cubit carries that fact out so the preview can regenerate —
  // and ONLY then, since a needless generate spends one of the worker's 5/day.
  group('nameChanged is carried out of save (F1)', () {
    blocTest<ResumeEditCubit, ResumeEditState>(
      'a NAME change reports nameChanged: true',
      build: () {
        when(() => repo.save(any())).thenAnswer((_) async => true);
        return build();
      },
      seed: () => const ResumeEditState(
          status: ResumeEditStatus.ready, fields: _fields),
      act: (ResumeEditCubit c) => c.save(),
      skip: 1, // the saving:true frame
      expect: () => <Matcher>[
        isA<ResumeEditState>()
            .having((ResumeEditState s) => s.nameChanged, 'nameChanged', isTrue)
            .having((ResumeEditState s) => s.savedNonce, 'savedNonce', 1),
      ],
    );

    blocTest<ResumeEditCubit, ResumeEditState>(
      'a prefs-only save reports nameChanged: false (no wasted regenerate)',
      build: () {
        when(() => repo.save(any())).thenAnswer((_) async => false);
        return build();
      },
      seed: () => const ResumeEditState(
          status: ResumeEditStatus.ready, fields: _fields),
      act: (ResumeEditCubit c) => c.save(),
      skip: 1,
      expect: () => <Matcher>[
        isA<ResumeEditState>()
            .having((ResumeEditState s) => s.nameChanged, 'nameChanged', isFalse)
            .having((ResumeEditState s) => s.savedNonce, 'savedNonce', 1),
      ],
    );
  });
}
