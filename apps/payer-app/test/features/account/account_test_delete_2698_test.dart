import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_account_api.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/features/account/presentation/account_screen.dart';

/// #2698 — the payer Account screen mirrors the worker Profile's QA-only
/// "Delete account (test)" affordance: hidden unless the build (or this test)
/// opts in, confirmed before acting, and on success it hands off to the normal
/// sign-out teardown. A failure (including the seam-disabled 404) keeps the
/// session and says so honestly.
class _RecordingAccountApi implements PayerAccountApi {
  _RecordingAccountApi({this.deleteError});

  final Object? deleteError;
  int deleteCalls = 0;

  @override
  Future<PayerMe> fetchMe() async => const PayerMe(
        id: 'payer-1',
        role: 'employer',
        status: 'active',
        orgName: 'Kalyani Industries',
        email: 'demo@badabhai.in',
        phoneLast4: '3210',
      );

  @override
  Future<PayerMe> updateMe({String? orgName, String? phone}) async =>
      throw UnimplementedError();

  @override
  Future<void> logout() async {}

  @override
  Future<void> deleteAccountImmediatelyForTest() async {
    deleteCalls++;
    final Object? error = deleteError;
    if (error != null) throw error;
  }
}

const AppSession _companySession = AppSession(
  role: PayerRole.company,
  account: PayerAccount(
    name: 'Kalyani Industries',
    plan: 'Starter',
    initials: 'KI',
  ),
);

const AppSession _agencySession = AppSession(
  role: PayerRole.agency,
  account: PayerAccount(
    name: 'Apex Staffing',
    plan: 'Agency · supply + demand',
    initials: 'AS',
  ),
);

void _install(_RecordingAccountApi accountApi) {
  setupLocator(
    apiClient: MockPayerApiClient(),
    accountApi: accountApi,
    secureStore: InMemoryKeyValueStore(),
  );
}

Future<void> _pumpAccount(
  WidgetTester tester, {
  required AppSession session,
  bool? testDeleteOverride,
  required VoidCallback onSignOut,
}) async {
  tester.view.physicalSize = const Size(400, 1600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: AccountScreen(
          session: session,
          onSignOut: onSignOut,
          testDeleteOverride: testDeleteOverride,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(() async {
    await GetIt.instance.reset();
  });

  for (final PayerRole role in PayerRole.values) {
    final AppSession session =
        role == PayerRole.company ? _companySession : _agencySession;

    testWidgets('stock build (flag off) hides delete for ${role.name}', (
      WidgetTester tester,
    ) async {
      _install(_RecordingAccountApi());
      await _pumpAccount(tester, session: session, onSignOut: () {});

      // Sign out proves the screen rendered to its footer.
      expect(find.text('Sign out'), findsOneWidget);
      expect(find.text('Delete account (test)'), findsNothing);
    });

    testWidgets('with the flag on, delete renders for ${role.name}', (
      WidgetTester tester,
    ) async {
      _install(_RecordingAccountApi());
      await _pumpAccount(
        tester,
        session: session,
        testDeleteOverride: true,
        onSignOut: () {},
      );

      expect(find.text('Sign out'), findsOneWidget);
      expect(find.text('Delete account (test)'), findsOneWidget);
    });
  }

  testWidgets('confirm deletes, then hands off to the sign-out teardown', (
    WidgetTester tester,
  ) async {
    final _RecordingAccountApi api = _RecordingAccountApi();
    _install(api);
    int signOuts = 0;
    await _pumpAccount(
      tester,
      session: _companySession,
      testDeleteOverride: true,
      onSignOut: () => signOuts++,
    );

    await tester.ensureVisible(find.text('Delete account (test)'));
    await tester.tap(find.text('Delete account (test)'));
    await tester.pumpAndSettle();

    expect(find.text('Account delete karein?'), findsOneWidget);
    expect(
        find.text('Yeh aapka account turant delete kar dega.'), findsOneWidget);

    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(api.deleteCalls, 1);
    expect(signOuts, 1);
  });

  testWidgets('cancelling the confirm never calls the delete endpoint', (
    WidgetTester tester,
  ) async {
    final _RecordingAccountApi api = _RecordingAccountApi();
    _install(api);
    int signOuts = 0;
    await _pumpAccount(
      tester,
      session: _companySession,
      testDeleteOverride: true,
      onSignOut: () => signOuts++,
    );

    await tester.ensureVisible(find.text('Delete account (test)'));
    await tester.tap(find.text('Delete account (test)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(api.deleteCalls, 0);
    expect(signOuts, 0);
  });

  testWidgets('a disabled seam shows the honest toast and keeps the session', (
    WidgetTester tester,
  ) async {
    final _RecordingAccountApi api =
        _RecordingAccountApi(deleteError: const PayerApiException(404));
    _install(api);
    int signOuts = 0;
    await _pumpAccount(
      tester,
      session: _companySession,
      testDeleteOverride: true,
      onSignOut: () => signOuts++,
    );

    await tester.ensureVisible(find.text('Delete account (test)'));
    await tester.tap(find.text('Delete account (test)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();

    expect(api.deleteCalls, 1);
    expect(signOuts, 0);
    expect(find.text('Test delete is not enabled on this server.'),
        findsOneWidget);
    // Still on Account — the session was not torn down.
    expect(find.text('Sign out'), findsOneWidget);

    // Drain the toast's own timer.
    await tester.pump(const Duration(seconds: 7));
    await tester.pumpAndSettle();
  });
}
