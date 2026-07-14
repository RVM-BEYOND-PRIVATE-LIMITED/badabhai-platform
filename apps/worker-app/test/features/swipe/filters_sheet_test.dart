import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_sheet.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/filters_sheet.dart';

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
    'opens with NO trade pre-selected (liberal), shows the REAL count, and pops the edited selection',
    (WidgetTester tester) async {
      // A phone-tall surface so the sheet's "Show N jobs" CTA is on-screen.
      tester.view.physicalSize = const Size(400, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      // A loaded queue: 2 CNC jobs + 1 VMC job. The sheet counts over THIS list.
      final List<FeedItem> jobs = <FeedItem>[
        _job('c1', 'cnc_operator', 'CNC Operator'),
        _job('c2', 'cnc_operator', 'CNC Machinist'),
        _job('v1', 'vmc_setter', 'VMC Setter'),
      ];

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
                    builder: (_) =>
                        FiltersSheet(initial: FilterSelection.initial, jobs: jobs),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.text('Filter jobs'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget); // a trade chip
      expect(find.text('Day'), findsOneWidget); // a shift chip

      // The feed is LIBERAL (no location filter) — the sheet must NOT offer a
      // Distance group or any distance chip that would falsely imply filtering.
      expect(find.text('Distance'), findsNothing);
      expect(find.text('15 km'), findsNothing);
      expect(find.text('30 km'), findsNothing);

      // Default = no trade selected → "show all": the REAL count is the whole
      // loaded queue (3), NOT a mock figure, and no trade chip is pre-selected.
      expect(find.text('Show 3 jobs'), findsOneWidget);

      // Narrow to CNC: the count reacts to the real trade-filtered subset (2).
      await tester.tap(find.text('CNC'));
      await tester.pumpAndSettle();
      expect(find.text('Show 2 jobs'), findsOneWidget);

      await tester.tap(find.text('Show 2 jobs'));
      await tester.pumpAndSettle();

      expect(result, isNotNull);
      expect(result!.trades, <String>{'CNC'}); // only what the worker picked
      expect(result!.shift, 'Day'); // shift still round-trips
    },
  );
}
