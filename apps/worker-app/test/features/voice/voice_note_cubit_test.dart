import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_note_repository.dart';
import 'package:badabhai_worker_app/features/voice/presentation/cubit/voice_note_cubit.dart';

class MockVoiceNoteRepository extends Mock implements VoiceNoteRepository {}

const VoiceNoteOutcome _outcome = VoiceNoteOutcome(
  transcript: 'CNC par 4 saal ka anubhav.',
  reply: 'Badhiya! Kaunsa control chalate ho?',
);

void main() {
  late MockVoiceNoteRepository repo;

  setUp(() {
    repo = MockVoiceNoteRepository();
    when(() => repo.ensureMicPermission()).thenAnswer((_) async => true);
    when(() => repo.startRecording()).thenAnswer((_) async {});
    when(() => repo.cancelRecording()).thenAnswer((_) async {});
    when(() => repo.stopRecordingAndTranscribe())
        .thenAnswer((_) async => _outcome);
  });

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'startRecording: permission ok → Recording(0)',
    build: () => VoiceNoteCubit(repo),
    act: (VoiceNoteCubit c) => c.startRecording(),
    expect: () => const <VoiceNoteState>[VoiceNoteRecording(0)],
    verify: (_) {
      verify(() => repo.ensureMicPermission()).called(1);
      verify(() => repo.startRecording()).called(1);
    },
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'startRecording: permission DENIED → honest MicPermissionFailure, '
    'no recorder start',
    build: () {
      when(() => repo.ensureMicPermission()).thenAnswer((_) async => false);
      return VoiceNoteCubit(repo);
    },
    act: (VoiceNoteCubit c) => c.startRecording(),
    expect: () =>
        const <VoiceNoteState>[VoiceNoteError(MicPermissionFailure())],
    verify: (_) => verifyNever(() => repo.startRecording()),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'the counter ticks while recording',
    build: () => VoiceNoteCubit(repo, tick: const Duration(milliseconds: 10)),
    act: (VoiceNoteCubit c) => c.startRecording(),
    wait: const Duration(milliseconds: 60),
    expect: () => isA<List<VoiceNoteState>>()
        .having((List<VoiceNoteState> s) => s.first, 'first',
            const VoiceNoteRecording(0))
        .having(
            (List<VoiceNoteState> s) =>
                s.whereType<VoiceNoteRecording>().length,
            'tick count',
            greaterThanOrEqualTo(2)),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'stopAndSend: Recording → Processing → Success(outcome)',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteRecording(5),
    act: (VoiceNoteCubit c) => c.stopAndSend(),
    expect: () => const <VoiceNoteState>[
      VoiceNoteProcessing(),
      VoiceNoteSuccess(_outcome),
    ],
    verify: (_) => verify(() => repo.stopRecordingAndTranscribe()).called(1),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'stopAndSend failure surfaces the honest Failure (e.g. 503 → unavailable)',
    build: () {
      when(() => repo.stopRecordingAndTranscribe())
          .thenThrow(const VoiceUnavailableFailure());
      return VoiceNoteCubit(repo);
    },
    seed: () => const VoiceNoteRecording(5),
    act: (VoiceNoteCubit c) => c.stopAndSend(),
    expect: () => const <VoiceNoteState>[
      VoiceNoteProcessing(),
      VoiceNoteError(VoiceUnavailableFailure()),
    ],
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'stopAndSend is a no-op when not recording',
    build: () => VoiceNoteCubit(repo),
    act: (VoiceNoteCubit c) => c.stopAndSend(),
    expect: () => const <VoiceNoteState>[],
    verify: (_) => verifyNever(() => repo.stopRecordingAndTranscribe()),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'hits the hard cap → auto stop-and-send (Recording(max) → Processing → '
    'Success)',
    build: () => VoiceNoteCubit(
      repo,
      tick: const Duration(milliseconds: 5),
      maxSeconds: 2,
    ),
    act: (VoiceNoteCubit c) => c.startRecording(),
    wait: const Duration(milliseconds: 100),
    expect: () => const <VoiceNoteState>[
      VoiceNoteRecording(0),
      VoiceNoteRecording(1),
      VoiceNoteRecording(2),
      VoiceNoteProcessing(),
      VoiceNoteSuccess(_outcome),
    ],
    verify: (_) => verify(() => repo.stopRecordingAndTranscribe()).called(1),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'cancelRecording discards and returns to idle',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteRecording(5),
    act: (VoiceNoteCubit c) => c.cancelRecording(),
    expect: () => const <VoiceNoteState>[VoiceNoteIdle()],
    verify: (_) => verify(() => repo.cancelRecording()).called(1),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'reset returns to idle only from an error',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteError(VoiceUnavailableFailure()),
    act: (VoiceNoteCubit c) => c.reset(),
    expect: () => const <VoiceNoteState>[VoiceNoteIdle()],
  );

  test('close() mid-recording discards the clip (mic never left running)',
      () async {
    final VoiceNoteCubit cubit = VoiceNoteCubit(repo);
    await cubit.startRecording();
    await cubit.close();
    verify(() => repo.cancelRecording()).called(1);
  });
}
