import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_tag.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbTag', () {
    testWidgets('renders its label', (tester) async {
      await tester.pumpWidget(_host(const BbTag('Fanuc')));
      expect(find.text('Fanuc'), findsOneWidget);
    });

    testWidgets('is a non-interactive container (no button)', (tester) async {
      await tester.pumpWidget(_host(const BbTag('Siemens')));
      expect(find.byType(BbTag), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(InkWell), findsNothing);
    });
  });
}
