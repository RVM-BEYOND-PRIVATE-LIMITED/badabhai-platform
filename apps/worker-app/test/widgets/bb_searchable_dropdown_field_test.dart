import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/bb_searchable_dropdown_field.dart';

void main() {
  Future<void> pump(
    WidgetTester tester, {
    String? selected,
    bool enabled = true,
    ValueChanged<String>? onSelected,
  }) async {
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: BbSearchableDropdownField(
          placeholder: 'STATE CHUNEIN',
          options: const <String>['Haryana', 'Maharashtra', 'Punjab'],
          selected: selected,
          enabled: enabled,
          onSelected: onSelected ?? (_) {},
        ),
      ),
    ));
  }

  testWidgets('shows the placeholder, not any option, until something is picked',
      (WidgetTester tester) async {
    await pump(tester);

    expect(find.text('STATE CHUNEIN'), findsOneWidget);
    expect(find.text('Haryana'), findsNothing);
  });

  testWidgets('a selected value replaces the placeholder', (WidgetTester tester) async {
    await pump(tester, selected: 'Punjab');

    expect(find.text('Punjab'), findsOneWidget);
    expect(find.text('STATE CHUNEIN'), findsNothing);
  });

  testWidgets('tapping the closed field opens a sheet listing every option',
      (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();

    expect(find.text('Haryana'), findsOneWidget);
    expect(find.text('Maharashtra'), findsOneWidget);
    expect(find.text('Punjab'), findsOneWidget);
  });

  testWidgets('the sheet search box filters the option list live',
      (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();

    // "Hary" (not "Har") — "Maharashtra" contains "har" as a substring, so a
    // looser query would false-match it too.
    await tester.enterText(find.byType(TextField), 'Hary');
    await tester.pump();

    expect(find.text('Haryana'), findsOneWidget);
    expect(find.text('Maharashtra'), findsNothing);
    expect(find.text('Punjab'), findsNothing);
  });

  testWidgets('a typed query matching nothing shows the empty hint, not a crash',
      (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'zzzz');
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('Koi option nahi mila. Doosra shabd try karein.'), findsOneWidget);
  });

  testWidgets('tapping an option closes the sheet and reports the pick',
      (WidgetTester tester) async {
    String? picked;
    await pump(tester, onSelected: (String v) => picked = v);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Maharashtra'));
    await tester.pumpAndSettle();

    expect(picked, 'Maharashtra');
    // The sheet is gone — its option list no longer in the tree.
    expect(find.text('Haryana'), findsNothing);
  });

  testWidgets('disabled renders muted and does not open on tap',
      (WidgetTester tester) async {
    await pump(tester, enabled: false);

    await tester.tap(find.text('STATE CHUNEIN'));
    await tester.pumpAndSettle();

    // No sheet opened — none of the options became visible.
    expect(find.text('Haryana'), findsNothing);
    expect(find.text('Maharashtra'), findsNothing);
  });
}
