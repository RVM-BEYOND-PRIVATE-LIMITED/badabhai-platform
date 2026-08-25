import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/agency/presentation/agency_earnings_screen.dart';
import 'package:payer_app/features/agency/presentation/agency_kyc_screen.dart';
import 'package:payer_app/features/agency/presentation/agency_payouts_screen.dart';

/// P1 — the agency supply-money screens render the real (mock-seam) data and the
/// money-OUT request flow is walkable, AND the FLAG-OFF neutral 404 degrades to
/// an honest "not available yet" state (never a crash / generic error).

/// A client whose supply-money reads all 404 — simulates `AGENCY_PAYOUTS_ENABLED`
/// off (the guard's neutral 404). Everything else stays the canned mock.
class _FlagOffApi extends MockPayerApiClient {
  @override
  Future<AgencyEarnings> fetchAgencyEarnings() async =>
      throw const PayerApiException(404);

  @override
  Future<AgencyKycView> fetchAgencyKyc() async =>
      throw const PayerApiException(404);

  @override
  Future<List<AgencyPayout>> fetchAgencyPayouts() async =>
      throw const PayerApiException(404);
}

Future<void> _boot({MockPayerApiClient? api}) async {
  await GetIt.instance.reset();
  setupLocator(
    apiClient: api ?? MockPayerApiClient(),
    secureStore: InMemoryKeyValueStore(),
  );
}

void main() {
  tearDown(() async => GetIt.instance.reset());

  group('Earnings screen (flag ON, mock seam)', () {
    testWidgets('renders the requestable amount, KYC chip and request CTA',
        (WidgetTester tester) async {
      await _boot();
      await tester.pumpWidget(const MaterialApp(home: AgencyEarningsScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Earnings & payouts'), findsOneWidget);
      // The seeded requestable balance + the money-OUT request CTA.
      expect(find.text('₹850'), findsWidgets);
      expect(find.text('Request payout'), findsOneWidget);
      // The KYC nav card shows the live verified chip.
      expect(find.text('Verified'), findsOneWidget);
    });

    testWidgets('requesting a payout confirms then toasts success',
        (WidgetTester tester) async {
      await _boot();
      await tester.pumpWidget(const MaterialApp(home: AgencyEarningsScreen()));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Request payout'));
      await tester.pumpAndSettle();
      // The confirmation dialog (a plain confirm — NO card/gateway UI).
      expect(find.text('Request payout?'), findsOneWidget);

      await tester.tap(find.text('Request'));
      await tester.pump(); // run the async request
      await tester.pump(const Duration(milliseconds: 400)); // toast animates in

      expect(find.textContaining('Payout requested'), findsOneWidget);

      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
    });
  });

  group('Earnings screen (flag OFF → neutral 404)', () {
    testWidgets('degrades to an honest "not available yet" state',
        (WidgetTester tester) async {
      await _boot(api: _FlagOffApi());
      await tester.pumpWidget(const MaterialApp(home: AgencyEarningsScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Payouts aren’t available yet'), findsOneWidget);
      // The money CTA must NOT be shown when the surface is inert.
      expect(find.text('Request payout'), findsNothing);
    });
  });

  group('KYC screen', () {
    testWidgets('renders the masked status + the details form',
        (WidgetTester tester) async {
      await _boot();
      await tester.pumpWidget(const MaterialApp(home: AgencyKycScreen()));
      await tester.pumpAndSettle();

      expect(find.text('KYC details'), findsWidgets);
      // Masked last-4 only — never a full PAN/bank.
      expect(find.text('•••• 234F'), findsOneWidget);
      expect(find.text('PAN'), findsWidgets);
      expect(find.text('IFSC'), findsWidgets);
    });

    testWidgets('flag OFF → "not available yet"',
        (WidgetTester tester) async {
      await _boot(api: _FlagOffApi());
      await tester.pumpWidget(const MaterialApp(home: AgencyKycScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Not available yet'), findsOneWidget);
    });
  });

  group('Payout history screen', () {
    testWidgets('renders the seeded payout row', (WidgetTester tester) async {
      await _boot();
      await tester.pumpWidget(const MaterialApp(home: AgencyPayoutsScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Payout history'), findsWidgets);
      expect(find.text('₹500'), findsOneWidget);
      expect(find.text('Paid'), findsOneWidget);
    });

    testWidgets('flag OFF → "not available yet"',
        (WidgetTester tester) async {
      await _boot(api: _FlagOffApi());
      await tester.pumpWidget(const MaterialApp(home: AgencyPayoutsScreen()));
      await tester.pumpAndSettle();

      expect(find.text('Not available yet'), findsOneWidget);
    });
  });
}
