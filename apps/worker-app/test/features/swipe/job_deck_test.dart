import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/job_deck.dart';

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
