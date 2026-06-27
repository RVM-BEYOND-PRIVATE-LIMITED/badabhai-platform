import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_verified_badge.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbVerifiedBadge', () {
    testWidgets('renders its default label and the verified icon',
        (tester) async {
      await tester.pumpWidget(_host(const BbVerifiedBadge()));

      expect(find.text('Verified'), findsOneWidget);
      expect(find.byIcon(Icons.verified), findsOneWidget);
    });

    testWidgets('renders a custom label', (tester) async {
      await tester.pumpWidget(_host(const BbVerifiedBadge(label: 'KYC done')));

      expect(find.text('KYC done'), findsOneWidget);
    });
  });

  group('BbSeal', () {
    testWidgets('renders the verified seal glyph', (tester) async {
      await tester.pumpWidget(_host(const BbSeal()));

      expect(find.byIcon(Icons.verified), findsOneWidget);
    });
  });
}
