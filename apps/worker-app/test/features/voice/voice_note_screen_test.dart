import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_models.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_note_repository.dart';
import 'package:badabhai_worker_app/features/voice/presentation/cubit/voice_note_cubit.dart';
import 'package:badabhai_worker_app/features/voice/presentation/voice_note_screen.dart';

class MockVoiceNoteRepository extends Mock implements VoiceNoteRepository {}

void main() {
  late MockVoiceNoteRepository repo;

  setUp(() async {
    repo = MockVoiceNoteRepository();
    // Swap the real graph for a cubit backed by a mock repo — the screen
    // resolves `locator<VoiceNoteCubit>()` exactly as in production (mirrors
    // chat_profiling_screen_test).
    await locator.reset();
    locator.registerFactory<VoiceNoteCubit>(() => VoiceNoteCubit(repo));
    when(() => repo.ensureMicPermission()).thenAnswer((_) async => true);
    when(() => repo.startRecording()).thenAnswer((_) async {});
    when(() => repo.cancelRecording()).thenAnswer((_) async {});
  });

  tearDown(() async => locator.reset());

  Future<void> pumpScreen(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: VoiceNoteScreen()));
    await tester.pumpAndSettle();
  }

  testWidgets('idle: warm Hinglish invite + a mic hero well above 48px',
      (WidgetTester tester) async {
    await pumpScreen(tester);

    expect(find.text('Bol kar batayein'), findsOneWidget);
    expect(find.byIcon(Icons.mic_rounded), findsOneWidget);
    // Touch targets are sacred (≥48px): the mic hero is 96x96.
    final Size micSize = tester.getSize(
      find.ancestor(
        of: find.byIcon(Icons.mic_rounded),
        matching: find.byType(SizedBox),
      ).first,
    );
    expect(micSize.width, greaterThanOrEqualTo(48));
    expect(micSize.height, greaterThanOrEqualTo(48));
  });

  testWidgets('tapping the mic starts recording: counter + send + cancel',
      (WidgetTester tester) async {
    await pumpScreen(tester);

    await tester.tap(find.byIcon(Icons.mic_rounded));
    await tester.pump();
    await tester.pump();

    expect(find.text('0:00 / 2:00'), findsOneWidget);
    expect(find.text('Bhej dein'), findsOneWidget);
    expect(find.text('Cancel karein'), findsOneWidget);
  });

  testWidgets('cancel while recording returns to the idle invite',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await tester.tap(find.byIcon(Icons.mic_rounded));
    await tester.pump();
    await tester.pump();

    await tester.tap(find.text('Cancel karein'));
    await tester.pumpAndSettle();

    expect(find.text('Bol kar batayein'), findsOneWidget);
    verify(() => repo.cancelRecording()).called(1);
  });

  testWidgets('stop → processing spinner with honest caption',
      (WidgetTester tester) async {
    // Hold the pipeline open (a Completer, never completed — no timers) so the
    // processing state stays visible.
    final Completer<VoiceNoteOutcome> pipeline = Completer<VoiceNoteOutcome>();
    when(() => repo.stopRecordingAndTranscribe())
        .thenAnswer((_) => pipeline.future);
    await pumpScreen(tester);
    await tester.tap(find.byIcon(Icons.mic_rounded));
    await tester.pump();
    await tester.pump();

    await tester.tap(find.text('Bhej dein'));
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(
      find.text('Aapki baat likh rahe hain… thoda intezaar karein.'),
      findsOneWidget,
    );
    // Tear the tree down while the pipeline hangs — ends the test clean.
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets(
      'mic permission denied shows the honest error + typing fallback, '
      'and retry returns to idle', (WidgetTester tester) async {
    when(() => repo.ensureMicPermission()).thenAnswer((_) async => false);
    await pumpScreen(tester);

    await tester.tap(find.byIcon(Icons.mic_rounded));
    await tester.pumpAndSettle();

    expect(find.text('Voice note nahi gaya.'), findsOneWidget);
    expect(find.textContaining('Mic ki permission nahi mili'), findsOneWidget);
    expect(find.text('Type karke bhejein'), findsOneWidget);

    await tester.tap(find.text('Dobara try karein'));
    await tester.pumpAndSettle();
    expect(find.text('Bol kar batayein'), findsOneWidget);
  });

  testWidgets('pipeline failure surfaces the honest voice-unavailable copy',
      (WidgetTester tester) async {
    when(() => repo.stopRecordingAndTranscribe())
        .thenThrow(const VoiceUnavailableFailure());
    await pumpScreen(tester);
    await tester.tap(find.byIcon(Icons.mic_rounded));
    await tester.pump();
    await tester.pump();

    await tester.tap(find.text('Bhej dein'));
    await tester.pumpAndSettle();

    expect(find.text('Voice note nahi gaya.'), findsOneWidget);
    expect(
      find.text('Voice note abhi available nahi hai. Type karke bhejein.'),
      findsOneWidget,
    );
  });

  // #373 — backing out during Processing used to pop a NULL outcome while the
  // detached pipeline still merged the transcript into the SERVER chat session:
  // the answer landed server-side and never rendered in chat, so the worker
  // re-answered and extraction saw it twice. Back is now HELD until the
  // pipeline is terminal, so the outcome always reaches chat.
  group('back during Processing (#373)', () {
    /// Mounts the voice screen on a real router stack (a home route to pop back
    /// to) and returns the future the pushed route completes with — i.e. the
    /// exact value ChatProfilingScreen awaits from `context.push`.
    Future<Future<VoiceNoteOutcome?>> pushVoiceRoute(
      WidgetTester tester,
    ) async {
      final GoRouter router = GoRouter(
        initialLocation: '/home',
        routes: <RouteBase>[
          GoRoute(
            path: '/home',
            builder: (_, __) =>
                const Scaffold(body: Center(child: Text('HOME'))),
          ),
          GoRoute(
            path: '/voice',
            builder: (_, __) => const VoiceNoteScreen(),
          ),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();
      final Future<VoiceNoteOutcome?> popped =
          router.push<VoiceNoteOutcome>('/voice');
      await tester.pumpAndSettle();
      return popped;
    }

    /// Drives idle → recording → processing with [pipeline] held open.
    Future<void> reachProcessing(
      WidgetTester tester,
      Completer<VoiceNoteOutcome> pipeline,
    ) async {
      when(() => repo.stopRecordingAndTranscribe())
          .thenAnswer((_) => pipeline.future);
      await tester.tap(find.byIcon(Icons.mic_rounded));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.text('Bhej dein'));
      await tester.pump();
      expect(find.text('Aapki baat likh rahe hain… thoda intezaar karein.'),
          findsOneWidget);
    }

    testWidgets(
        'the back button does not pop mid-pipeline and says why; the outcome '
        'still reaches chat when it lands', (WidgetTester tester) async {
      final Completer<VoiceNoteOutcome> pipeline = Completer<VoiceNoteOutcome>();
      final Future<VoiceNoteOutcome?> popped = await pushVoiceRoute(tester);
      await reachProcessing(tester, pipeline);

      // The impatient back press: blocked, and told the real reason. Pumped by
      // hand — the processing spinner animates indefinitely, so pumpAndSettle
      // can never settle here (same reason the chat typing cue is static).
      await tester.tap(find.byType(BackButton));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750)); // snackbar in

      expect(find.text('HOME'), findsNothing,
          reason: 'the route must not pop while the transcript is in flight');
      expect(find.text('Aapki baat likh rahe hain… thoda intezaar karein.'),
          findsOneWidget);
      expect(find.text(kVoiceBackBlockedLabel), findsOneWidget,
          reason: 'a blocked back press must never be a silent no-op');

      // Pipeline lands → the screen pops WITH the outcome, so chat can append
      // the very bubbles the server already has.
      pipeline.complete(
        const VoiceNoteOutcome(transcript: 'CNC operator hoon', reply: 'Theek'),
      );
      await tester.pump(); // Success emitted → listener pops with the outcome
      // Drain the pop transition AND the snackbar's auto-dismiss timer (a
      // pending timer at teardown fails the test).
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();

      expect(find.text('HOME'), findsOneWidget);
      final VoiceNoteOutcome? outcome = await popped;
      expect(outcome, isNotNull,
          reason: 'a null pop is exactly the #373 divergence');
      expect(outcome!.transcript, 'CNC operator hoon');
      expect(outcome.reply, 'Theek');
    });

    testWidgets('a failed pipeline releases back immediately — never a trap',
        (WidgetTester tester) async {
      final Completer<VoiceNoteOutcome> pipeline = Completer<VoiceNoteOutcome>();
      await pushVoiceRoute(tester);
      await reachProcessing(tester, pipeline);

      pipeline.completeError(const VoiceUnavailableFailure());
      await tester.pumpAndSettle();
      expect(find.text('Voice note nahi gaya.'), findsOneWidget);

      // Error is terminal: the hold is lifted and the worker can leave.
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      expect(find.text('HOME'), findsOneWidget);
    });

    testWidgets('back while merely recording still pops (the hold is scoped)',
        (WidgetTester tester) async {
      await pushVoiceRoute(tester);
      await tester.tap(find.byIcon(Icons.mic_rounded));
      await tester.pump();
      await tester.pump();
      expect(find.text('0:00 / 2:00'), findsOneWidget);

      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();

      expect(find.text('HOME'), findsOneWidget);
      // Nothing is in flight server-side yet, and the mic is released on close.
      verify(() => repo.cancelRecording()).called(1);
    });
  });
}
