import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';

/// Smoke test: the app boots to Login; picking Company vs Agency and getting OTP
/// lands on Home with the shared nav; and a candidate card on Find shows the
/// redacted name + ₹40 — never a demographic.
///
/// The agency Earn tab (and its hub / referral / referred / payouts / KYC
/// screens) was REMOVED — no backend route existed, so every figure on it was
/// invented — hence both roles now see the same tabs, `Credits` included.
void main() {
  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
    // Pre-load the shared credit balance so the dialog/stat read a real number.
    await GetIt.instance<PayerApiClient>().fetchCredits();
  });

  Future<void> boot(WidgetTester tester) async {
    await tester.pumpWidget(const PayerApp());
    await tester.pumpAndSettle();
  }

  // Email + OTP login: pick a role, enter any email, get the code, enter any
  // code, verify. In MOCK mode any email/code signs in.
  Future<void> loginAs(WidgetTester tester, String pickKey) async {
    await tester.tap(find.byKey(Key(pickKey)));
    await tester.pump();
    // Org/company name is required by the backend signup schema; fill it so the
    // details step advances (MOCK accepts any value).
    await tester.enterText(find.byKey(const Key('org_field')), 'Acme Works');
    await tester.enterText(find.byKey(const Key('email_field')), 'a@b.com');
    // The extra field can push the CTA below the fold — scroll it into view.
    await tester.ensureVisible(find.byKey(const Key('get_otp')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('get_otp')));
    // Bounded pumps over the brief loading spinner (an indefinite indicator
    // never lets pumpAndSettle settle on its own).
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byKey(const Key('code_field')), '123456');
    await tester.tap(find.byKey(const Key('verify_otp')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
  }

  testWidgets('boots to Login with the role picker', (WidgetTester tester) async {
    await boot(tester);

    expect(find.text('Hire faster,\nbada bhai ke saath.'), findsOneWidget);
    expect(find.byKey(const Key('pick_company')), findsOneWidget);
    expect(find.byKey(const Key('pick_agency')), findsOneWidget);
    expect(find.byKey(const Key('get_otp')), findsOneWidget);
    expect(find.byKey(const Key('email_field')), findsOneWidget);
  });

  testWidgets('Company login → Home shows the shared nav (Credits, no Earn)',
      (WidgetTester tester) async {
    await boot(tester);
    await loginAs(tester, 'pick_company');

    expect(find.text('Credits'), findsOneWidget);
    expect(find.text('Earn'), findsNothing);
    // Company identity in the header.
    expect(find.text('Kalyani Industries'), findsOneWidget);
  });

  testWidgets('Agency login → Home shows the same nav; no Earn surface at all',
      (WidgetTester tester) async {
    await boot(tester);
    await loginAs(tester, 'pick_agency');

    // An agency gets the SAME tabs as a company — Credits is real for both.
    expect(find.text('Credits'), findsOneWidget);
    expect(find.text('Apex Staffing'), findsOneWidget);
    // The Earn tab and its saffron ₹ summary card are gone for every role.
    expect(find.text('Earn'), findsNothing);
    expect(find.text('EARN · SUPPLY'), findsNothing);
    expect(find.text('Mitra-Leader'), findsNothing);
  });

  testWidgets('Home shows no fabricated metrics or recent-activity feed',
      (WidgetTester tester) async {
    await boot(tester);
    await loginAs(tester, 'pick_company');

    // The invented dashboard is gone: no paid-unlocks hero, no repeat-unlock
    // rate, no candidates-for-you count, and no "Recent activity" feed (which
    // fabricated rows like "Unlocked Ramesh K. · CNC Setter").
    expect(find.text('Paid unlocks this week'), findsNothing);
    expect(find.text('Repeat-unlock rate'), findsNothing);
    expect(find.text('Candidates for you'), findsNothing);
    expect(find.text('Recent activity'), findsNothing);
    expect(find.textContaining('Unlocked Ramesh K.'), findsNothing);
    // What remains is real: the server-truth credit balance.
    expect(find.text('Credit balance'), findsOneWidget);
  });

  testWidgets('Credits screen shows the real balance + ledger, no checkout',
      (WidgetTester tester) async {
    await boot(tester);
    await loginAs(tester, 'pick_company');

    await tester.tap(find.text('Credits'));
    await tester.pumpAndSettle();

    // Real, server-sourced figures stay.
    expect(find.text('Current balance'), findsOneWidget);
    expect(find.text('Unlock ledger'), findsOneWidget);
    // The money surface is gone: no payment-provider claim and no pack buy
    // (the pack prices were hardcoded client-side and contradicted the server).
    expect(find.textContaining('Razorpay'), findsNothing);
    expect(find.textContaining('Secure checkout'), findsNothing);
    expect(find.text('Best value'), findsNothing);
    expect(find.text('₹2,000'), findsNothing);
    expect(find.text('₹34,000'), findsNothing);
  });

  testWidgets('Find feed shows a redacted name + ₹40, never a demographic',
      (WidgetTester tester) async {
    await boot(tester);
    await loginAs(tester, 'pick_company');

    // Go to the Find tab.
    await tester.tap(find.text('Find'));
    await tester.pumpAndSettle();

    // A masked candidate renders a redacted name (soft dots, no solid block) and
    // a ₹40 unlock — the real name stays hidden until a paid unlock.
    expect(find.textContaining('••••'), findsWidgets);
    expect(find.textContaining('█'), findsNothing);
    expect(find.text('₹40'), findsWidgets);
    // The real (unmasked) name must NOT be visible before a paid unlock.
    expect(find.text('Ramesh Kumar'), findsNothing);
    // No demographic fields anywhere in the feed.
    for (final String banned in <String>['Male', 'Female', 'Age', 'Caste', 'Religion']) {
      expect(find.text(banned), findsNothing);
    }
  });
}
