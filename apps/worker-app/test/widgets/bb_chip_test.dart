import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbChip', () {
    testWidgets('renders its label and fires onTap', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbChip(label: 'CNC', selected: false, onTap: () => taps++),
      ));

      expect(find.text('CNC'), findsOneWidget);
      await tester.tap(find.text('CNC'));
      expect(taps, 1);
    });

    testWidgets('selected chip builds and shows its label', (tester) async {
      await tester.pumpWidget(_host(
        const BbChip(label: 'VMC', selected: true),
      ));

      expect(find.byType(BbChip), findsOneWidget);
      expect(find.text('VMC'), findsOneWidget);
    });

    testWidgets('renders a leading icon when provided', (tester) async {
      await tester.pumpWidget(_host(
        const BbChip(label: 'Welding', icon: Icons.build_outlined),
      ));

      expect(find.byIcon(Icons.build_outlined), findsOneWidget);
    });
  });
}
