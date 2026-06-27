import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/job_deck.dart';

/// The drag-direction side-band paints a [LinearGradient] via a [DecoratedBox];
/// at rest none is present. Collect any that are currently painted.
List<LinearGradient> _bandGradients(WidgetTester tester) {
  return tester
      .widgetList<DecoratedBox>(find.byType(DecoratedBox))
      .map((DecoratedBox d) => d.decoration)
      .whereType<BoxDecoration>()
      .map((BoxDecoration b) => b.gradient)
      .whereType<LinearGradient>()
      .toList();
}

JobDeckItem _item(String id, String title) => JobDeckItem(
      id: id,
      data: BbJobCardData(
        title: title,
        company: 'Sharma Works',
        payBand: '22-28k',
        place: 'Pimpri, Pune',
        shift: 'Day',
        tags: const <String>['Fanuc'],
        spotsLeft: 3,
      ),
    );

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: SizedBox(height: 640, child: child)),
    );

void main() {
  testWidgets('renders the head card with the apply/skip buttons', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    expect(find.text('First'), findsOneWidget);
    expect(find.byKey(const Key('swipeApplyButton')), findsOneWidget);
    expect(find.byKey(const Key('swipeSkipButton')), findsOneWidget);
  });

  testWidgets('the behind card is the next real job, full-fidelity', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    // The next job's real title (and its full card) is rendered behind the front
    // card — not a decorative silhouette.
    expect(find.text('Second'), findsOneWidget);
    // Two full BbJobCards are stacked (front + one behind), no third silhouette.
    expect(find.byType(BbJobCard), findsNWidgets(2));
  });

  testWidgets('no behind card when the queue has a single job', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'Only')],
      onApply: () {},
      onSkip: () {},
    )));

    expect(find.byType(BbJobCard), findsOneWidget);
  });

  testWidgets('no top APPLY / SKIP intent labels on the card', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    // J4 removed the boxed APPLY / SKIP overlays in favour of a side-band tint.
    expect(find.text('APPLY'), findsNothing);
    expect(find.text('SKIP'), findsNothing);
  });

  testWidgets('dragging right shows a green apply side-band tint', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    // Centred: no tint gradient is painted.
    expect(_bandGradients(tester), isEmpty);

    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(find.text('First')));
    await gesture.moveBy(const Offset(60, 0));
    await tester.pump();

    final List<LinearGradient> bands = _bandGradients(tester);
    expect(bands, isNotEmpty);
    // Edge stop carries the success colour; it fades to transparent at centre.
    final LinearGradient g = bands.first;
    expect(g.colors.first.a, greaterThan(0));
    expect(g.colors.first.r, AppColors.success.r);
    expect(g.colors.last.a, 0);

    await gesture.up();
    await tester.pumpAndSettle();
  });

  testWidgets('the Apply button commits and fires onApply once', (
    WidgetTester tester,
  ) async {
    int applied = 0;
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First')],
      onApply: () => applied++,
      onSkip: () {},
    )));

    await tester.tap(find.byKey(const Key('swipeApplyButton')));
    await tester.pumpAndSettle(); // run the off-screen commit animation

    expect(applied, 1);
  });

  testWidgets('the Skip button commits and fires onSkip once', (
    WidgetTester tester,
  ) async {
    int skipped = 0;
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First')],
      onApply: () {},
      onSkip: () => skipped++,
    )));

    await tester.tap(find.byKey(const Key('swipeSkipButton')));
    await tester.pumpAndSettle();

    expect(skipped, 1);
  });

  testWidgets('tapping the title fires onTitleTap with the head id', (
    WidgetTester tester,
  ) async {
    String? tappedId;
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First')],
      onApply: () {},
      onSkip: () {},
      onTitleTap: (String id) => tappedId = id,
    )));

    await tester.tap(find.text('First'));
    await tester.pumpAndSettle();

    expect(tappedId, 'j1');
  });

  testWidgets('a rightward fling commits to apply', (
    WidgetTester tester,
  ) async {
    int applied = 0;
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First')],
      onApply: () => applied++,
      onSkip: () {},
    )));

    await tester.fling(find.text('First'), const Offset(400, 0), 1200);
    await tester.pumpAndSettle();

    expect(applied, 1);
  });
}
