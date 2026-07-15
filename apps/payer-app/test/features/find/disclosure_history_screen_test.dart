import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/find/presentation/disclosure_history_screen.dart';

/// P1 — the disclosure-history CALLER. The cubit/client path is covered in
/// find_reveal_p2_test; this asserts the screen actually invokes
/// `loadDisclosures()` on open and renders the PII-free rows (no full worker id,
/// no name/phone) with a status pill + date.
void main() {
  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: DisclosureHistoryScreen()),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('opens → loads history → renders the disclosure row', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    // Header + the mock row's status pill + formatted disclosed date.
    expect(find.text('Disclosure history'), findsOneWidget);
    expect(find.text('Disclosed'), findsWidgets);
    expect(find.textContaining('01 Jul 2026'), findsOneWidget);
  });

  testWidgets('row is PII-free — the full worker UUID is never shown', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    // The mock discloses worker 'mock-worker-uuid-1'; the row must mask it to
    // the last 4 chars only — the full opaque id must never appear.
    expect(find.textContaining('mock-worker-uuid-1'), findsNothing);
    expect(find.textContaining('id-1'), findsOneWidget); // masked tail
  });
}
