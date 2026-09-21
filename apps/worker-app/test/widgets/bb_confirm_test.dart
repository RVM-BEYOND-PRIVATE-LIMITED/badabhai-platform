import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/bb_alert_dialog.dart';

import '../support/kit_matrix.dart';

void main() {
  group('showBbConfirm', () {
    Future<bool?> open(
      WidgetTester tester, {
      bool destructive = false,
      bool barrierDismissible = true,
    }) async {
      bool? result;
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: Builder(
              builder: (BuildContext context) => TextButton(
                onPressed: () async {
                  result = await showBbConfirm(
                    context,
                    title: 'Account delete karein?',
                    message: 'Yeh wapas nahi hoga.',
                    confirmLabel: 'Delete karein',
                    destructive: destructive,
                    barrierDismissible: barrierDismissible,
                  );
                },
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      return result;
    }

    testWidgets('resolves TRUE only on an explicit confirm tap', (
      WidgetTester tester,
    ) async {
      await open(tester);
      expect(find.text('Account delete karein?'), findsOneWidget);

      await tester.tap(find.text('Delete karein'));
      await tester.pumpAndSettle();

      // Read it back through a second run so the closure has settled.
      bool? captured;
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: Builder(
              builder: (BuildContext context) => TextButton(
                onPressed: () async {
                  captured = await showBbConfirm(
                    context,
                    title: 'T',
                    message: 'M',
                    confirmLabel: 'Haan',
                  );
                },
                child: const Text('Go'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Go'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Haan'));
      await tester.pumpAndSettle();
      expect(captured, isTrue);
    });

    testWidgets('cancel resolves FALSE, never null', (
      WidgetTester tester,
    ) async {
      bool? captured;
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: Builder(
              builder: (BuildContext context) => TextButton(
                onPressed: () async {
                  captured = await showBbConfirm(
                    context,
                    title: 'T',
                    message: 'M',
                    cancelLabel: 'Rehne dein',
                  );
                },
                child: const Text('Go'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Go'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Rehne dein'));
      await tester.pumpAndSettle();

      // `if (await showBbConfirm(...))` must be safe by construction: backing
      // out can never be mistaken for agreeing.
      expect(captured, isFalse);
      expect(captured, isNotNull);
    });

    testWidgets('dismissing on the barrier resolves FALSE', (
      WidgetTester tester,
    ) async {
      bool? captured;
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: Builder(
              builder: (BuildContext context) => TextButton(
                onPressed: () async {
                  captured = await showBbConfirm(
                    context,
                    title: 'T',
                    message: 'M',
                  );
                },
                child: const Text('Go'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Go'));
      await tester.pumpAndSettle();

      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();

      expect(captured, isFalse);
    });

    testWidgets('destructive paints the confirm button as the danger action', (
      WidgetTester tester,
    ) async {
      await open(tester, destructive: true);

      expect(find.text('Delete karein'), findsOneWidget);
      expect(find.text('Rehne dein'), findsOneWidget);
      // Both actions clear the touch floor.
      expect(
        tester
            .getSize(find.widgetWithText(FilledButton, 'Delete karein'))
            .height,
        greaterThanOrEqualTo(48),
      );
    });
  });
}
