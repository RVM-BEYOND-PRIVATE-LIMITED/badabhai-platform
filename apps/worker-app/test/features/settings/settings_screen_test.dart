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

    expect(find.text('WhatsApp alerts'), findsOneWidget);
    expect(find.text('Account delete karein'), findsOneWidget);
    expect(find.textContaining('Made in India'), findsOneWidget);
  });

  // Both rows are hidden for now: 'Bhasha' until real localization ships (it
  // set X-Locale with no translated strings behind it), 'Aapke devices' by
  // request. Their screens/routes still exist — only the entry points are gone,
  // so assert the rows to catch an accidental re-add.
  testWidgets('hides the Bhasha + Aapke devices rows',
      (WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('Bhasha'), findsNothing);
    expect(find.text('Aapke devices'), findsNothing);
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
