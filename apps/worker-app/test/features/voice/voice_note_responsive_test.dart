import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/voice/domain/voice_note_repository.dart';
import 'package:badabhai_worker_app/features/voice/presentation/cubit/voice_note_cubit.dart';
import 'package:badabhai_worker_app/features/voice/presentation/voice_note_screen.dart';

import '../../support/kit_matrix.dart';

class _MockRepo extends Mock implements VoiceNoteRepository {}

/// D13 for the voice note — every state of it, on every device shape, at 100%
/// / 150% / 200% system font.
///
/// This screen has four bodies (invite, recording, the confirm turn, the honest
/// error) and each one is a full-height hero layout, which is exactly the shape
/// that overflows on a 568dp handset at a large accessibility font. A worker
/// who cannot reach "Bhej dein" cannot answer bada bhai by voice at all — the
/// fallback the whole feature exists to provide.
void main() {
  late _MockRepo repo;

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    locator.registerFactory<VoiceNoteCubit>(() => VoiceNoteCubit(repo));
    when(() => repo.ensureMicPermission()).thenAnswer((_) async => true);
    when(() => repo.startRecording()).thenAnswer((_) async {});
    when(() => repo.cancelRecording()).thenAnswer((_) async {});
    when(
      () => repo.stopAndTranscribe(),
    ).thenAnswer((_) async => 'CNC par 4 saal ka anubhav.');
  });

  tearDown(() => locator.reset());

  /// Taps the mic hero. `ensureVisible` first: at 320dp and 200% font the hero
  /// can sit under the fold, and a tap on an off-screen widget is not a tap.
  Future<void> startRecording(WidgetTester tester) async {
    final Finder mic = find.byIcon(Icons.mic_rounded);
    await tester.ensureVisible(mic);
    await tester.pump();
    await tester.tap(mic);
    await tester.pump();
    await tester.pump();
  }

  /// Records, stops, and lands on the confirm turn with a real transcript.
  Future<void> reachConfirm(WidgetTester tester) async {
    await startRecording(tester);
    final Finder send = find.text('Bhej dein');
    await tester.ensureVisible(send);
    await tester.pump();
    await tester.tap(send);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  kitMatrixTest(
    'voice idle keeps the mic hero and its invite on screen',
    () => const VoiceNoteScreen(),
    primary: () => find.text('Bol kar batayein'),
    arrange: (WidgetTester tester) async {
      expect(find.byIcon(Icons.mic_rounded), findsOneWidget);
    },
  );

  kitMatrixTest(
    'voice recording keeps the clock and both CTAs reachable',
    () => const VoiceNoteScreen(),
    primary: () => find.text('Cancel karein'),
    arrange: (WidgetTester tester) async {
      await startRecording(tester);
      expect(find.text('0:00 / 2:00'), findsOneWidget);
      expect(find.text('Bhej dein'), findsOneWidget);
    },
  );

  kitMatrixTest(
    'the confirm turn keeps the read-back and both chips reachable',
    () => const VoiceNoteScreen(),
    primary: () => find.text(kVoiceConfirmFixLabel),
    arrange: (WidgetTester tester) async {
      await reachConfirm(tester);
      expect(find.text('CNC par 4 saal ka anubhav.'), findsOneWidget);
      expect(find.text(kVoiceConfirmPrompt), findsOneWidget);
      expect(find.text(kVoiceConfirmYesLabel), findsOneWidget);
    },
  );

  kitMatrixTest(
    'a denied mic never dead-ends: the reason and the typing fallback both fit',
    () => const VoiceNoteScreen(),
    primary: () => find.text('Type karke bhejein'),
    arrange: (WidgetTester tester) async {
      when(() => repo.ensureMicPermission()).thenAnswer((_) async => false);
      await startRecording(tester);
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('Voice note nahi gaya.'), findsOneWidget);
    },
  );

  testWidgets(
    'the correction box is reachable with the keyboard up on a 568dp handset',
    (WidgetTester tester) async {
      // The one state with a text field, on the shape where a keyboard leaves
      // the least room.
      setKitSurface(tester, const Size(320, 568), keyboard: 300);
      await tester.pumpWidget(kitTestApp(const VoiceNoteScreen()));
      await tester.pump();
      await reachConfirm(tester);

      final Finder fix = find.text(kVoiceConfirmFixLabel);
      await tester.ensureVisible(fix);
      await tester.pump();
      await tester.tap(fix);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);
      expect(find.byType(TextField), findsOneWidget);
      // The send CTA under the box must still be reachable by scrolling.
      await tester.scrollUntilVisible(
        find.text('Bhej dein'),
        120,
        scrollable: find.byType(Scrollable).first,
      );
      expect(find.text('Bhej dein'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('the body column stops at 440 on a tablet', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(const VoiceNoteScreen()));
    await tester.pump();

    // The hero is a 96dp DISC, not a full-width ink target with a disc painted
    // in the middle of it: tapping the canvas beside the mic must do nothing.
    expect(
      widthOf(
        tester,
        find
            .ancestor(
              of: find.byIcon(Icons.mic_rounded),
              matching: find.byType(Material),
            )
            .first,
      ),
      96,
      reason: 'the mic must not stretch to the column width',
    );

    await startRecording(tester);

    expect(
      widthOf(tester, find.widgetWithText(BbButton, 'Bhej dein')),
      440,
      reason: 'a block CTA must not stretch across 768dp of glass',
    );
    expect(
      tester.getCenter(find.text('0:00 / 2:00')).dx,
      closeTo(384, 1),
      reason: 'the capped column centres',
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('tap targets clear 48dp on a real handset — idle and confirm', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(const VoiceNoteScreen()));
    await tester.pump();

    await expectKitTapTargets(tester);

    await reachConfirm(tester);
    await expectKitTapTargets(tester);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
