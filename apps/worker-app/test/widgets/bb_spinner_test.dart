import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_spinner.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbSpinner', () {
    testWidgets('renders a CustomPaint and its caption', (tester) async {
      await tester.pumpWidget(_host(const BbSpinner(caption: 'Wait')));
      // Infinite rotation — pump a couple of frames, never pumpAndSettle.
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.byType(CustomPaint), findsWidgets);
      expect(find.text('Wait'), findsOneWidget);
    });

    testWidgets('renders without a caption', (tester) async {
      await tester.pumpWidget(_host(const BbSpinner()));
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.byType(BbSpinner), findsOneWidget);
      // Scope to the BbSpinner subtree: the framework adds its own
      // RotationTransition elsewhere in the tree, so a bare byType is brittle.
      expect(
        find.descendant(
          of: find.byType(BbSpinner),
          matching: find.byType(RotationTransition),
        ),
        findsOneWidget,
      );
    });
  });
}
