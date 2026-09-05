import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
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

/// Types [query] into the header's unified filter-search field and taps the
/// suggestion with [suggestionKey] (e.g. `jobFilterSuggestion_trade_VMC`) to
/// apply it — the search+suggestions+removable-chip row replaced the old
/// static CNC/VMC/"Sabhi" chip row.
Future<void> _applyFilterViaSearch(
  WidgetTester tester,
  String query,
  String suggestionKey,
) async {
  await tester.enterText(
      find.byKey(const Key('jobFilterSearchField')), query);
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(Key(suggestionKey)));
  await tester.pumpAndSettle();
}

/// Removes an already-applied filter via its chip in the header's horizontal
/// row (e.g. `jobFilterChip_trade_VMC`).
Future<void> _removeActiveChip(WidgetTester tester, String chipKey) async {
  await tester.tap(find.byKey(Key(chipKey)));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() async {
    await locator.reset();
    // The screen refetches on tab focus (T4) and resolves this from the locator.
    locator.registerLazySingleton<TabFocus>(() => TabFocus());
  });

  tearDown(() async => locator.reset());

  testWidgets(
    'changing the trade filter updates the visible deck on the home screen',
    (WidgetTester tester) async {
      _tallSurface(tester);

      final _MockSwipeRepository repo = _MockSwipeRepository();
      when(() => repo.getFeed(tradeKey: any(named: 'tradeKey'), city: any(named: 'city'), shift: any(named: 'shift'), payMin: any(named: 'payMin'))).thenAnswer((_) async => <FeedItem>[
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

  // REGRESSION guard for the bug the chip-row-to-search-box rewrite must not
  // reintroduce: the OLD top chip row once wrote to a private `_chips` set
  // that nothing filtered on, so tapping a chip highlighted it and changed
  // NOTHING. The header search box and the sheet share the SAME
  // FilterSelection, so applying a filter via search must narrow the deck
  // exactly like the sheet does — and removing it must restore the deck.
  testWidgets(
      'applying a filter via the header search narrows the deck, removing it '
      'restores the deck (was visual-only)', (WidgetTester tester) async {
    _tallSurface(tester);

    final _MockSwipeRepository repo = _MockSwipeRepository();
    when(() => repo.getFeed(tradeKey: any(named: 'tradeKey'), city: any(named: 'city'), shift: any(named: 'shift'), payMin: any(named: 'payMin'))).thenAnswer((_) async => <FeedItem>[
          _job('cnc1', 'cnc_operator', 'CNC Operator'),
          _job('vmc1', 'vmc_setter', 'VMC Setter'),
        ]);

    final SwipeBloc bloc = SwipeBloc(repo);
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: SwipeJobsScreen(bloc: bloc),
    ));
    await tester.pumpAndSettle();

    // Both jobs are in the deck and no filter is active yet.
    expect(find.text('CNC Operator'), findsOneWidget);
    expect(bloc.state.filters.isEmpty, isTrue);

    // Search "VMC" and tap the trade suggestion — no sheet involved.
    await _applyFilterViaSearch(tester, 'VMC', 'jobFilterSuggestion_trade_VMC');

    // It reached the bloc AND narrowed the deck.
    expect(bloc.state.filters.trades, <String>{'VMC'});
    expect(find.text('VMC Setter'), findsOneWidget);
    expect(find.text('CNC Operator'), findsNothing);

    // Removing the active chip restores the full deck (round-trip).
    await _removeActiveChip(tester, 'jobFilterChip_trade_VMC');
    expect(bloc.state.filters.isEmpty, isTrue);
    expect(find.text('CNC Operator'), findsOneWidget);
  });

  testWidgets(
    'the filter icon shows a green dot when ANY filter is active and hides it '
    'when all filters are cleared',
    (WidgetTester tester) async {
      _tallSurface(tester);

      final _MockSwipeRepository repo = _MockSwipeRepository();
      when(() => repo.getFeed(tradeKey: any(named: 'tradeKey'), city: any(named: 'city'), shift: any(named: 'shift'), payMin: any(named: 'payMin'))).thenAnswer((_) async => <FeedItem>[
            _job('cnc1', 'cnc_operator', 'CNC Operator'),
            _job('vmc1', 'vmc_setter', 'VMC Setter'),
          ]);

      final SwipeBloc bloc = SwipeBloc(repo);
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: SwipeJobsScreen(bloc: bloc),
      ));
      await tester.pumpAndSettle();

      final Finder dot = find.byKey(const Key('jobs_filter_active_dot'));

      // No filter yet -> Visibility hides the child -> no dot.
      expect(bloc.state.filters.isEmpty, isTrue);
      expect(dot, findsNothing);

      // Apply a filter via the header search -> the dot appears.
      await _applyFilterViaSearch(tester, 'VMC', 'jobFilterSuggestion_trade_VMC');
      expect(dot, findsOneWidget);

      // Remove it via its chip -> the dot disappears again.
      await _removeActiveChip(tester, 'jobFilterChip_trade_VMC');
      expect(bloc.state.filters.isEmpty, isTrue);
      expect(dot, findsNothing);
    },
  );

  testWidgets(
    'the header active-filter row and the sheet share ONE filter state (a '
    'sheet selection shows a removable chip)',
    (WidgetTester tester) async {
      _tallSurface(tester);

      final _MockSwipeRepository repo = _MockSwipeRepository();
      when(() => repo.getFeed(tradeKey: any(named: 'tradeKey'), city: any(named: 'city'), shift: any(named: 'shift'), payMin: any(named: 'payMin'))).thenAnswer((_) async => <FeedItem>[
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

      // ...and the header's active-filter row shows a removable chip for it
      // (one source of truth). Removing that chip clears it.
      expect(bloc.state.filters.trades, <String>{'CNC'});
      expect(find.byKey(const Key('jobFilterChip_trade_CNC')), findsOneWidget);
      await _removeActiveChip(tester, 'jobFilterChip_trade_CNC');
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
    when(() => repo.getFeed(tradeKey: any(named: 'tradeKey'), city: any(named: 'city'), shift: any(named: 'shift'), payMin: any(named: 'payMin'))).thenAnswer(
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
    // The kit 07 header leads with the brand line, not an unbacked location
    // claim ("near you" / "15 km" the stack cannot back).
    expect(find.text('JOBS NEAR YOU'), findsNothing);
    expect(find.text('Kaam milega.'), findsOneWidget);
  });

  testWidgets('a filter matching no jobs shows the "no jobs match" empty state',
      (WidgetTester tester) async {
    _tallSurface(tester);

    final _MockSwipeRepository repo = _MockSwipeRepository();
    when(() => repo.getFeed(tradeKey: any(named: 'tradeKey'), city: any(named: 'city'), shift: any(named: 'shift'), payMin: any(named: 'payMin'))).thenAnswer(
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
      when(() => repo.getFeed(tradeKey: any(named: 'tradeKey'), city: any(named: 'city'), shift: any(named: 'shift'), payMin: any(named: 'payMin'))).thenAnswer((_) async => <FeedItem>[
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
    },
  );
}
