import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/settings/presentation/settings_screen.dart';

void main() {
  testWidgets('renders the rows + legal footer', (WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('Bhasha'), findsOneWidget);
    expect(find.text('WhatsApp alerts'), findsOneWidget);
    expect(find.text('Account delete karein'), findsOneWidget);
    expect(find.textContaining('Made in India'), findsOneWidget);
  });

  testWidgets('account-delete opens the 7-day grace confirmation', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    await tester.tap(find.text('Account delete karein'));
    await tester.pumpAndSettle();

    expect(find.text('Account delete karein?'), findsOneWidget);
    expect(find.textContaining('cancel kar sakte hain'), findsOneWidget);
  });
}
