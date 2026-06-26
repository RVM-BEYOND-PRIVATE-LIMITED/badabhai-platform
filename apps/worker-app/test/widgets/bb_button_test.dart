import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbButton', () {
    testWidgets('renders its label and fires onPressed', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbButton(label: 'Apply', onPressed: () => taps++),
      ));

      expect(find.text('Apply'), findsOneWidget);
      await tester.tap(find.text('Apply'));
      expect(taps, 1);
    });

    testWidgets('primary variant renders a FilledButton (theme-driven green)',
        (tester) async {
      await tester.pumpWidget(_host(
        BbButton(label: 'Go', onPressed: () {}),
      ));
      expect(find.widgetWithText(FilledButton, 'Go'), findsOneWidget);
    });

    testWidgets('secondary variant renders an OutlinedButton', (tester) async {
      await tester.pumpWidget(_host(
        BbButton(
          label: 'Skip',
          variant: BbButtonVariant.secondary,
          onPressed: () {},
        ),
      ));
      expect(find.widgetWithText(OutlinedButton, 'Skip'), findsOneWidget);
    });

    testWidgets('loading shows a spinner and blocks taps', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbButton(label: 'Sending', loading: true, onPressed: () => taps++),
      ));

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.text('Sending'));
      expect(taps, 0); // disabled while loading
    });

    testWidgets('passes buttonKey through for test/lookup', (tester) async {
      await tester.pumpWidget(_host(
        BbButton(
          label: 'Tap',
          buttonKey: const Key('myBtn'),
          onPressed: () {},
        ),
      ));
      expect(find.byKey(const Key('myBtn')), findsOneWidget);
    });
  });
}
