import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/util/devanagari_guard.dart';
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
    final Completer<String> pipeline = Completer<String>();
    when(() => repo.stopAndTranscribe()).thenAnswer((_) => pipeline.future);
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

  // ---- The confirm turn (Persona sheet, worked conversation #05) ----------

  group('confirm turn', () {
    /// Drives idle → recording → stop, resolving the transcribe leg with
    /// [transcript] so the screen lands on the confirm turn.
    Future<void> reachConfirm(
      WidgetTester tester, {
      String transcript = 'CNC par 4 saal ka anubhav.',
    }) async {
      when(() => repo.stopAndTranscribe()).thenAnswer((_) async => transcript);
      await tester.tap(find.byIcon(Icons.mic_rounded));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.text('Bhej dein'));
      await tester.pumpAndSettle();
    }

    testWidgets(
        'the transcript is SHOWN with the exact prompt and both chips, and '
        'nothing has been sent', (WidgetTester tester) async {
      await pumpScreen(tester);
      await reachConfirm(tester);

      expect(find.text('CNC par 4 saal ka anubhav.'), findsOneWidget);
      expect(find.text('Yeh theek hai?'), findsOneWidget);
      expect(find.text('Haan'), findsOneWidget);
      expect(find.text('Sudhaarna hai'), findsOneWidget);
      // THE INVARIANT: the recogniser's words are not the worker's answer until
      // they say so.
      verifyNever(() => repo.sendConfirmedTranscript(any()));
    });

    testWidgets('the confirm chips clear the 48px tap floor',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await reachConfirm(tester);

      for (final String label in <String>['Haan', 'Sudhaarna hai']) {
        expect(tester.getSize(find.ancestor(
              of: find.text(label),
              matching: find.byType(ConstrainedBox),
            ).first).height, greaterThanOrEqualTo(48),
            reason: '$label must stay thumb-sized');
      }
    });

    testWidgets('"Haan" sends the transcript exactly as shown',
        (WidgetTester tester) async {
      // Held open (never completed — no timers) so the screen stays on the send
      // leg. Letting it succeed would pop, and this harness has no GoRouter; the
      // pop-with-outcome path is covered in the #373 group below, on a real
      // router stack.
      final Completer<VoiceNoteOutcome> send = Completer<VoiceNoteOutcome>();
      when(() => repo.sendConfirmedTranscript(any()))
          .thenAnswer((_) => send.future);
      await pumpScreen(tester);
      await reachConfirm(tester);

      await tester.tap(find.text('Haan'));
      await tester.pump();

      verify(() => repo.sendConfirmedTranscript('CNC par 4 saal ka anubhav.'))
          .called(1);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets(
        '"Sudhaarna hai" offers BOTH an inline edit and a re-record',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await reachConfirm(tester);

      await tester.tap(find.text('Sudhaarna hai'));
      await tester.pumpAndSettle();

      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Dobara bolein'), findsOneWidget);
    });

    testWidgets('an inline edit is what gets sent, not the recogniser output',
        (WidgetTester tester) async {
      // Held open for the same reason as the "Haan" test above.
      final Completer<VoiceNoteOutcome> send = Completer<VoiceNoteOutcome>();
      when(() => repo.sendConfirmedTranscript(any()))
          .thenAnswer((_) => send.future);
      await pumpScreen(tester);
      await reachConfirm(tester);

      await tester.tap(find.text('Sudhaarna hai'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'VMC operator, 4 saal.');
      await tester.tap(find.text('Bhej dein'));
      await tester.pump();

      verify(() => repo.sendConfirmedTranscript('VMC operator, 4 saal.'))
          .called(1);
      verifyNever(
          () => repo.sendConfirmedTranscript('CNC par 4 saal ka anubhav.'));
      await tester.pumpWidget(const SizedBox.shrink());
    });

    group('Devanagari is blocked in the correction box (#1411)', () {
      testWidgets(
          'a Devanagari transcript is stripped the moment the edit box opens',
          (WidgetTester tester) async {
        await pumpScreen(tester);
        await reachConfirm(tester, transcript: 'मेने CNC par kaam kiya');

        await tester.tap(find.text('Sudhaarna hai'));
        await tester.pumpAndSettle();

        final TextField field =
            tester.widget<TextField>(find.byType(TextField));
        expect(field.controller!.text, isNot(contains(RegExp('[ऀ-ॿ]'))));
        expect(find.text(kDevanagariBlockedHint), findsOneWidget);
      });

      testWidgets('typing Devanagari into the edit box strips it too',
          (WidgetTester tester) async {
        await pumpScreen(tester);
        await reachConfirm(tester);

        await tester.tap(find.text('Sudhaarna hai'));
        await tester.pumpAndSettle();
        expect(find.text(kDevanagariBlockedHint), findsNothing);

        await tester.enterText(find.byType(TextField), 'फिर से काम किया');
        await tester.pump();

        final TextField field =
            tester.widget<TextField>(find.byType(TextField));
        expect(field.controller!.text, isNot(contains(RegExp('[ऀ-ॿ]'))));
        expect(find.text(kDevanagariBlockedHint), findsOneWidget);
      });

      testWidgets('a Roman-only edit never shows the notice',
          (WidgetTester tester) async {
        await pumpScreen(tester);
        await reachConfirm(tester);

        await tester.tap(find.text('Sudhaarna hai'));
        await tester.pumpAndSettle();
        await tester.enterText(
            find.byType(TextField), 'VMC operator, 4 saal.');
        await tester.pump();

        expect(find.text(kDevanagariBlockedHint), findsNothing);
      });
    });

    testWidgets('"Dobara bolein" returns to the idle mic and sends nothing',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await reachConfirm(tester);

      await tester.tap(find.text('Sudhaarna hai'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Dobara bolein'));
      await tester.pumpAndSettle();

      expect(find.text('Bol kar batayein'), findsOneWidget);
      verifyNever(() => repo.sendConfirmedTranscript(any()));
    });
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
    when(() => repo.stopAndTranscribe())
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

    /// Drives idle → recording → the TRANSCRIBE leg, held open by [pipeline].
    Future<void> reachProcessing(
      WidgetTester tester,
      Completer<String> pipeline,
    ) async {
      when(() => repo.stopAndTranscribe()).thenAnswer((_) => pipeline.future);
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
        'still reaches chat once the worker confirms',
        (WidgetTester tester) async {
      final Completer<String> pipeline = Completer<String>();
      final Future<VoiceNoteOutcome?> popped = await pushVoiceRoute(tester);
      await reachProcessing(tester, pipeline);

      // The impatient back press: blocked, and told the real reason. Pumped by
      // hand — the processing spinner animates indefinitely, so pumpAndSettle
      // can never settle here (same reason the chat typing cue is static).
      // #680.1 CHANGED THIS. #635 raised the transcribe budget to the server's
      // ~140s floor, which turned this hold into a 2.5-minute trap with only a
      // snackbar. The transcribe leg now offers an explicit abandon behind a
      // confirm; the SEND leg keeps the #373 hold (leaving there strands a
      // message the server already has). Back must still never pop SILENTLY.
      await tester.tap(find.byType(BackButton));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750)); // dialog in

      expect(find.text('HOME'), findsNothing,
          reason: 'back must not pop the route on its own');
      expect(find.text(kVoiceAbandonTitle), findsOneWidget,
          reason: 'the transcribe leg offers a way out, not a dead end');
      expect(find.text('Aapki baat likh rahe hain… thoda intezaar karein.'),
          findsOneWidget);

      // "Rukein" keeps them on the wait — the escape hatch is opt-in.
      await tester.tap(find.text(kVoiceAbandonStay));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750));
      expect(find.text('HOME'), findsNothing,
          reason: 'declining the abandon must leave the pipeline running');
      expect(find.text(kVoiceAbandonTitle), findsNothing);

      // The transcribe leg lands on the CONFIRM turn — still nothing sent.
      when(() => repo.sendConfirmedTranscript(any())).thenAnswer((_) async =>
          const VoiceNoteOutcome(
              transcript: 'CNC operator hoon', reply: 'Theek'));
      pipeline.complete('CNC operator hoon');
      // Drain the snackbar's auto-dismiss timer too (a pending timer at
      // teardown fails the test).
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();
      expect(find.text('Yeh theek hai?'), findsOneWidget);

      // "Haan" → the send leg → the screen pops WITH the outcome, so chat can
      // append the very bubbles the server now has.
      await tester.tap(find.text('Haan'));
      await tester.pumpAndSettle();

      expect(find.text('HOME'), findsOneWidget);
      final VoiceNoteOutcome? outcome = await popped;
      expect(outcome, isNotNull,
          reason: 'a null pop is exactly the #373 divergence');
      expect(outcome!.transcript, 'CNC operator hoon');
      expect(outcome.reply, 'Theek');
    });

    testWidgets(
        'the SEND leg holds back too, with its own honest reason — this is the '
        'leg the #373 divergence actually lives on',
        (WidgetTester tester) async {
      final Completer<VoiceNoteOutcome> send = Completer<VoiceNoteOutcome>();
      when(() => repo.stopAndTranscribe())
          .thenAnswer((_) async => 'CNC operator hoon');
      when(() => repo.sendConfirmedTranscript(any()))
          .thenAnswer((_) => send.future);
      await pushVoiceRoute(tester);

      await tester.tap(find.byIcon(Icons.mic_rounded));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.text('Bhej dein'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Haan'));
      await tester.pump();

      expect(find.text('Aapki baat bhej rahe hain… thoda intezaar karein.'),
          findsOneWidget);

      await tester.tap(find.byType(BackButton));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 750));

      expect(find.text('HOME'), findsNothing);
      expect(find.text(kVoiceBackBlockedSendingLabel), findsOneWidget);

      // Tear the tree down while the send hangs — ends the test clean.
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('the CONFIRM turn does not hold back — it is a decision point',
        (WidgetTester tester) async {
      when(() => repo.stopAndTranscribe())
          .thenAnswer((_) async => 'CNC operator hoon');
      final Future<VoiceNoteOutcome?> popped = await pushVoiceRoute(tester);

      await tester.tap(find.byIcon(Icons.mic_rounded));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.text('Bhej dein'));
      await tester.pumpAndSettle();
      expect(find.text('Yeh theek hai?'), findsOneWidget);

      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();

      // Nothing was sent, so leaving desynchronises nothing — and a worker who
      // changes their mind must never be trapped on the confirm screen.
      expect(find.text('HOME'), findsOneWidget);
      expect(await popped, isNull);
      verifyNever(() => repo.sendConfirmedTranscript(any()));
    });

    testWidgets('a failed pipeline releases back immediately — never a trap',
        (WidgetTester tester) async {
      final Completer<String> pipeline = Completer<String>();
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
