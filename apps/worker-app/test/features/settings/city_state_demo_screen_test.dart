import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/features/settings/presentation/city_state_demo_screen.dart';

void main() {
  Future<void> pump(WidgetTester tester) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await tester.pumpWidget(const MaterialApp(
      home: CityStateDemoScreen(),
    ));
  }

  testWidgets(
      'both dropdowns render closed with their placeholder — no chip wall, '
      'no summary yet', (WidgetTester tester) async {
    await pump(tester);

    expect(find.text('STATE CHUNEIN'), findsOneWidget);
    expect(find.text('SHEHER CHUNEIN'), findsOneWidget);
    expect(find.textContaining('YEH DATA JAAYEGA'), findsNothing);
    // Nothing is pre-opened — every state/city lives inside its own closed
    // sheet, not inline.
    expect(find.text('Punjab'), findsNothing);
    expect(find.text('Ludhiana'), findsNothing);
  });

  testWidgets(
      'opening the state dropdown, then the city dropdown, only offers '
      'cities filtered to the picked state', (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
        find.text('Punjab'), 200,
        scrollable: find.byType(Scrollable).last);
    expect(find.text('Punjab'), findsOneWidget);

    await tester.tap(find.text('Punjab'));
    await tester.pumpAndSettle();

    // The state dropdown now shows the pick, not the placeholder.
    expect(find.text('Punjab'), findsOneWidget);
    expect(find.text('STATE CHUNEIN'), findsNothing);

    await tester.tap(find.text('SHEHER CHUNEIN'));
    await tester.pumpAndSettle();

    expect(find.text('Ludhiana'), findsOneWidget);
    // Maharashtra's cities must not leak into Punjab's sheet.
    expect(find.text('Mumbai'), findsNothing);
  });

  testWidgets('picking a city shows the "Sahar/State" summary the real '
      'work-history field would carry', (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Maharashtra'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('SHEHER CHUNEIN'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pune'));
    await tester.pumpAndSettle();

    expect(find.text('Sheher: Pune  ·  State: Maharashtra'), findsOneWidget);
  });

  testWidgets('switching state clears a stale city pick',
      (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Maharashtra'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('SHEHER CHUNEIN'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pune'));
    await tester.pumpAndSettle();

    expect(find.textContaining('YEH DATA JAAYEGA'), findsOneWidget);

    await tester.tap(find.text('Maharashtra'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gujarat'));
    await tester.pumpAndSettle();

    expect(find.textContaining('YEH DATA JAAYEGA'), findsNothing);
    expect(find.text('Pune'), findsNothing);
    // The city dropdown fell back to its placeholder, not a stale value.
    expect(find.text('SHEHER CHUNEIN'), findsOneWidget);
  });

  testWidgets('the state dropdown search box filters to a typed query',
      (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();

    expect(find.text('Gujarat'), findsOneWidget);
    await tester.scrollUntilVisible(
        find.text('Punjab'), 200,
        scrollable: find.byType(Scrollable).last);
    expect(find.text('Punjab'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Punj');
    await tester.pump();

    expect(find.text('Punjab'), findsOneWidget);
    expect(find.text('Gujarat'), findsNothing);
  });
}
