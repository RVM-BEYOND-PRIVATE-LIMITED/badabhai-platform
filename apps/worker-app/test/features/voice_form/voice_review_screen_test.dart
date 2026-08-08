import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/voice_form/domain/clip_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_review_row.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/voice_review_screen.dart';

class CapturingClipPlayer implements ClipPlayer {
  final List<String> played = <String>[];
  @override
  Future<void> playFile(String path) async => played.add(path);
  @override
  Future<void> stop() async {}
}

void main() {
  const List<VoiceReviewRow> rows = <VoiceReviewRow>[
    VoiceReviewRow(
        questionId: 'q_trade',
        fieldLabel: 'Kaam',
        displayValue: 'Welder',
        hasChoices: true,
        clipPath: '/tmp/a.m4a'),
    VoiceReviewRow(
        questionId: 'q_salary',
        fieldLabel: 'Salary',
        displayValue: '₹18,000',
        numeric: true),
    VoiceReviewRow(
        questionId: 'q_vehicle',
        fieldLabel: 'Gaadi',
        displayValue: '',
        declined: true),
  ];

  Future<void> pump(
    WidgetTester t, {
    VoidCallback? onSubmit,
    void Function(String, CorrectionMethod)? onCorrect,
    ClipPlayer? clipPlayer,
    int inFlight = 0,
    VoidCallback? onDefer,
    List<VoiceReviewRow>? withRows,
  }) {
    return t.pumpWidget(MaterialApp(
      home: VoiceReviewScreen(
        rows: withRows ?? rows,
        onSubmit: onSubmit ?? () {},
        onCorrect: onCorrect ?? (_, __) {},
        clipPlayer: clipPlayer ?? const SilentClipPlayer(),
        inFlightCount: inFlight,
        onDeferSubmit: onDefer ?? (inFlight > 0 ? () {} : null),
      ),
    ));
  }

  testWidgets('renders a row per answer; declined shows "Nahi bataya"',
      (WidgetTester t) async {
    await pump(t);
    expect(find.text('Kaam'), findsOneWidget);
    expect(find.text('Welder'), findsOneWidget);
    expect(find.text('₹18,000'), findsOneWidget);
    expect(find.text('Nahi bataya'), findsOneWidget); // the declined row
  });

  testWidgets('"Sab theek hai" is the submit and fires onSubmit',
      (WidgetTester t) async {
    bool submitted = false;
    await pump(t, onSubmit: () => submitted = true);
    await t.tap(find.text('Sab theek hai'));
    expect(submitted, isTrue);
  });

  testWidgets('while clips are in flight, submit is disabled and defer is offered',
      (WidgetTester t) async {
    bool submitted = false;
    bool deferred = false;
    await pump(t,
        onSubmit: () => submitted = true,
        inFlight: 2,
        onDefer: () => deferred = true);

    expect(find.textContaining('Bheja ja raha hai'), findsOneWidget);
    await t.tap(find.text('Sab theek hai')); // disabled → no-op
    expect(submitted, isFalse);

    await t.tap(find.text('Baad mein bhejein'));
    expect(deferred, isTrue);
  });

  testWidgets('🔊 replays the worker\'s OWN clip (a local file)',
      (WidgetTester t) async {
    final CapturingClipPlayer player = CapturingClipPlayer();
    await pump(t, clipPlayer: player);
    await t.tap(find.byTooltip('Apni awaaz sunein').first);
    expect(player.played, <String>['/tmp/a.m4a']);
  });

  group('correction order is chips → mic → typing (#632)', () {
    testWidgets('with choices, all three appear in order', (WidgetTester t) async {
      await t.pumpWidget(const MaterialApp(
          home: Scaffold(body: VoiceCorrectionSheet(hasChoices: true))));

      final Iterable<ListTile> tiles = t.widgetList<ListTile>(find.byType(ListTile));
      final List<String> labels = tiles
          .map((ListTile w) => (w.title! as Text).data!)
          .toList();
      expect(labels,
          <String>['Chip se chunein', 'Dobara bolein', 'Type karke likhein']);
    });

    testWidgets('without choices, chips are omitted (mic → typing)',
        (WidgetTester t) async {
      await t.pumpWidget(const MaterialApp(
          home: Scaffold(body: VoiceCorrectionSheet(hasChoices: false))));
      expect(find.text('Chip se chunein'), findsNothing);
      final Iterable<ListTile> tiles = t.widgetList<ListTile>(find.byType(ListTile));
      final List<String> labels =
          tiles.map((ListTile w) => (w.title! as Text).data!).toList();
      expect(labels, <String>['Dobara bolein', 'Type karke likhein']);
    });
  });

  group('a correction is addressed by question id, never list position', () {
    testWidgets('tapping ⟲ on a row reports THAT row\'s questionId',
        (WidgetTester t) async {
      String? seen;
      await pump(t, onCorrect: (String id, CorrectionMethod _) => seen = id);

      // The SECOND row (Salary) — if the callback carried an index this would
      // be indistinguishable from any other row at position 1.
      await t.tap(find.byIcon(Icons.replay).at(1));
      await t.pumpAndSettle();
      await t.tap(find.text('Dobara bolein'));
      await t.pumpAndSettle();

      expect(seen, 'q_salary');
    });

    testWidgets(
        'a rows refresh WHILE the sheet is open cannot re-target the '
        'correction', (WidgetTester t) async {
      String? seen;
      await pump(t, onCorrect: (String id, CorrectionMethod _) => seen = id);

      await t.tap(find.byIcon(Icons.replay).at(1)); // Salary
      await t.pumpAndSettle();

      // The engine is adaptive: a refreshed AnswerMap drops a conditional row,
      // so everything below it shifts up by one. Position 1 is now a DIFFERENT
      // question. Keyed by index, the correction would land on it.
      await pump(t,
          onCorrect: (String id, CorrectionMethod _) => seen = id,
          withRows: const <VoiceReviewRow>[
            VoiceReviewRow(
                questionId: 'q_vehicle', fieldLabel: 'Gaadi', displayValue: ''),
            VoiceReviewRow(
                questionId: 'q_shift', fieldLabel: 'Shift', displayValue: 'Din'),
          ]);
      await t.pumpAndSettle();

      await t.tap(find.text('Dobara bolein'));
      await t.pumpAndSettle();

      expect(seen, 'q_salary',
          reason: 'the correction belongs to the row the worker tapped, not '
              'to whatever now occupies that position');
    });
  });

  group('a draining queue always leaves a way out', () {
    testWidgets('asserts an escape hatch exists when the CTA is disabled',
        (WidgetTester t) async {
      // Both buttons disabled with no defer callback would strand a worker who
      // has just answered the whole interview — #637 retries for up to 24h.
      expect(
        () => VoiceReviewScreen(
          rows: rows,
          onSubmit: () {},
          onCorrect: (_, __) {},
          inFlightCount: 2,
        ),
        throwsA(isA<AssertionError>()),
      );
    });

    testWidgets('with a defer callback the escape hatch is tappable',
        (WidgetTester t) async {
      bool deferred = false;
      await pump(t, inFlight: 2, onDefer: () => deferred = true);

      await t.tap(find.text('Baad mein bhejein'));
      await t.pump();
      expect(deferred, isTrue);
    });
  });
}
