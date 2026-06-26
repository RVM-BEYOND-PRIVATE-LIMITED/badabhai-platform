import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_success_stamp.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbSuccessStamp', () {
    testWidgets('renders the check icon and stamp during its animation',
        (tester) async {
      await tester.pumpWidget(_host(const BbSuccessStamp()));
      await tester.pump(const Duration(milliseconds: 350));

      expect(find.byType(BbSuccessStamp), findsOneWidget);
      expect(find.byIcon(Icons.check), findsOneWidget);

      await tester.pumpAndSettle();
    });

    testWidgets('honours a custom icon', (tester) async {
      await tester.pumpWidget(_host(
        const BbSuccessStamp(icon: Icons.verified),
      ));
      await tester.pump(const Duration(milliseconds: 350));

      expect(find.byIcon(Icons.verified), findsOneWidget);

      await tester.pumpAndSettle();
    });
  });
}
