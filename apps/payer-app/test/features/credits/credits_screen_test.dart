import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/credits/presentation/credits_screen.dart';

/// #376 — the screen is REPORT-ONLY: the purchase surface (pack catalogue,
/// prices, "Secure checkout · Razorpay · UPI / card") was deliberately removed
/// because there is no payment provider. It was still titled 'Buy credits',
/// promising the one capability it does not have — a payer arriving from Home's
/// "View ledger" with 0 credits would hunt for a buy button that does not exist
/// and read the app as broken. These tests pin the honest title + disclosure.
void main() {
  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  Future<void> pump(WidgetTester tester) async {
    // CreditsScreen is a tab body — the shell supplies the Scaffold/Material.
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: CreditsScreen(onBack: () {}))),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('titled "Credits", never "Buy credits"', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    expect(find.text('Credits'), findsOneWidget);
    expect(find.text('Buy credits'), findsNothing);
  });

  testWidgets('states that buying is unavailable in the app', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    expect(
      find.text('Buying credits is not available in the app yet.'),
      findsOneWidget,
    );
  });

  testWidgets('still reports the server balance + ledger', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    // Retitling must not have cost the screen its actual job.
    expect(find.text('Current balance'), findsOneWidget);
    expect(find.text('Unlock ledger'), findsOneWidget);
  });
}
