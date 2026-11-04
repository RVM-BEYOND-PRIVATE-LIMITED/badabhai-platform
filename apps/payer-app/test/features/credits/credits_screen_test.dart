import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/features/credits/presentation/credits_screen.dart';

/// #1200 — the Credits screen is READ-ONLY. The in-app "Buy credits" pack
/// catalogue + Buy buttons were removed: selling a digital entitlement from
/// inside a store-distributed app is exactly what App Store / Play Store IAP
/// policy covers, and the mobile-payments rule bars it outright. #2589 (owner
/// ruling 4 Nov 2026) then removed the hidden "Buy credits on web" pointer too:
/// no payment information of any kind. What remains is the server balance +
/// ledger, in credits only. These tests pin that no purchase surface or ₹ amount
/// leaks back in, and that the screen still reports what it must.
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

  testWidgets(
      'reports the read-only balance + ledger with NO purchase surface and NO '
      'web purchase pointer', (WidgetTester tester) async {
    await pump(tester);

    // Still does its actual job: the server balance + the credit ledger.
    expect(find.text('Credits'), findsOneWidget); // title
    expect(find.text('Current balance'), findsOneWidget);
    // The credit-account ledger (`/payer/credits/ledger`) — the old 'Unlock
    // ledger' heading mislabelled it; the real per-unlock history is separate.
    expect(find.text('Credit ledger'), findsOneWidget);

    // #2589 — the "Buy credits on web" pointer is deleted, not just hidden.
    expect(find.textContaining('Buy credits on web'), findsNothing);
    expect(find.textContaining('bought on the BadaBhai website'), findsNothing);

    // No purchase surface leaked back in: no 'Buy credits' heading, no pack
    // card (its ₹ price), no Buy button.
    expect(find.text('Buy credits'), findsNothing);
    expect(find.widgetWithText(BbButton, 'Buy'), findsNothing);
    expect(find.textContaining('₹'), findsNothing);
  });

  testWidgets(
      '#2589 — the credit history shows credits only (signed counts), never a '
      '₹ amount', (WidgetTester tester) async {
    await pump(tester);

    // The mock ledger: a +200 pack grant and −1 unlock debits — credit counts.
    expect(find.text('+200'), findsWidgets);
    expect(find.text('−1'), findsWidgets);
    expect(find.textContaining('₹'), findsNothing);
    expect(find.textContaining('INR'), findsNothing);
  });

  testWidgets('still shows the per-unlock history further down', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    // The per-unlock history (`/payer/unlocks`) has its own section further down
    // the lazy ListView (the mock seam returns a non-empty unlock ledger) — scroll
    // it into view before asserting.
    await tester.scrollUntilVisible(
      find.text('Unlock history'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Unlock history'), findsOneWidget);
  });
}
