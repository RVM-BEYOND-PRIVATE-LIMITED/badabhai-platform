import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_sheet.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbBottomSheet', () {
    testWidgets('opens via showBbBottomSheet and renders its builder content',
        (tester) async {
      await tester.pumpWidget(_host(
        Builder(
          builder: (BuildContext ctx) => ElevatedButton(
            onPressed: () => showBbBottomSheet<void>(
              context: ctx,
              builder: (_) => const Text('Sheet!'),
            ),
            child: const Text('Open'),
          ),
        ),
      ));

      expect(find.text('Sheet!'), findsNothing);

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      expect(find.text('Sheet!'), findsOneWidget);
      expect(find.byType(BbSheetGrip), findsOneWidget);
    });

    testWidgets('BbSheetGrip renders a sized pill', (tester) async {
      await tester.pumpWidget(_host(const BbSheetGrip()));
      expect(find.byType(BbSheetGrip), findsOneWidget);
    });
  });
}
