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

  testWidgets('cities only appear after a state is picked, filtered to it',
      (WidgetTester tester) async {
    await pump(tester);

    // No state chosen yet — no city section, no summary.
    expect(find.textContaining('SHEHER CHUNEIN'), findsNothing);
    expect(find.textContaining('YEH DATA JAAYEGA'), findsNothing);
    // A city belonging to a DIFFERENT state must not already be visible.
    expect(find.text('Ludhiana'), findsNothing);

    await tester.ensureVisible(find.text('Punjab'));
    await tester.tap(find.text('Punjab'));
    await tester.pump();

    expect(find.textContaining('SHEHER CHUNEIN (Punjab)'), findsOneWidget);
    expect(find.text('Ludhiana'), findsOneWidget);
    // Maharashtra's cities must not leak into Punjab's list.
    expect(find.text('Mumbai'), findsNothing);
  });

  testWidgets('picking a city shows the "Sahar/State" summary the real '
      'work-history field would carry', (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('Maharashtra'));
    await tester.pump();
    await tester.ensureVisible(find.text('Pune'));
    await tester.tap(find.text('Pune'));
    await tester.pump();

    expect(find.text('Sheher: Pune  ·  State: Maharashtra'), findsOneWidget);
  });

  testWidgets('switching state clears a stale city pick', (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('Maharashtra'));
    await tester.pump();
    await tester.ensureVisible(find.text('Pune'));
    await tester.tap(find.text('Pune'));
    await tester.pump();
    expect(find.textContaining('YEH DATA JAAYEGA'), findsOneWidget);

    await tester.ensureVisible(find.text('Gujarat'));
    await tester.tap(find.text('Gujarat'));
    await tester.pump();

    expect(find.textContaining('YEH DATA JAAYEGA'), findsNothing);
    expect(find.text('Pune'), findsNothing);
    expect(find.text('Ahmedabad'), findsOneWidget);
  });
}
