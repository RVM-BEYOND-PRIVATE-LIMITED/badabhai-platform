import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/features/account/presentation/account_screen.dart';

/// M9 (#2597): the payer app signs in with a password or a one-time code sent
/// to the work email or phone, so the sign-out confirm must not say "phone
/// number and OTP".
void main() {
  const AppSession session = AppSession(
    role: PayerRole.company,
    account: PayerAccount(
        name: 'Kalyani Industries', plan: 'Starter', initials: 'KI'),
  );

  setUp(() async {
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  Future<int> pumpAndOpenSignOut(WidgetTester tester) async {
    int signOuts = 0;
    tester.view.physicalSize = const Size(400, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AccountScreen(session: session, onSignOut: () => signOuts++),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Sign out'));
    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();
    return signOuts;
  }

  testWidgets('the sign-out confirm names the real sign-in methods', (
    WidgetTester tester,
  ) async {
    await pumpAndOpenSignOut(tester);
    expect(find.text('Sign out?'), findsOneWidget);
    expect(find.text(kSignOutConfirmMessage), findsOneWidget);
    expect(find.textContaining('OTP'), findsNothing);
  });

  testWidgets('the Privacy & DPDP row has no chevron and no tap action', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(400, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AccountScreen(session: session, onSignOut: () {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final Finder row = find.text('Privacy & DPDP consent');
    expect(row, findsOneWidget);
    expect(
      find.ancestor(of: row, matching: find.byType(InkWell)),
      findsNothing,
    );
  });
}
