import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_status_view.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbStatusView', () {
    testWidgets('renders icon, title, subtitle and action', (tester) async {
      await tester.pumpWidget(_host(
        const BbStatusView(
          icon: Icons.cloud_off_rounded,
          title: 'Oops',
          subtitle: 'try',
          action: Text('A'),
        ),
      ));

      expect(find.byIcon(Icons.cloud_off_rounded), findsOneWidget);
      expect(find.text('Oops'), findsOneWidget);
      expect(find.text('try'), findsOneWidget);
      expect(find.text('A'), findsOneWidget);
    });

    testWidgets('loading mode shows a spinner and its caption', (tester) async {
      await tester.pumpWidget(_host(
        const BbStatusView.loading(caption: 'Loading'),
      ));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Loading'), findsOneWidget);
    });
  });
}
