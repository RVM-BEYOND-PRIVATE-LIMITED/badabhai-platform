import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkAvailabilityDto;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_sheet.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_select_chip.dart';
import 'package:badabhai_worker_app/features/availability_prompt/domain/availability_prompt_gate.dart';
import 'package:badabhai_worker_app/features/availability_prompt/presentation/availability_prompt_sheet.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';

import '../../support/kit_matrix.dart';

class _MockProfileEditRepository extends Mock
    implements ProfileEditRepository {}

const AvailabilityPrompt _prompt = AvailabilityPrompt(
  options: <String, String>{
    'immediate': 'Immediately',
    'within_week': 'Within a week',
    'within_month': 'Within a month',
    'serving_notice': 'Serving notice',
  },
  stored: WorkAvailabilityDto(noticeDays: 15),
);

/// A screen with one button that opens the prompt, the way the home shell does.
class _Host extends StatelessWidget {
  const _Host({required this.repository, required this.results});

  final ProfileEditRepository repository;
  final List<bool> results;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Builder(
          builder: (BuildContext context) => TextButton(
            onPressed: () async => results.add(
              await showAvailabilityPromptSheet(
                context,
                prompt: _prompt,
                repository: repository,
              ),
            ),
            child: const Text('OPEN'),
          ),
        ),
      ),
    );
  }
}

void main() {
  late _MockProfileEditRepository repo;
  late List<bool> results;

  setUpAll(() => registerFallbackValue(<String, dynamic>{}));

  setUp(() {
    repo = _MockProfileEditRepository();
    results = <bool>[];
    when(() => repo.saveWorkPreferences(any())).thenAnswer((_) async {});
  });

  Future<void> open(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: _Host(repository: repo, results: results),
      ),
    );
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
  }

  bool saveEnabled(WidgetTester tester) => tester
      .widget<ElevatedButton>(find.byKey(kAvailabilityPromptSaveKey))
      .enabled;

  testWidgets('asks the question with one chip per served choice', (
    WidgetTester tester,
  ) async {
    await open(tester);

    expect(find.text(kAvailabilityPromptTitle), findsOneWidget);
    expect(find.text(kAvailabilityPromptSubtitle), findsOneWidget);
    expect(
      tester
          .widgetList<KitSelectChip>(find.byType(KitSelectChip))
          .map((KitSelectChip c) => c.label),
      <String>[
        'Immediately',
        'Within a week',
        'Within a month',
        'Serving notice',
      ],
    );
    expect(saveEnabled(tester), isFalse, reason: 'nothing is picked yet');
    expect(find.text(kAvailabilityPromptNotNowLabel), findsOneWidget);
  });

  testWidgets('pick + save writes the availability, closes and confirms', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await tester.tap(find.text('Within a week'));
    await tester.pump();
    expect(saveEnabled(tester), isTrue);

    await tester.tap(find.byKey(kAvailabilityPromptSaveKey));
    await tester.pumpAndSettle();

    verify(
      () => repo.saveWorkPreferences(<String, dynamic>{
        'touched_only': true,
        'availability': <String, dynamic>{
          'status': 'within_week',
          'available_from': null,
          'notice_period_days': 15,
        },
      }),
    ).called(1);
    expect(find.text(kAvailabilityPromptTitle), findsNothing);
    expect(results, <bool>[true]);
    expect(find.text(kAvailabilityPromptSavedMessage), findsOneWidget);
  });

  testWidgets('a save error keeps the sheet open, with the reason', (
    WidgetTester tester,
  ) async {
    when(
      () => repo.saveWorkPreferences(any()),
    ).thenThrow(const NetworkFailure());
    await open(tester);

    await tester.tap(find.text('Immediately'));
    await tester.pump();
    await tester.tap(find.byKey(kAvailabilityPromptSaveKey));
    await tester.pumpAndSettle();

    expect(find.text(kAvailabilityPromptTitle), findsOneWidget);
    expect(
      find.text('Server se connect nahi ho pa raha. Dobara try karein.'),
      findsOneWidget,
    );
    expect(saveEnabled(tester), isTrue, reason: 'a retry is one tap away');
    expect(results, isEmpty);
  });

  testWidgets('"Abhi nahi" closes it and writes nothing', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await tester.tap(find.text('Serving notice'));
    await tester.pump();
    await tester.tap(find.text(kAvailabilityPromptNotNowLabel));
    await tester.pumpAndSettle();

    expect(find.text(kAvailabilityPromptTitle), findsNothing);
    expect(results, <bool>[false]);
    verifyNever(() => repo.saveWorkPreferences(any()));
    expect(find.text(kAvailabilityPromptSavedMessage), findsNothing);
  });

  testWidgets('a tap outside the sheet is a "not now" too', (
    WidgetTester tester,
  ) async {
    await open(tester);

    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();

    expect(find.text(kAvailabilityPromptTitle), findsNothing);
    expect(results, <bool>[false]);
    verifyNever(() => repo.saveWorkPreferences(any()));
  });

  testWidgets('a swipe down is a "not now" too', (WidgetTester tester) async {
    await open(tester);

    await tester.fling(find.byType(BbSheetGrip), const Offset(0, 400), 2000);
    await tester.pumpAndSettle();

    expect(find.text(kAvailabilityPromptTitle), findsNothing);
    expect(results, <bool>[false]);
  });

  testWidgets('system back is a "not now" too', (WidgetTester tester) async {
    await open(tester);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(find.text(kAvailabilityPromptTitle), findsNothing);
    expect(results, <bool>[false]);
  });

  // The save's PUT is in flight: closing now would let it land behind a sheet
  // the worker already dismissed. Every way out waits for the answer.
  group('while the save is in flight, nothing closes the sheet', () {
    late Completer<void> inFlight;

    /// Picks a choice and taps save, leaving the PUT unanswered. No
    /// pumpAndSettle while it is in flight: the save CTA shows a spinner.
    ///
    /// The completer is made HERE, inside the test's fake-async zone: one made
    /// in setUp would resume the save outside it, and the test would never
    /// see the answer land.
    Future<void> startSave(WidgetTester tester) async {
      inFlight = Completer<void>();
      when(
        () => repo.saveWorkPreferences(any()),
      ).thenAnswer((_) => inFlight.future);
      await open(tester);
      await tester.tap(find.text('Within a week'));
      await tester.pump();
      await tester.tap(find.byKey(kAvailabilityPromptSaveKey));
      await tester.pump();
    }

    Future<void> settleFrames(WidgetTester tester) async {
      for (int i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    /// Still open and unanswered; then the server answers and it closes as a
    /// save.
    Future<void> expectHeldUntilTheAnswer(WidgetTester tester) async {
      expect(find.text(kAvailabilityPromptTitle), findsOneWidget);
      expect(results, isEmpty);

      inFlight.complete();
      await tester.pumpAndSettle();
      expect(find.text(kAvailabilityPromptTitle), findsNothing);
      expect(results, <bool>[true]);
      expect(find.text(kAvailabilityPromptSavedMessage), findsOneWidget);
    }

    testWidgets('not system back', (WidgetTester tester) async {
      await startSave(tester);

      await tester.binding.handlePopRoute();
      await settleFrames(tester);

      await expectHeldUntilTheAnswer(tester);
    });

    testWidgets('not a tap on the scrim', (WidgetTester tester) async {
      await startSave(tester);

      await tester.tapAt(const Offset(10, 10));
      await settleFrames(tester);

      await expectHeldUntilTheAnswer(tester);
    });

    testWidgets('not a swipe down', (WidgetTester tester) async {
      await startSave(tester);

      await tester.fling(find.byType(BbSheetGrip), const Offset(0, 400), 2000);
      await settleFrames(tester);

      await expectHeldUntilTheAnswer(tester);
    });

    testWidgets('a failed save lets go again: back is a "not now"', (
      WidgetTester tester,
    ) async {
      await startSave(tester);
      inFlight.completeError(const NetworkFailure());
      await tester.pumpAndSettle();
      expect(find.text(kAvailabilityPromptTitle), findsOneWidget);

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      expect(find.text(kAvailabilityPromptTitle), findsNothing);
      expect(results, <bool>[false]);
    });
  });

  // Every device size and system font the kit pins: nothing overflows and the
  // save CTA stays on screen (it is docked, so the choices scroll instead).
  kitMatrixTest(
    'the availability prompt',
    () => _Host(repository: _MockProfileEditRepository(), results: <bool>[]),
    arrange: (WidgetTester tester) async {
      await tester.tap(find.text('OPEN'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    },
    primary: () => find.byKey(kAvailabilityPromptSaveKey),
  );
}
