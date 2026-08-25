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
/// policy covers, and the mobile-payments rule bars it outright. What remains is
/// the server balance + ledger and an external pointer to the payer WEB portal
/// where the purchase actually happens. These tests pin that no purchase surface
/// leaks back in, and that the screen still reports what it must.
void main() {
  final List<Uri> launched = <Uri>[];

  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
    launched.clear();
    // Capture WHERE the web pointer goes without a platform channel
    // (`launchUrl` throws MissingPluginException under `flutter test`).
    creditsExternalUrlLauncher = (Uri url) async {
      launched.add(url);
      return true;
    };
    addTearDown(() => creditsExternalUrlLauncher = defaultCreditsUrlLauncher);
  });

  Future<void> pump(WidgetTester tester) async {
    // CreditsScreen is a tab body — the shell supplies the Scaffold/Material.
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: CreditsScreen(onBack: () {}))),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
      'reports the read-only balance + ledger and points to the web, with NO '
      'in-app purchase surface', (WidgetTester tester) async {
    await pump(tester);

    // Still does its actual job: the server balance + the credit ledger.
    expect(find.text('Credits'), findsOneWidget); // title
    expect(find.text('Current balance'), findsOneWidget);
    // The credit-account ledger (`/payer/credits/ledger`) — the old 'Unlock
    // ledger' heading mislabelled it; the real per-unlock history is separate.
    expect(find.text('Credit ledger'), findsOneWidget);

    // The external pointer that REPLACED the purchase, and the note saying why.
    expect(find.text(kBuyCreditsOnWebLabel), findsOneWidget);
    expect(find.text(kBuyCreditsOnWebNote), findsOneWidget);

    // No purchase surface leaked back in: no 'Buy credits' heading, no pack
    // card (its ₹ price), no Buy button.
    expect(find.text('Buy credits'), findsNothing);
    expect(find.widgetWithText(BbButton, 'Buy'), findsNothing);
    expect(find.textContaining('₹'), findsNothing);
  });

  testWidgets(
      'tapping the pointer hands an https web URL to the OS, not an in-app '
      'purchase', (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text(kBuyCreditsOnWebLabel));
    await tester.pumpAndSettle();

    expect(launched.length, 1);
    expect(launched.single.scheme, 'https');
    expect(launched.single.path, endsWith('/credits'));
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
