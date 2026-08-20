import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/widgets/bb_button.dart';
import 'package:payer_app/features/credits/presentation/credits_screen.dart';

/// The purchase surface is RESTORED: the two reasons #376 removed it are gone —
/// packs + prices now come from the SERVER pricing catalog (never hardcoded), and
/// a MOCK buy endpoint (`POST /payer/credits`) grants credits with no real money.
/// These tests pin the buy section + a working (mock) purchase, plus that the
/// screen still reports the balance + ledger.
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

  testWidgets('shows a Buy credits section with server-priced packs', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    expect(find.text('Credits'), findsOneWidget); // title
    expect(find.text('Buy credits'), findsOneWidget); // restored section
    // Packs from the (mock) catalog render with a Buy button each.
    expect(find.widgetWithText(BbButton, 'Buy'), findsWidgets);
    expect(find.textContaining('₹'), findsWidgets);
  });

  testWidgets('tapping Buy runs the (mock) purchase and confirms', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    await tester.tap(find.widgetWithText(BbButton, 'Buy').first);
    await tester.pumpAndSettle();

    // The mock buy grants credits + the screen confirms with a snackbar.
    expect(find.text('Credits add ho gaye.'), findsOneWidget);
  });

  testWidgets('still reports the server balance + ledger', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    // Adding the buy section must not have cost the screen its actual job.
    expect(find.text('Current balance'), findsOneWidget);
    // The credit-account ledger (`/payer/credits/ledger`) — the old 'Unlock
    // ledger' heading mislabelled it; the real per-unlock history is separate.
    expect(find.text('Credit ledger'), findsOneWidget);
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
