import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
}
