import 'dart:async';

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

  test(
      'REGRESSION (reentrancy): a double-tap starts exactly ONE recording — '
      'one plugin start, one ticker, elapsed counts 1x', () async {
    final VoiceNoteCubit cubit =
        VoiceNoteCubit(repo, tick: const Duration(milliseconds: 20));
    final List<VoiceNoteState> states = <VoiceNoteState>[];
    final StreamSubscription<VoiceNoteState> sub = cubit.stream.listen(states.add);

    // Two rapid taps: both pass the STATE guard (state is still Idle across
    // the permission await) — only the in-flight flag stops the second.
    await Future.wait(<Future<void>>[
      cubit.startRecording(),
      cubit.startRecording(),
    ]);
    verify(() => repo.ensureMicPermission()).called(1);
    verify(() => repo.startRecording()).called(1);

    // A single ticker → strictly +1 increments, no duplicates/jumps (a second
    // stacked ticker would emit each elapsed twice and count 2x).
    await Future<void>.delayed(const Duration(milliseconds: 70));
    final List<int> elapsed = states
        .whereType<VoiceNoteRecording>()
        .map((VoiceNoteRecording s) => s.elapsedSeconds)
        .toList();
    expect(elapsed.first, 0);
    for (int i = 1; i < elapsed.length; i++) {
      expect(elapsed[i], elapsed[i - 1] + 1,
          reason: 'elapsed must tick exactly once per interval');
    }
    // RATE bound: ~70ms of 20ms ticks is ≤4 recordings for ONE ticker (0 + ~3
    // ticks; +1 jitter headroom). Two stacked tickers would emit ~7 — the 2x
    // count the finding describes (dedup keeps their steps at +1, so the
    // monotonic check above alone can't catch it).
    expect(elapsed.length, lessThanOrEqualTo(5),
        reason: 'a second stacked ticker would double the tick rate');

    await sub.cancel();
    await cubit.close();
  });

  test(
      'REGRESSION (owner-less mic): close() during the start window still '
      'releases the mic', () async {
    // Hold the plugin start open so close() lands inside the await window
    // (state is still Idle — the old state-only check saw nothing to cancel).
    final Completer<void> startGate = Completer<void>();
    when(() => repo.startRecording()).thenAnswer((_) => startGate.future);

    final VoiceNoteCubit cubit = VoiceNoteCubit(repo);
    final Future<void> starting = cubit.startRecording();
    await Future<void>.delayed(Duration.zero); // reach the await
    await cubit.close();

    startGate.complete();
    await starting;

    // Released by close() (in-flight flag) and/or the start's own isClosed
    // self-cancel — either way the mic has an owner. Cancel is idempotent.
    verify(() => repo.cancelRecording()).called(greaterThanOrEqualTo(1));
  });
}
