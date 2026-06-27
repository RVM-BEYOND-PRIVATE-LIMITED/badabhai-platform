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
    testWidgets('renders the four destination labels in order', (tester) async {
      await tester.pumpWidget(_host(
        BbBottomNav(currentIndex: 0, onTap: (_) {}, alertsUnread: 2),
      ));

      expect(find.text('Jobs'), findsOneWidget);
      expect(find.text('Resume'), findsOneWidget);
      expect(find.text('Profile'), findsOneWidget);
      expect(find.text('Alerts'), findsOneWidget);
    });

    testWidgets('shows the unread-alerts badge count', (tester) async {
      await tester.pumpWidget(_host(
        BbBottomNav(currentIndex: 0, onTap: (_) {}, alertsUnread: 2),
      ));

      expect(find.text('2'), findsOneWidget);
    });

    testWidgets('hides the badge when alertsUnread is zero', (tester) async {
      await tester.pumpWidget(_host(
        BbBottomNav(currentIndex: 0, onTap: (_) {}),
      ));

      expect(find.text('0'), findsNothing);
    });

    testWidgets('tapping Alerts fires onTap with index 3', (tester) async {
      int? tapped;
      await tester.pumpWidget(_host(
        BbBottomNav(
          currentIndex: 0,
          onTap: (index) => tapped = index,
          alertsUnread: 2,
        ),
      ));

      await tester.tap(find.text('Alerts'));
      expect(tapped, 3);
    });
  });
}
