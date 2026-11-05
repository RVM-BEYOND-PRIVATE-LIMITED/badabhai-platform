import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/error/payer_failure.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/features/jobs/presentation/widgets/trade_posting_fields.dart';

/// #2635 — the one stand-in for the trade picker that the post form, Edit job
/// and the AI chat's draft panel share until there are 16 trades to pick from:
/// the picker's label, then why there is nothing to pick (still loading, a
/// failed read with its real cause, or an empty catalogue) with a Retry, then
/// the role's inline error.
void main() {
  late int retries;

  Future<void> pump(
    WidgetTester tester, {
    required bool loading,
    PayerFailure? failure,
    String? errorText,
  }) async {
    retries = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PostingTradePickerPlaceholder(
            loading: loading,
            failure: failure,
            onRetry: () => retries++,
            errorText: errorText,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder retry() => find.widgetWithText(BbButton, 'Retry');

  testWidgets('while the trades load: the label and a loading line, no Retry',
      (WidgetTester tester) async {
    await pump(tester, loading: true);

    expect(find.text('Role'), findsOneWidget);
    expect(find.text('Loading roles…'), findsOneWidget);
    expect(retry(), findsNothing);
  });

  testWidgets('a failed read names the real cause and offers Retry',
      (WidgetTester tester) async {
    await pump(
      tester,
      loading: false,
      failure: const PayerFailure(PayerFailureKind.network),
    );

    expect(find.text('Role'), findsOneWidget);
    expect(
      find.text(
        'The 16 trades did not load. Check your internet connection and try '
        'again.',
      ),
      findsOneWidget,
    );
    expect(find.text('Loading roles…'), findsNothing);

    await tester.tap(retry());
    expect(retries, 1);
  });

  testWidgets('an empty catalogue says no trade is open, and offers Retry',
      (WidgetTester tester) async {
    await pump(tester, loading: false);

    expect(
      find.text(
        'No trades are open for posting right now. Try again in a moment.',
      ),
      findsOneWidget,
    );

    await tester.tap(retry());
    expect(retries, 1);
  });

  testWidgets("the role's inline error shows under it; none without one",
      (WidgetTester tester) async {
    await pump(tester, loading: false);
    expect(find.text('Pick one of the 16 trades'), findsNothing);

    await pump(tester, loading: false, errorText: 'Pick one of the 16 trades');
    expect(find.text('Pick one of the 16 trades'), findsOneWidget);
  });
}
