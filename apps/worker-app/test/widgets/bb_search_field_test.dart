import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_search_field.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbSearchField', () {
    testWidgets('renders with its hint text', (tester) async {
      await tester.pumpWidget(_host(
        const BbSearchField(hint: 'Type karke dhoondein'),
      ));

      expect(find.byType(BbSearchField), findsOneWidget);
      expect(find.text('Type karke dhoondein'), findsOneWidget);
      expect(find.byIcon(Icons.search), findsOneWidget);
    });

    testWidgets('accepts input and calls onChanged with each value',
        (tester) async {
      final List<String> seen = <String>[];
      await tester.pumpWidget(_host(
        BbSearchField(
          fieldKey: const Key('searchField'),
          onChanged: seen.add,
        ),
      ));

      await tester.enterText(find.byKey(const Key('searchField')), 'alu');
      expect(seen, <String>['alu']);
    });

    testWidgets('exposes a persistent semantic label for the field',
        (tester) async {
      await tester.pumpWidget(_host(
        const BbSearchField(label: 'Materials search karein'),
      ));

      final Semantics semantics = tester.widget<Semantics>(
        find
            .ancestor(
              of: find.byType(TextField),
              matching: find.byType(Semantics),
            )
            .first,
      );
      expect(semantics.properties.label, 'Materials search karein');
      expect(semantics.properties.textField, true);
    });

    testWidgets('an external controller drives and reflects the field value',
        (tester) async {
      final TextEditingController controller = TextEditingController();
      await tester.pumpWidget(_host(
        BbSearchField(
          fieldKey: const Key('controlledSearchField'),
          controller: controller,
        ),
      ));

      await tester.enterText(
        find.byKey(const Key('controlledSearchField')),
        'brass',
      );
      expect(controller.text, 'brass');
      controller.dispose();
    });
  });
}
