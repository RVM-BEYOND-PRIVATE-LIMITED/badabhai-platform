import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_progress_bar.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbProgressBar', () {
    testWidgets('renders and animates its fill to value', (tester) async {
      await tester.pumpWidget(_host(const BbProgressBar(value: 0.72)));
      // let the TweenAnimationBuilder settle partway through AppMotion.slow
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.byType(BbProgressBar), findsOneWidget);
      expect(find.byType(FractionallySizedBox), findsOneWidget);
    });

    testWidgets('clamps out-of-range values without throwing', (tester) async {
      await tester.pumpWidget(_host(const BbProgressBar(value: 1.5)));
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.byType(BbProgressBar), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
