import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_toggle.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbToggle', () {
    testWidgets('tapping an off toggle fires onChanged(true)', (tester) async {
      bool? next;
      await tester.pumpWidget(_host(
        BbToggle(value: false, onChanged: (v) => next = v),
      ));

      await tester.tap(find.byType(BbToggle));
      expect(next, true);
    });

    testWidgets('an on toggle builds', (tester) async {
      await tester.pumpWidget(_host(
        BbToggle(value: true, onChanged: (_) {}),
      ));

      expect(find.byType(BbToggle), findsOneWidget);
    });
  });
}
