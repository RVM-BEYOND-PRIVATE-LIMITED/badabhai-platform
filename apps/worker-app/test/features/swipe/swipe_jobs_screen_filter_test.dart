import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/filters_sheet.dart';

class _MockSwipeRepository extends Mock implements SwipeRepository {}

FeedItem _job(String id, String tradeKey, String title) => FeedItem(
      jobId: id,
      tradeKey: tradeKey,
      title: title,
      city: 'Pune',
      area: null,
      rank: 1,
    );

void main() {
  testWidgets(
    'changing the trade filter updates the visible deck on the home screen',
    (WidgetTester tester) async {
      // A phone-tall surface so the deck + sheet CTA are on-screen.
      tester.view.physicalSize = const Size(400, 1600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final _MockSwipeRepository repo = _MockSwipeRepository();
      when(() => repo.getFeed()).thenAnswer((_) async => <FeedItem>[
            _job('cnc1', 'cnc_operator', 'CNC Operator'),
            _job('vmc1', 'vmc_setter', 'VMC Setter'),
          ]);

      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: SwipeJobsScreen(bloc: SwipeBloc(repo)),
      ));
      await tester.pumpAndSettle();

      // Unfiltered (liberal): nothing is pre-selected, so BOTH trades show and
      // the head card is the first job.
      expect(find.text('CNC Operator'), findsOneWidget);

      // Open the Filters sheet and narrow to VMC by SELECTING it (the default is
      // empty — a liberal feed pre-selects no trade).
      await tester.tap(find.byTooltip('Filter jobs'));
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(
        of: find.byType(FiltersSheet),
        matching: find.text('VMC'),
      ));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Show '));
      await tester.pumpAndSettle();

      // The visible deck now reflects the filter: VMC shows, CNC is gone.
      expect(find.text('VMC Setter'), findsOneWidget);
      expect(find.text('CNC Operator'), findsNothing);
    },
  );

  testWidgets('a filter matching no jobs shows the "no jobs match" empty state',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final _MockSwipeRepository repo = _MockSwipeRepository();
    when(() => repo.getFeed()).thenAnswer(
        (_) async => <FeedItem>[_job('weld1', 'welder', 'Welder')]);

    final SwipeBloc bloc = SwipeBloc(repo);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: SwipeJobsScreen(bloc: bloc),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Welder'), findsOneWidget);

    // Filter to a trade the (single welder) job cannot match.
    bloc.add(const SwipeFiltersChanged(<String>{'CNC'}));
    await tester.pumpAndSettle();

    expect(find.text('No jobs match your filters.'), findsOneWidget);
    expect(find.text('Welder'), findsNothing);

    // Clearing restores the full deck.
    await tester.tap(find.text('Clear filters'));
    await tester.pumpAndSettle();
    expect(find.text('Welder'), findsOneWidget);
  });
}
