import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbBottomNav', () {
    testWidgets('renders the four kit destination labels in order',
        (tester) async {
      await tester.pumpWidget(_host(
        BbBottomNav(currentIndex: 0, onTap: (_) {}),
      ));

      expect(find.text('Jobs'), findsOneWidget);
      expect(find.text('Resume'), findsOneWidget);
      expect(find.text('Bada Bhai'), findsOneWidget);
      expect(find.text('Profile'), findsOneWidget);
      // Alerts is no longer a tab — it moved to a header bell (BbAlertsAction).
      expect(find.text('Alerts'), findsNothing);
    });

    testWidgets('tapping Bada Bhai fires onTap with index 2', (tester) async {
      int? tapped;
      await tester.pumpWidget(_host(
        BbBottomNav(currentIndex: 0, onTap: (index) => tapped = index),
      ));

      await tester.tap(find.text('Bada Bhai'));
      expect(tapped, 2);
    });

    testWidgets('tapping Profile fires onTap with index 3', (tester) async {
      int? tapped;
      await tester.pumpWidget(_host(
        BbBottomNav(currentIndex: 0, onTap: (index) => tapped = index),
      ));

      await tester.tap(find.text('Profile'));
      expect(tapped, 3);
    });
  });
}
