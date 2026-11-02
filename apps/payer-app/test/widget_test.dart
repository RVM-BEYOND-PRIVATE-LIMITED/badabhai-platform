import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';

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

  // Sign up (role → company → contact → OTP → password) then land on Home.
  // In MOCK mode any contact/code works; the account remembers the password.
  Future<void> loginAs(WidgetTester tester, String pickKey,
      {String contact = 'a@b.com'}) async {
    await tester.tap(find.byKey(const Key('signup_open')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(Key(pickKey)));
    await tester.pump();
    // Org/company name is required by the backend signup schema; fill it so the
    // details step advances (MOCK accepts any value).
    await tester.enterText(find.byKey(const Key('org_field')), 'Acme Works');
    await tester.enterText(find.byKey(const Key('contact_field')), contact);
    // The extra field can push the CTA below the fold — scroll it into view.
    await tester.ensureVisible(find.byKey(const Key('get_otp')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('get_otp')));
    // Bounded pumps over the brief loading spinner (an indefinite indicator
    // never lets pumpAndSettle settle on its own).
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    // The details→code step animates (BbAnimatedSwitcher). Advance past the swap
    // so the code step is laid out and hittable.
    await tester.pump(const Duration(milliseconds: 300));
    await tester.enterText(find.byKey(const Key('code_field')), '123456');
    await tester.tap(find.byKey(const Key('verify_otp')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 300));

    // Password step — set + confirm, then create the profile.
    await tester.enterText(
        find.byKey(const Key('signup_password')), 'Secret123');
    await tester.enterText(
        find.byKey(const Key('signup_confirm')), 'Secret123');
    await tester.ensureVisible(find.byKey(const Key('create_profile')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('create_profile')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
  }

  testWidgets('boots to the password login (with sign-up and OTP fallback)',
      (WidgetTester tester) async {
    await boot(tester);

    expect(find.text('Hire faster,\nbada bhai ke saath.'), findsOneWidget);
    expect(find.byKey(const Key('login_identifier')), findsOneWidget);
    expect(find.byKey(const Key('login_password')), findsOneWidget);
    expect(find.byKey(const Key('login_button')), findsOneWidget);
    expect(find.byKey(const Key('signup_open')), findsOneWidget);
    expect(find.byKey(const Key('otp_login_open')), findsOneWidget);
  });

  testWidgets('sign-up shows the role picker and the OTP step',
      (WidgetTester tester) async {
    await boot(tester);
    await tester.tap(find.byKey(const Key('signup_open')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('pick_company')), findsOneWidget);
    expect(find.byKey(const Key('pick_agency')), findsOneWidget);
    expect(find.byKey(const Key('org_field')), findsOneWidget);
    expect(find.byKey(const Key('contact_field')), findsOneWidget);
    expect(find.byKey(const Key('get_otp')), findsOneWidget);
  });

  testWidgets('sign up, sign out, then log in with company name + password',
      (WidgetTester tester) async {
    await boot(tester);
    await loginAs(tester, 'pick_company');

    // The account now exists in the MOCK auth seam; drop the session and sign in
    // again with the exact company name + the password chosen at signup.
    await GetIt.instance<AppSessionCubit>().signOut();
    await tester.pumpAndSettle();

    await tester.enterText(
        find.byKey(const Key('login_identifier')), 'Acme Works');
    await tester.enterText(
        find.byKey(const Key('login_password')), 'Secret123');
    await tester.tap(find.byKey(const Key('login_button')));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('Post a job'), findsWidgets);
  });

  testWidgets('a phone typed with spaces logs in after a phone signup',
      (WidgetTester tester) async {
    await boot(tester);
    await loginAs(tester, 'pick_agency', contact: '89469 91002');

    await GetIt.instance<AppSessionCubit>().signOut();
    await tester.pumpAndSettle();

    // The signup normalized this to +918946991002; the login normalizes the same
    // way, so a loosely-typed number still matches.
    await tester.enterText(
        find.byKey(const Key('login_identifier')), '89469 91002');
    await tester.enterText(
        find.byKey(const Key('login_password')), 'Secret123');
    await tester.tap(find.byKey(const Key('login_button')));
    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('Post a job'), findsWidgets);
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

    // Real, server-sourced figures stay. The credit-account movements now sit
    // under the accurately-named 'Credit ledger'; the per-unlock history has its
    // own 'Unlock history' section (the old 'Unlock ledger' heading conflated
    // the two).
    expect(find.text('Current balance'), findsOneWidget);
    expect(find.text('Credit ledger'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Unlock history'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Unlock history'), findsOneWidget);
    // The MOCK pack buy is restored (server-priced), but the REAL-money surface
    // stays absent: no payment provider, no web checkout, no old hardcoded prices.
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
