import 'dart:async';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_note_repository.dart';
import 'package:badabhai_worker_app/features/voice/presentation/cubit/voice_note_cubit.dart';

class MockVoiceNoteRepository extends Mock implements VoiceNoteRepository {}

const String _transcript = 'CNC par 4 saal ka anubhav.';

const VoiceNoteOutcome _outcome = VoiceNoteOutcome(
  transcript: _transcript,
  reply: 'Theek hai. Kaunsa control chalate hain?',
);

void main() {
  late MockVoiceNoteRepository repo;

  setUp(() {
    repo = MockVoiceNoteRepository();
    when(() => repo.ensureMicPermission()).thenAnswer((_) async => true);
    when(() => repo.startRecording()).thenAnswer((_) async {});
    when(() => repo.cancelRecording()).thenAnswer((_) async {});
    when(() => repo.stopAndTranscribe()).thenAnswer((_) async => _transcript);
    when(() => repo.sendConfirmedTranscript(any()))
        .thenAnswer((Invocation i) async => VoiceNoteOutcome(
              transcript: i.positionalArguments.first as String,
              reply: _outcome.reply,
            ));
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

  // ---- The confirm turn (Persona sheet, worked conversation #05) ----------
  // "The transcript is shown for confirmation, never guessed at." The pipeline
  // must STOP at TranscriptReady, and only an explicit confirm() may send.

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'stopAndTranscribe: Recording → Processing → TranscriptReady — and NOTHING '
    'is sent',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteRecording(5),
    act: (VoiceNoteCubit c) => c.stopAndTranscribe(),
    expect: () => const <VoiceNoteState>[
      VoiceNoteProcessing(),
      VoiceNoteTranscriptReady(_transcript),
    ],
    verify: (_) {
      verify(() => repo.stopAndTranscribe()).called(1);
      verifyNever(() => repo.sendConfirmedTranscript(any()));
    },
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'confirm ("Haan"): TranscriptReady → Processing(sending) → Success',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteTranscriptReady(_transcript),
    act: (VoiceNoteCubit c) => c.confirm(),
    expect: () => const <VoiceNoteState>[
      VoiceNoteProcessing(sending: true),
      VoiceNoteSuccess(_outcome),
    ],
    verify: (_) =>
        verify(() => repo.sendConfirmedTranscript(_transcript)).called(1),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'edit then confirm sends the CORRECTED text, never the recogniser output',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteTranscriptReady(_transcript),
    act: (VoiceNoteCubit c) async {
      c.edit('VMC operator, 4 saal.');
      await c.confirm();
    },
    expect: () => const <VoiceNoteState>[
      VoiceNoteTranscriptReady('VMC operator, 4 saal.'),
      VoiceNoteProcessing(sending: true),
      VoiceNoteSuccess(VoiceNoteOutcome(
        transcript: 'VMC operator, 4 saal.',
        reply: 'Theek hai. Kaunsa control chalate hain?',
      )),
    ],
    verify: (_) {
      verify(() => repo.sendConfirmedTranscript('VMC operator, 4 saal.'))
          .called(1);
      verifyNever(() => repo.sendConfirmedTranscript(_transcript));
    },
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'a blank edit is ignored — the worker is never left with nothing to send',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteTranscriptReady(_transcript),
    act: (VoiceNoteCubit c) => c.edit('   '),
    expect: () => const <VoiceNoteState>[],
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'reRecord ("Sudhaarna hai" → dobara bolein) returns to idle and sends '
    'nothing',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteTranscriptReady(_transcript),
    act: (VoiceNoteCubit c) => c.reRecord(),
    expect: () => const <VoiceNoteState>[VoiceNoteIdle()],
    verify: (_) => verifyNever(() => repo.sendConfirmedTranscript(any())),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'confirm / edit / reRecord are no-ops outside the confirm turn',
    build: () => VoiceNoteCubit(repo),
    seed: () => const VoiceNoteRecording(3),
    act: (VoiceNoteCubit c) async {
      await c.confirm();
      c.edit('kuch bhi');
      c.reRecord();
    },
    expect: () => const <VoiceNoteState>[],
    verify: (_) => verifyNever(() => repo.sendConfirmedTranscript(any())),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'a blank transcript never becomes a confirm bubble — honest error instead',
    build: () {
      when(() => repo.stopAndTranscribe()).thenAnswer((_) async => '   ');
      return VoiceNoteCubit(repo);
    },
    seed: () => const VoiceNoteRecording(5),
    act: (VoiceNoteCubit c) => c.stopAndTranscribe(),
    expect: () => const <VoiceNoteState>[
      VoiceNoteProcessing(),
      VoiceNoteError(VoiceUnavailableFailure(kVoiceEmptyTranscript)),
    ],
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'stopAndTranscribe failure surfaces the honest Failure (e.g. 503 → '
    'unavailable)',
    build: () {
      when(() => repo.stopAndTranscribe())
          .thenThrow(const VoiceUnavailableFailure());
      return VoiceNoteCubit(repo);
    },
    seed: () => const VoiceNoteRecording(5),
    act: (VoiceNoteCubit c) => c.stopAndTranscribe(),
    expect: () => const <VoiceNoteState>[
      VoiceNoteProcessing(),
      VoiceNoteError(VoiceUnavailableFailure()),
    ],
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'a failed confirm-send surfaces the Failure (the answer is not silently '
    'lost)',
    build: () {
      when(() => repo.sendConfirmedTranscript(any()))
          .thenThrow(const NetworkFailure());
      return VoiceNoteCubit(repo);
    },
    seed: () => const VoiceNoteTranscriptReady(_transcript),
    act: (VoiceNoteCubit c) => c.confirm(),
    expect: () => const <VoiceNoteState>[
      VoiceNoteProcessing(sending: true),
      VoiceNoteError(NetworkFailure()),
    ],
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'stopAndTranscribe is a no-op when not recording',
    build: () => VoiceNoteCubit(repo),
    act: (VoiceNoteCubit c) => c.stopAndTranscribe(),
    expect: () => const <VoiceNoteState>[],
    verify: (_) => verifyNever(() => repo.stopAndTranscribe()),
  );

  blocTest<VoiceNoteCubit, VoiceNoteState>(
    'REGRESSION: the hard cap lands on the CONFIRM turn, it does NOT auto-send '
    '— running out of time is not consent',
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
      VoiceNoteTranscriptReady(_transcript),
    ],
    verify: (_) {
      verify(() => repo.stopAndTranscribe()).called(1);
      verifyNever(() => repo.sendConfirmedTranscript(any()));
    },
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
