import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_sheet.dart';
import 'package:badabhai_worker_app/features/swipe/presentation/widgets/filters_sheet.dart';

void main() {
  testWidgets('renders the groups and pops with the edited selection', (
    WidgetTester tester,
  ) async {
    // A phone-tall surface so the sheet's "Show N jobs" CTA is on-screen.
    tester.view.physicalSize = const Size(400, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

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
                      const FiltersSheet(initial: FilterSelection.initial),
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

    // Add Welder to the (CNC + VMC) defaults.
    await tester.tap(find.text('Welder'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Show '), findsOneWidget);
    await tester.tap(find.textContaining('Show '));
    await tester.pumpAndSettle();

    expect(result, isNotNull);
    expect(result!.trades.contains('Welder'), isTrue);
    expect(result!.trades.contains('CNC'), isTrue); // defaults kept
    expect(result!.distance, '15 km');
  });
}
