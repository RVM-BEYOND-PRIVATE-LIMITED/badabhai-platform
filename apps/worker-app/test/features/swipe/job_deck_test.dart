import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/job_deck.dart';

/// The drag tint bands paint a [LinearGradient] via a [DecoratedBox]; at rest
/// none is present. Collect any that are currently painted.
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

  testWidgets('dragging right shows the green apply tint on the LEFT (swapped)',
      (
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
    final LinearGradient g = bands.first;
    // Green (success) edge fading to transparent at centre...
    expect(g.colors.first.a, greaterThan(0));
    expect(g.colors.first.r, AppColors.success.r);
    expect(g.colors.last.a, 0);
    // ...anchored on the LEFT (opposite the drag) after the J4 side swap.
    expect(g.begin, Alignment.centerLeft);
    expect(g.end, Alignment.center);

    await gesture.up();
    await tester.pumpAndSettle();
  });

  testWidgets('dragging left shows the red skip tint on the RIGHT (swapped)', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(find.text('First')));
    await gesture.moveBy(const Offset(-60, 0));
    await tester.pump();

    final List<LinearGradient> bands = _bandGradients(tester);
    expect(bands, isNotEmpty);
    final LinearGradient g = bands.first;
    expect(g.colors.first.a, greaterThan(0));
    expect(g.colors.first.r, AppColors.danger.r);
    // Red anchored on the RIGHT (opposite the drag).
    expect(g.begin, Alignment.centerRight);

    await gesture.up();
    await tester.pumpAndSettle();
  });

  // #374 — this test used to assert the OPPOSITE: that dragging up ramped a
  // golden saffron "add to Priority" band. That action was deleted (an empty
  // repository no-op that still toasted success) but the tint survived, so the
  // card charged up committed-looking feedback and then snapped back. The
  // up-drag must now be silent: follow-the-finger only, no tint at all.
  testWidgets('dragging up paints NO tint — the Priority affordance is gone', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    // At rest: no tint at all.
    expect(_bandGradients(tester), isEmpty);

    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(find.text('First')));
    await gesture.moveBy(const Offset(0, -60));
    await tester.pump();

    // Still nothing — and in particular nothing saffron.
    expect(_bandGradients(tester), isEmpty);

    await gesture.up();
    await tester.pumpAndSettle();
  });

  // #374 — the up-drag also used to PROMOTE the behind card (slide it up to the
  // front position), which reads as "a commit is about to land" for a gesture
  // that commits nothing. Promotion is horizontal-only now.
  testWidgets('dragging up does not promote the behind card', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    final double restY = tester.getTopLeft(find.text('Second')).dy;

    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(find.text('First')));
    await gesture.moveBy(const Offset(0, -120));
    await tester.pump();

    // The behind card has not budged from its resting peek.
    expect(tester.getTopLeft(find.text('Second')).dy, restY);

    await gesture.up();
    await tester.pumpAndSettle();

    // A horizontal drag, by contrast, still promotes it.
    final TestGesture sideways =
        await tester.startGesture(tester.getCenter(find.text('First')));
    await sideways.moveBy(const Offset(120, 0));
    await tester.pump();
    expect(tester.getTopLeft(find.text('Second')).dy, lessThan(restY));

    await sideways.up();
    await tester.pumpAndSettle();
  });

  // #363 — a drag frame must NOT rebuild the deck. The card subtrees are built
  // once and handed to the ValueListenableBuilders as `child`, so the same
  // BbJobCard widget instance survives a pointer move; under the old
  // setState-per-pan-update the whole deck (both cards, band and CTA row) was
  // rebuilt from scratch on every frame.
  testWidgets('a drag frame reuses the card widgets instead of rebuilding', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    List<BbJobCard> cards() => tester.widgetList<BbJobCard>(
          find.byType(BbJobCard),
        ).toList();

    final List<BbJobCard> before = cards();
    final TestGesture gesture =
        await tester.startGesture(tester.getCenter(find.text('First')));
    await gesture.moveBy(const Offset(40, 0));
    await tester.pump();

    final List<BbJobCard> after = cards();
    expect(after.length, before.length);
    for (int i = 0; i < before.length; i++) {
      expect(identical(before[i], after[i]), isTrue,
          reason: 'BbJobCard #$i was rebuilt during a drag frame');
    }

    await gesture.up();
    await tester.pumpAndSettle();
  });

  // #363 — each card sits behind a RepaintBoundary so the drag only
  // re-composites a cached raster instead of re-rasterizing BbFestiveCard's
  // blur-20 shadow and its per-dash-segment CustomPaint border every frame.
  testWidgets('each job card is isolated behind a RepaintBoundary', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    // Asserted on the DIRECT parent: MaterialApp/Scaffold already contribute a
    // couple of ambient RepaintBoundary ancestors, so a plain `find.ancestor`
    // would pass even with no boundary of our own.
    expect(
      find.byWidgetPredicate(
        (Widget w) => w is RepaintBoundary && w.child is BbJobCard,
      ),
      findsNWidgets(2),
      reason: 'front and behind cards must each sit under their own boundary',
    );
  });

  // #375 — the skip circle is icon-only; TalkBack announced just "button".
  testWidgets('the skip button carries a spoken label', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First')],
      onApply: () {},
      onSkip: () {},
    )));

    expect(find.bySemanticsLabel(kSkipSemanticLabel), findsOneWidget);
    handle.dispose();
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

  // The up-swipe used to "add to Priority" — a repository no-op that still fired
  // a success toast. It is gone: a vertical fling must now simply spring back
  // and commit nothing.
  testWidgets('an upward fling commits nothing (springs back)', (
    WidgetTester tester,
  ) async {
    int applied = 0;
    int skipped = 0;
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First')],
      onApply: () => applied++,
      onSkip: () => skipped++,
    )));

    await tester.fling(find.text('First'), const Offset(0, -400), 1200);
    await tester.pumpAndSettle();

    expect(applied, 0);
    expect(skipped, 0);
    // The card is still there, settled back at rest.
    expect(find.text('First'), findsOneWidget);
  });

  // #363 — the queue advance resets the drag from didUpdateWidget, i.e. from
  // inside a build pass. Guards the notifier reset against a "markNeedsBuild
  // called during build" regression and proves the new head lands at rest.
  testWidgets('advancing the queue settles the new head back at centre', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j1', 'First'), _item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));

    final Offset restTopLeft = tester.getTopLeft(find.text('First'));

    await tester.tap(find.byKey(const Key('swipeApplyButton')));
    await tester.pumpAndSettle(); // fly the head off-screen

    // Parent accepts the decision and advances the queue.
    await tester.pumpWidget(_host(JobDeck(
      cards: <JobDeckItem>[_item('j2', 'Second')],
      onApply: () {},
      onSkip: () {},
    )));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('First'), findsNothing);
    // The promoted card sits exactly where the front card rests, not off-screen.
    expect(tester.getTopLeft(find.text('Second')), restTopLeft);
  });
}
