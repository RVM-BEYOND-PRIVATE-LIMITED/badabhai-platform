import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';

/// PASS B — the agency-only Supply / Earn surface. An Agency session reaches the
/// Earn hub and each of the four sub-screens (Referral · Referred · Payouts ·
/// KYC) and back; a Company session has no Earn tab and cannot route to them.
void main() {
  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
    await GetIt.instance<PayerApiClient>().fetchCredits();
  });

  Future<void> bootAs(WidgetTester tester, String pickKey) async {
    await tester.pumpWidget(const PayerApp());
    await tester.pumpAndSettle();
    // Email + OTP login: any email/code signs in (MOCK mode).
    await tester.tap(find.byKey(Key(pickKey)));
    await tester.pump();
    // Org/company name is now required by the details step (MOCK accepts any).
    await tester.enterText(find.byKey(const Key('org_field')), 'Apex Staffing');
    await tester.enterText(find.byKey(const Key('email_field')), 'a@b.com');
    // The extra field can push the CTA below the fold — scroll it into view.
    await tester.ensureVisible(find.byKey(const Key('get_otp')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('get_otp')));
    // Bounded pumps over the brief loading spinner.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byKey(const Key('code_field')), '123456');
    await tester.tap(find.byKey(const Key('verify_otp')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
  }

  Future<void> openEarn(WidgetTester tester) async {
    await tester.tap(find.text('Earn'));
    await tester.pumpAndSettle();
  }

  testWidgets('Agency → Earn hub renders the Mitra-Leader supply surface',
      (WidgetTester tester) async {
    await bootAs(tester, 'pick_agency');
    await openEarn(tester);

    expect(find.text('Mitra-Leader'), findsOneWidget);
    expect(find.text('SUPPLY · EARN'), findsOneWidget);
    // Earned-this-month big mono figure from the seed.
    expect(find.text('₹3,840'), findsOneWidget);
    // The four nav cards.
    expect(find.text('Referral hub'), findsOneWidget);
    expect(find.text('Referred workers'), findsOneWidget);
    expect(find.text('Earnings & payouts'), findsOneWidget);
    expect(find.text('KYC'), findsWidgets);
    // KYC card shows its "Not started" status badge.
    expect(find.text('Not started'), findsOneWidget);
  });

  testWidgets('Agency → Referral hub renders the link + how-it-works, back works',
      (WidgetTester tester) async {
    await bootAs(tester, 'pick_agency');
    await openEarn(tester);

    await tester.tap(find.text('Referral hub'));
    await tester.pumpAndSettle();

    expect(find.text('badabhai.in/r/APEX-7K2'), findsOneWidget);
    expect(find.text('Copy & share link'), findsOneWidget);
    expect(find.text('How earning works'), findsOneWidget);

    // Back returns to the Earn hub.
    await tester.tap(find.byIcon(Icons.arrow_back));
    await tester.pumpAndSettle();
    expect(find.text('Mitra-Leader'), findsOneWidget);
  });

  testWidgets('Agency → Referred workers shows masked rows + window line',
      (WidgetTester tester) async {
    await bootAs(tester, 'pick_agency');
    await openEarn(tester);

    await tester.tap(find.text('Referred workers'));
    await tester.pumpAndSettle();

    // Masked label (mono), never a real identity.
    expect(find.text('Worker ••• 3210'), findsOneWidget);
    expect(find.text('62 days left in window'), findsOneWidget);
    // An attribution badge is present.
    expect(find.text('In window'), findsWidgets);
    expect(find.text('Earned'), findsWidgets);
  });

  testWidgets('Agency → Earnings & payouts shows pending + history',
      (WidgetTester tester) async {
    await bootAs(tester, 'pick_agency');
    await openEarn(tester);

    await tester.tap(find.text('Earnings & payouts'));
    await tester.pumpAndSettle();

    expect(find.text('₹18,520'), findsOneWidget); // total earned
    expect(find.text('₹1,200 / ₹500'), findsOneWidget); // pending / minimum
    expect(find.text('Withdraw to bank'), findsOneWidget);
    expect(find.text('Payout history'), findsOneWidget);
    expect(find.text('₹4,160'), findsOneWidget); // May payout
  });

  testWidgets('Agency → KYC form submits and moves to "Under review"',
      (WidgetTester tester) async {
    await bootAs(tester, 'pick_agency');
    await openEarn(tester);

    final Finder kycCard = find.text('KYC');
    await tester.ensureVisible(kycCard);
    await tester.pumpAndSettle();
    await tester.tap(kycCard);
    await tester.pumpAndSettle();

    // Starts in the form state — the PAN-name field is the first form row.
    expect(find.text('Full name (as on PAN)'), findsOneWidget);

    // The Submit CTA is at the bottom of the form — scroll it into view.
    final Finder submit = find.text('Submit for verification');
    await tester.scrollUntilVisible(
      submit,
      200,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();
    await tester.tap(submit);
    await tester.pumpAndSettle();

    // Moves to the review state.
    expect(find.text('Under review'), findsOneWidget);
  });

  testWidgets('Company has no Earn tab and cannot reach the supply screens',
      (WidgetTester tester) async {
    await bootAs(tester, 'pick_company');

    // No Earn tab in the company nav.
    expect(find.text('Earn'), findsNothing);
    // None of the supply screens are reachable / rendered.
    expect(find.text('Mitra-Leader'), findsNothing);
    expect(find.text('Referral hub'), findsNothing);
    expect(find.text('Earnings & payouts'), findsNothing);
  });
}
