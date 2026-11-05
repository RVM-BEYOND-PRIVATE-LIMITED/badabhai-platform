import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/core/widgets/bb_toast.dart';

/// #2690 (rule 2) — one toast system: one at a time, per-tone durations, one
/// action, polite live region, swipe-to-dismiss and bottom-inset awareness.
void main() {
  final ThemeData theme = AppTheme.light();

  Widget host(
    void Function(BuildContext) onShow, {
    double bottomInset = 0,
  }) =>
      MaterialApp(
        theme: theme,
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            padding: EdgeInsets.only(bottom: bottomInset),
          ),
          child: app!,
        ),
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => Center(
              child: ElevatedButton(
                onPressed: () => onShow(context),
                child: const Text('show'),
              ),
            ),
          ),
        ),
      );

  Future<void> drain(WidgetTester tester) async {
    await tester.pump(const Duration(seconds: 9));
    await tester.pumpAndSettle();
  }

  test('durations follow the tone — success/info 4s, error 6s, action 8s', () {
    expect(BbToast.durationFor(BbToastTone.success),
        const Duration(seconds: 4));
    expect(BbToast.durationFor(BbToastTone.info), const Duration(seconds: 4));
    expect(BbToast.durationFor(BbToastTone.error), const Duration(seconds: 6));
    expect(BbToast.durationFor(BbToastTone.action),
        const Duration(seconds: 8));
    expect(BbToast.maxQueued, 3);
  });

  testWidgets('announces politely through a live region', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(host((BuildContext context) {
      showBbToast(context, title: 'Job published', message: 'Live now.');
    }));
    await tester.tap(find.text('show'));
    await tester.pump();

    expect(find.text('Job published'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (Widget w) => w is Semantics && (w.properties.liveRegion ?? false),
      ),
      findsWidgets,
    );
    await drain(tester);
  });

  testWidgets('one visible at a time — the next waits its turn', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(host((BuildContext context) {
      showBbToast(context, title: 'First', message: 'one');
      showBbToast(context, title: 'Second', message: 'two');
    }));
    await tester.tap(find.text('show'));
    await tester.pump();

    expect(find.text('First'), findsOneWidget);
    expect(find.text('Second'), findsNothing);

    await tester.pump(const Duration(seconds: 5));
    expect(find.text('First'), findsNothing);
    expect(find.text('Second'), findsOneWidget);
    await drain(tester);
  });

  testWidgets('a single action fires once and takes the toast down', (
    WidgetTester tester,
  ) async {
    int undos = 0;
    await tester.pumpWidget(host((BuildContext context) {
      showBbToast(
        context,
        title: 'Job paused',
        message: 'Hidden from workers.',
        tone: BbToastTone.action,
        action: BbToastAction(
          label: 'Undo',
          onPressed: () => undos++,
        ),
      );
    }));
    await tester.tap(find.text('show'));
    await tester.pumpAndSettle();

    expect(find.text('Undo'), findsOneWidget);
    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(undos, 1);
    expect(find.text('Job paused'), findsNothing);
  });

  testWidgets('swipe dismisses it', (WidgetTester tester) async {
    await tester.pumpWidget(host((BuildContext context) {
      showBbToast(context, title: 'Saved', message: 'All good.');
    }));
    await tester.tap(find.text('show'));
    await tester.pumpAndSettle();

    await tester.drag(find.byType(SnackBar), const Offset(-500, 0));
    await tester.pumpAndSettle();
    expect(find.text('Saved'), findsNothing);
  });

  testWidgets('sits above the safe-area bottom inset', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(host(
      (BuildContext context) {
        showBbToast(context, title: 'Saved', message: 'All good.');
      },
      bottomInset: 34,
    ));
    await tester.tap(find.text('show'));
    await tester.pump();

    final SnackBar bar = tester.widget<SnackBar>(find.byType(SnackBar));
    expect((bar.margin! as EdgeInsets).bottom, greaterThanOrEqualTo(34));
    expect(bar.dismissDirection, DismissDirection.horizontal);
    await drain(tester);
  });
}
