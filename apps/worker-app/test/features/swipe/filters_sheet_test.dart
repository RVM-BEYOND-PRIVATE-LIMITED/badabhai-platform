import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_sheet.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_filter.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/filters_sheet.dart';

FeedItem _job(
  String id,
  String tradeKey,
  String title, {
  String city = 'Pune',
  int? minYears,
  int? maxYears,
}) =>
    FeedItem(
      jobId: id,
      tradeKey: tradeKey,
      title: title,
      city: city,
      area: null,
      minExperienceYears: minYears,
      maxExperienceYears: maxYears,
      rank: 1,
    );

/// A phone-tall surface so the sheet's "Show N jobs" CTA is on-screen.
void _tallSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(400, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// Pumps a launcher button that opens the sheet, and returns a getter for the
/// selection the sheet pops with.
Future<FilterSelection? Function()> _mountSheet(
  WidgetTester tester,
  List<FeedItem> jobs, {
  FilterSelection initial = FilterSelection.initial,
}) async {
  FilterSelection? result;
  await tester.pumpWidget(MaterialApp(
    theme: AppTheme.light(),
    home: Scaffold(
      body: Builder(
        builder: (BuildContext ctx) => Center(
          child: ElevatedButton(
            onPressed: () async {
              result = await showBbBottomSheet<FilterSelection>(
                context: ctx,
                builder: (_) => FiltersSheet(initial: initial, jobs: jobs),
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  ));
  return () => result;
}

void main() {
  testWidgets(
    'opens with NOTHING pre-selected (liberal), shows the REAL count, and pops '
    'the edited selection',
    (WidgetTester tester) async {
      _tallSurface(tester);

      // A loaded queue: 2 CNC jobs + 1 VMC job. The sheet counts over THIS list.
      final List<FeedItem> jobs = <FeedItem>[
        _job('c1', 'cnc_operator', 'CNC Operator'),
        _job('c2', 'cnc_operator', 'CNC Machinist'),
        _job('v1', 'vmc_setter', 'VMC Setter'),
      ];
      final FilterSelection? Function() result = await _mountSheet(tester, jobs);

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Filter jobs'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget); // a trade chip

      // Default = nothing selected → "show all": the REAL count is the whole
      // loaded queue (3), NOT a mock figure, and no chip is pre-selected.
      expect(find.text('Show 3 jobs'), findsOneWidget);

      // Narrow to CNC: the count reacts to the real trade-filtered subset (2).
      await tester.tap(find.text('CNC'));
      await tester.pumpAndSettle();
      expect(find.text('Show 2 jobs'), findsOneWidget);

      await tester.tap(find.text('Show 2 jobs'));
      await tester.pumpAndSettle();

      final FilterSelection? popped = result();
      expect(popped, isNotNull);
      expect(popped!.trades, <String>{'CNC'}); // only what the worker picked
      expect(popped.cities, isEmpty);
      expect(popped.experienceBands, isEmpty);
    },
  );

  testWidgets(
    'offers NO Shift group — shift is not on the /feed wire (mock-only display '
    'data per ADR-0024), so filtering on it was dead',
    (WidgetTester tester) async {
      _tallSurface(tester);
      await _mountSheet(
          tester, <FeedItem>[_job('c1', 'cnc_operator', 'CNC Operator')]);
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('SHIFT'), findsNothing);
      expect(find.text('Night'), findsNothing);
      expect(find.text('Rotational'), findsNothing);
      // 'Day' must not survive as a shift chip either.
      expect(find.text('Day'), findsNothing);

      // The feed is LIBERAL (no location filter) — the sheet must NOT offer a
      // Distance group or any distance chip that would falsely imply filtering.
      expect(find.text('Distance'), findsNothing);
      expect(find.text('15 km'), findsNothing);
      expect(find.text('30 km'), findsNothing);
    },
  );

  testWidgets(
    'City options are DERIVED from the loaded queue (never hardcoded) and narrow '
    'the count',
    (WidgetTester tester) async {
      _tallSurface(tester);
      final List<FeedItem> jobs = <FeedItem>[
        _job('p1', 'cnc_operator', 'CNC Operator', city: 'Pune'),
        _job('p2', 'cnc_operator', 'CNC Machinist', city: 'Pune'),
        _job('n1', 'vmc_setter', 'VMC Setter', city: 'Nashik'),
      ];
      final FilterSelection? Function() result = await _mountSheet(tester, jobs);
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('CITY'), findsOneWidget);
      // Exactly the queue's distinct cities — sorted, de-duplicated.
      expect(find.text('Nashik'), findsOneWidget);
      expect(find.text('Pune'), findsOneWidget);
      // A city the queue does not contain is never offered.
      expect(find.text('Mumbai'), findsNothing);
      expect(find.text('Delhi'), findsNothing);

      await tester.tap(find.text('Pune'));
      await tester.pumpAndSettle();
      expect(find.text('Show 2 jobs'), findsOneWidget);

      await tester.tap(find.text('Show 2 jobs'));
      await tester.pumpAndSettle();
      expect(result()!.cities, <String>{'Pune'});
    },
  );

  testWidgets('the City group is omitted entirely when the queue has no jobs',
      (WidgetTester tester) async {
    _tallSurface(tester);
    // No queue ⇒ no derivable cities ⇒ no empty section that reads as broken.
    await _mountSheet(tester, <FeedItem>[]);
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('CITY'), findsNothing);
    expect(find.text('TRADE'), findsOneWidget); // the fixed groups still render
    expect(find.text('EXPERIENCE'), findsOneWidget);
    expect(find.text('Show 0 jobs'), findsOneWidget);
  });

  testWidgets(
    'Experience bands filter by window overlap; a job with NO experience data '
    'matches every band',
    (WidgetTester tester) async {
      _tallSurface(tester);
      final List<FeedItem> jobs = <FeedItem>[
        _job('jr', 'cnc_operator', 'CNC Junior', minYears: 0, maxYears: 1),
        _job('sr', 'cnc_operator', 'CNC Senior', minYears: 8, maxYears: 12),
        // No window ⇒ [0, infinity) ⇒ matches EVERY band, never dropped.
        _job('any', 'cnc_operator', 'CNC Any'),
      ];
      final FilterSelection? Function() result = await _mountSheet(tester, jobs);
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('EXPERIENCE'), findsOneWidget);
      for (final String label in kExperienceBandLabels) {
        expect(find.text(label), findsOneWidget);
      }

      // '5+ yrs' keeps the senior job AND the no-data job (2), drops the junior.
      await tester.tap(find.text('5+ yrs'));
      await tester.pumpAndSettle();
      expect(find.text('Show 2 jobs'), findsOneWidget);

      await tester.tap(find.text('Show 2 jobs'));
      await tester.pumpAndSettle();
      expect(result()!.experienceBands, <String>{'5+ yrs'});
    },
  );

  testWidgets(
    'the "Show N jobs" count is honest across ALL THREE dimensions ANDed '
    'together',
    (WidgetTester tester) async {
      _tallSurface(tester);
      final List<FeedItem> jobs = <FeedItem>[
        // The only job matching CNC + Pune + 5+ yrs.
        _job('hit', 'cnc_operator', 'CNC Senior',
            city: 'Pune', minYears: 6, maxYears: 9),
        _job('jr', 'cnc_operator', 'CNC Junior',
            city: 'Pune', minYears: 0, maxYears: 1), // wrong experience
        _job('away', 'cnc_operator', 'CNC Nashik',
            city: 'Nashik', minYears: 6, maxYears: 9), // wrong city
        _job('weld', 'welder', 'Welder',
            city: 'Pune', minYears: 6, maxYears: 9), // wrong trade
      ];
      final FilterSelection? Function() result = await _mountSheet(tester, jobs);
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Show 4 jobs'), findsOneWidget);
      await tester.tap(find.text('CNC'));
      await tester.pumpAndSettle();
      expect(find.text('Show 3 jobs'), findsOneWidget); // trade only

      await tester.tap(find.text('Pune'));
      await tester.pumpAndSettle();
      expect(find.text('Show 2 jobs'), findsOneWidget); // trade AND city

      await tester.tap(find.text('5+ yrs'));
      await tester.pumpAndSettle();
      // The count reflects every dimension — it never over-promises.
      expect(find.text('Show 1 jobs'), findsOneWidget);

      await tester.tap(find.text('Show 1 jobs'));
      await tester.pumpAndSettle();
      final FilterSelection popped = result()!;
      expect(popped.trades, <String>{'CNC'});
      expect(popped.cities, <String>{'Pune'});
      expect(popped.experienceBands, <String>{'5+ yrs'});
    },
  );

  testWidgets('re-opening seeds the sheet with the CURRENT selection',
      (WidgetTester tester) async {
    _tallSurface(tester);
    final List<FeedItem> jobs = <FeedItem>[
      _job('c1', 'cnc_operator', 'CNC Operator', city: 'Pune'),
      _job('v1', 'vmc_setter', 'VMC Setter', city: 'Nashik'),
    ];
    await _mountSheet(
      tester,
      jobs,
      initial: const FilterSelection(
        trades: <String>{'CNC'},
        cities: <String>{'Pune'},
        experienceBands: <String>{},
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // Seeded selection is reflected in the count immediately (1 of 2 jobs).
    expect(find.text('Show 1 jobs'), findsOneWidget);
  });
}
