import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_filter.dart';
import 'package:badabhai_worker_app/features/swipe/domain/swipe_repository.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/bloc/swipe_bloc.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/swipe_jobs_screen.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/filters_sheet.dart';

class _MockSwipeRepository extends Mock implements SwipeRepository {}

FeedItem _job(
  String id,
  String tradeKey,
  String title, {
  String city = 'Pune',
}) =>
    FeedItem(
      jobId: id,
      tradeKey: tradeKey,
      title: title,
      city: city,
      area: null,
      rank: 1,
    );

/// A phone-tall surface so the deck + sheet CTA are on-screen.
void _tallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(400, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// The Feed's top chip row, as opposed to an identically-labelled sheet chip.
Finder _topChip(String label) => find.descendant(
      of: find.byType(SingleChildScrollView),
      matching: find.text(label),
    );

/// The header's location line specifically — a city name also appears on the
/// card face, so scope to the column that holds the eyebrow.
Finder _headerText(String label) => find.descendant(
      of: find
          .ancestor(
            of: find.text('JOBS FOR YOU'),
            matching: find.byType(Column),
          )
          .first,
      matching: find.text(label),
    );

/// Opens the Filters sheet, TOGGLES each named city chip, and applies.
Future<void> _selectCitiesInSheet(
  WidgetTester tester,
  List<String> cities,
) async {
  await tester.tap(find.byTooltip('Filter jobs'));
  await tester.pumpAndSettle();
  for (final String city in cities) {
    await tester.tap(find.descendant(
      of: find.byType(FiltersSheet),
      matching: find.text(city),
    ));
    await tester.pumpAndSettle();
  }
  await tester.tap(find.textContaining('Show '));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'changing the trade filter updates the visible deck on the home screen',
    (WidgetTester tester) async {
      _tallSurface(tester);

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

  // REGRESSION (the bug this change fixes): the top chip row was visual-only —
  // it wrote to a private `_chips` set that nothing filtered on, so tapping a
  // chip highlighted it and changed NOTHING. The row and the sheet now share one
  // FilterSelection, so a chip tap must narrow the deck exactly like the sheet.
  testWidgets('tapping a TOP-ROW chip narrows the deck (was visual-only)',
      (WidgetTester tester) async {
    _tallSurface(tester);

    final _MockSwipeRepository repo = _MockSwipeRepository();
    when(() => repo.getFeed()).thenAnswer((_) async => <FeedItem>[
          _job('cnc1', 'cnc_operator', 'CNC Operator'),
          _job('vmc1', 'vmc_setter', 'VMC Setter'),
        ]);

    final SwipeBloc bloc = SwipeBloc(repo);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: SwipeJobsScreen(bloc: bloc),
    ));
    await tester.pumpAndSettle();

    // Both jobs are in the deck and NO chip is pre-selected.
    expect(find.text('CNC Operator'), findsOneWidget);
    expect(bloc.state.filters.isEmpty, isTrue);

    // Tap the top-row VMC chip — no sheet involved.
    await tester.tap(_topChip('VMC'));
    await tester.pumpAndSettle();

    // It reached the bloc AND narrowed the deck.
    expect(bloc.state.filters.trades, <String>{'VMC'});
    expect(find.text('VMC Setter'), findsOneWidget);
    expect(find.text('CNC Operator'), findsNothing);

    // Tapping it again de-selects and restores the full deck (round-trip).
    await tester.tap(_topChip('VMC'));
    await tester.pumpAndSettle();
    expect(bloc.state.filters.isEmpty, isTrue);
    expect(find.text('CNC Operator'), findsOneWidget);
  });

  testWidgets(
    'the top chip row and the sheet share ONE filter state (a sheet selection '
    'paints the chip)',
    (WidgetTester tester) async {
      _tallSurface(tester);

      final _MockSwipeRepository repo = _MockSwipeRepository();
      when(() => repo.getFeed()).thenAnswer((_) async => <FeedItem>[
            _job('cnc1', 'cnc_operator', 'CNC Operator'),
            _job('vmc1', 'vmc_setter', 'VMC Setter'),
          ]);

      final SwipeBloc bloc = SwipeBloc(repo);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: SwipeJobsScreen(bloc: bloc),
      ));
      await tester.pumpAndSettle();

      // Select CNC in the SHEET...
      await tester.tap(find.byTooltip('Filter jobs'));
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(
        of: find.byType(FiltersSheet),
        matching: find.text('CNC'),
      ));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Show '));
      await tester.pumpAndSettle();

      // ...and the TOP-ROW chip reflects it (one source of truth). Tapping the
      // top-row CNC chip now CLEARS it rather than re-adding a duplicate.
      expect(bloc.state.filters.trades, <String>{'CNC'});
      await tester.tap(_topChip('CNC'));
      await tester.pumpAndSettle();
      expect(bloc.state.filters.trades, isEmpty);
      expect(find.text('VMC Setter'), findsOneWidget);
    },
  );

  // Every one of these was a claim the stack cannot back: there is no verified
  // flag and no shift on the /feed wire, and no distance/radius data anywhere —
  // so a "15 km" line was simply untrue. The header is now driven by the real
  // city filter state.
  testWidgets('shows no unbacked "Verified" / "Day shift" / "15 km" claims',
      (WidgetTester tester) async {
    _tallSurface(tester);

    final _MockSwipeRepository repo = _MockSwipeRepository();
    when(() => repo.getFeed()).thenAnswer(
        (_) async => <FeedItem>[_job('cnc1', 'cnc_operator', 'CNC Operator')]);

    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: SwipeJobsScreen(bloc: SwipeBloc(repo)),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Verified'), findsNothing);
    expect(find.text('Day shift'), findsNothing);
    expect(find.textContaining('15 km'), findsNothing);
    expect(find.textContaining('km'), findsNothing);
    // The feed applies NO location filter, so "near you" was untrue too.
    expect(find.text('JOBS NEAR YOU'), findsNothing);
    expect(find.text('JOBS FOR YOU'), findsOneWidget);
  });

  testWidgets('the header city line is driven by the REAL city filter state',
      (WidgetTester tester) async {
    _tallSurface(tester);

    final _MockSwipeRepository repo = _MockSwipeRepository();
    when(() => repo.getFeed()).thenAnswer((_) async => <FeedItem>[
          _job('c1', 'cnc_operator', 'CNC Operator', city: 'Pune'),
          _job('c2', 'cnc_operator', 'CNC Machinist', city: 'Nashik'),
          _job('c3', 'cnc_operator', 'CNC Setter', city: 'Aurangabad'),
        ]);

    final SwipeBloc bloc = SwipeBloc(repo);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: SwipeJobsScreen(bloc: bloc),
    ));
    await tester.pumpAndSettle();

    // No city filter ⇒ the honest line is "All cities" (never a hardcoded place
    // and never a "· 15 km" radius the stack cannot back).
    expect(_headerText('All cities'), findsOneWidget);

    // Exactly one city selected ⇒ that city's name.
    await _selectCitiesInSheet(tester, <String>['Pune']);
    expect(_headerText('Pune'), findsOneWidget);
    expect(_headerText('All cities'), findsNothing);

    // More than one ⇒ "<first> +N" over the sorted selection.
    await _selectCitiesInSheet(tester, <String>['Nashik']);
    expect(_headerText('Nashik +1'), findsOneWidget);
  });

  testWidgets('a filter matching no jobs shows the "no jobs match" empty state',
      (WidgetTester tester) async {
    _tallSurface(tester);

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
    bloc.add(const SwipeFiltersChanged(FilterSelection(
      trades: <String>{'CNC'},
      cities: <String>{},
      experienceBands: <String>{},
    )));
    await tester.pumpAndSettle();

    expect(find.text('No jobs match your filters.'), findsOneWidget);
    expect(find.text('Welder'), findsNothing);

    // Clearing restores the full deck.
    await tester.tap(find.text('Clear filters'));
    await tester.pumpAndSettle();
    expect(find.text('Welder'), findsOneWidget);
  });

  testWidgets(
    '"Clear filters" resets EVERY dimension, not just trades',
    (WidgetTester tester) async {
      _tallSurface(tester);

      final _MockSwipeRepository repo = _MockSwipeRepository();
      when(() => repo.getFeed()).thenAnswer((_) async => <FeedItem>[
            _job('weld1', 'welder', 'Welder', city: 'Pune'),
          ]);

      final SwipeBloc bloc = SwipeBloc(repo);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: SwipeJobsScreen(bloc: bloc),
      ));
      await tester.pumpAndSettle();

      // Narrow on a NON-trade dimension so nothing matches — the old "Clear
      // filters" only reset trades and would have left this stuck.
      bloc.add(const SwipeFiltersChanged(FilterSelection(
        trades: <String>{},
        cities: <String>{'Nashik'},
        experienceBands: <String>{},
      )));
      await tester.pumpAndSettle();
      expect(find.text('No jobs match your filters.'), findsOneWidget);

      await tester.tap(find.text('Clear filters'));
      await tester.pumpAndSettle();

      expect(bloc.state.filters.isEmpty, isTrue);
      expect(find.text('Welder'), findsOneWidget);
      expect(find.text('All cities'), findsOneWidget);
    },
  );
}
