import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/settings/presentation/settings_screen.dart';

import '../../core/auth/fakes.dart';

class _MockApiClient extends Mock implements ApiClient {}

/// An [AuthApi] that supports exactly the DEFAULT cold-start path — PIN unlock —
/// and reports [deletionScheduledFor] from GET /auth/me, which is the ONLY place
/// a PIN unlock can learn about a pending deletion (the PIN-verify response
/// carries no such field). Null = the server omits it = nothing pending.
class _PinUnlockAuthApi extends AuthApi {
  _PinUnlockAuthApi({this.deletionScheduledFor}) : super.withoutClient();

  final DateTime? deletionScheduledFor;

  @override
  Future<PinVerifyResult> pinVerify(String pin,
          {required String refreshToken}) async =>
      PinVerifyResult(
        tokens: AuthTokens(
          access: 'tok',
          refresh: 'rotated-refresh',
          accessExpiresAt: DateTime.now().add(const Duration(minutes: 15)),
        ),
        consentAccepted: true,
      );

  @override
  Future<MeResult> me() async => MeResult(
        workerId: 'w1',
        status: 'active',
        deletionScheduledFor: deletionScheduledFor,
      );
}

void main() {
  late _MockApiClient api;
  late FakeSecureStore secureBacking;

  // The screen resolves AccountDeleteCubit (and its SessionRepository seed)
  // through the locator, so each test wires a fresh graph with a mock API —
  // no network can be reached.
  setUp(() async {
    api = _MockApiClient();
    secureBacking = FakeSecureStore();
    await locator.reset();
    setupLocator(apiClient: api, secureStore: secureBacking);
  });

  tearDown(() => locator.reset());

  /// Drives the app's DEFAULT cold start for a returning worker: a remembered
  /// refresh token → bootstrap → locked → PIN unlock → authenticated. This path
  /// never touches the OTP login whose response carries the pending-deletion
  /// flag, so it is the one that must re-read it from /auth/me.
  Future<AuthSessionManager> coldStartViaPinUnlock({
    DateTime? pendingDeletion,
  }) async {
    await initAuthLocator(
      localeStore: LocaleStore(FakePrefs()),
      authApi: _PinUnlockAuthApi(deletionScheduledFor: pendingDeletion),
      // kPersistentAuth is false under a plain `flutter test` (no dart-define),
      // so force ON the layer that is ON by default in real builds.
      persistentAuthEnabled: true,
    );
    final SecureTokenStore store = locator<SecureTokenStore>();
    await store.writeRefreshToken('remembered');
    await store.writeWorkerId('w1');

    final AuthSessionManager manager = locator<AuthSessionManager>();
    expect(await manager.bootstrap(), AuthStatus.locked);
    await manager.unlockWithPin('7416');
    expect(manager.status, AuthStatus.authenticated);
    return manager;
  }

  testWidgets('renders the rows + legal footer', (WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('WhatsApp alerts'), findsOneWidget);
    expect(find.text('Account delete karein'), findsOneWidget);
    expect(find.textContaining('Made in India'), findsOneWidget);
  });

  // Both rows are hidden for now: 'Bhasha' until real localization ships (it
  // set X-Locale with no translated strings behind it), 'Aapke devices' by
  // request. Their screens/routes still exist — only the entry points are gone,
  // so assert the rows to catch an accidental re-add.
  testWidgets('hides the Bhasha + Aapke devices rows',
      (WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('Bhasha'), findsNothing);
    expect(find.text('Aapke devices'), findsNothing);
  });

  testWidgets('account-delete opens the 7-day grace confirmation', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    await tester.tap(find.text('Account delete karein'));
    await tester.pumpAndSettle();

    expect(find.text('Account delete karein?'), findsOneWidget);
    expect(find.textContaining('cancel kar sakte hain'), findsOneWidget);
  });

  testWidgets(
      'a pending deletion (ADR-0031) shows the banner instead of the delete '
      'row; cancel returns the row + snackbar', (WidgetTester tester) async {
    // Seed the grace window as a post-login session would (flag + token).
    locator<SessionRepository>()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setDeletionScheduledFor(DateTime.utc(2026, 7, 21, 12));
    when(() => api.cancelAccountDelete(authToken: any(named: 'authToken')))
        .thenAnswer((_) async {});

    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    // The banner replaces the delete row and carries the absolute date.
    expect(find.text('Account delete karein'), findsNothing);
    expect(find.textContaining('ko delete hoga'), findsOneWidget);
    expect(find.text('Delete cancel karein'), findsOneWidget);

    await tester.tap(find.text('Delete cancel karein'));
    await tester.pumpAndSettle();

    verify(() => api.cancelAccountDelete(authToken: 'tok')).called(1);
    expect(find.text('Account delete cancel ho gaya'), findsOneWidget);
    // The normal delete row is back; the flag is cleared everywhere.
    expect(find.text('Account delete karein'), findsOneWidget);
    expect(locator<SessionRepository>().deletionScheduledFor, isNull);
  });

  testWidgets(
      'ADR-0031 cold start via PIN UNLOCK (the default path) with a pending '
      'deletion → the banner + explicit cancel are reachable', (
    WidgetTester tester,
  ) async {
    // The regression this locks down: the worker schedules a deletion, closes
    // the app, reopens it (bootstrap → locked → PIN), and must still be able to
    // cancel — the shipped copy promises "Is dauraan aap kabhi bhi cancel kar
    // sakte hain". Before the /auth/me sync, this path left the flag null and
    // Settings rendered the ordinary delete row for the rest of the 7 days.
    await coldStartViaPinUnlock(pendingDeletion: DateTime.utc(2026, 7, 21, 12));
    when(() => api.cancelAccountDelete(authToken: any(named: 'authToken')))
        .thenAnswer((_) async {});

    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('Account delete karein'), findsNothing);
    expect(find.textContaining('ko delete hoga'), findsOneWidget);
    expect(find.text('Delete cancel karein'), findsOneWidget);

    // And the cancel actually works off the token the unlock bridged.
    await tester.tap(find.text('Delete cancel karein'));
    await tester.pumpAndSettle();

    verify(() => api.cancelAccountDelete(authToken: 'tok')).called(1);
    expect(find.text('Account delete karein'), findsOneWidget);
    expect(locator<SessionRepository>().deletionScheduledFor, isNull);
  });

  // ---- #361 — the delete-OTP dialog's resend ----
  //
  // The dialog used to swap its countdown for the plain text "Naya OTP bhej
  // sakte hain" and offer nothing to tap, so a lost delete-OTP dead-ended the
  // legally-required DPDP deletion flow behind copy telling the worker to do
  // something the dialog gave them no way to do.

  /// Drives Settings → confirm → OTP dialog, with the first delete-OTP request
  /// answering [firstCooldown] seconds of cooldown.
  Future<void> openDeleteOtpDialog(
    WidgetTester tester, {
    int firstCooldown = 0,
  }) async {
    locator<SessionRepository>()
        .setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
    when(() => api.requestAccountDelete(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => AccountDeleteRequestResult(
            success: true, resendInSeconds: firstCooldown));

    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    await tester.tap(find.text('Account delete karein'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete karein')); // confirm the 7-day grace
    await tester.pumpAndSettle();

    expect(find.text('OTP daalein'), findsOneWidget);
  }

  testWidgets(
      'once the cooldown elapses the dialog offers a REAL resend, not the old '
      'dead-end caption', (WidgetTester tester) async {
    await openDeleteOtpDialog(tester);

    // The copy that promised an affordance that did not exist is gone...
    expect(find.text('Naya OTP bhej sakte hain'), findsNothing);
    // ...replaced by something the worker can actually tap.
    expect(find.widgetWithText(TextButton, 'Dobara OTP bhejein'), findsOneWidget);
    final TextButton resend =
        tester.widget(find.widgetWithText(TextButton, 'Dobara OTP bhejein'));
    expect(resend.onPressed, isNotNull);
  });

  testWidgets('the resend re-requests the OTP and restarts the countdown from '
      'the fresh server cooldown', (WidgetTester tester) async {
    await openDeleteOtpDialog(tester);
    // The resend answers a real cooldown, which must re-arm the control.
    when(() => api.requestAccountDelete(authToken: any(named: 'authToken')))
        .thenAnswer((_) async =>
            const AccountDeleteRequestResult(success: true, resendInSeconds: 30));

    await tester.tap(find.text('Dobara OTP bhejein'));
    await tester.pump(); // sendingOtp
    await tester.pump(); // otpSent → listener restarts the countdown

    // A SECOND request actually went out on the session token — this is a real
    // resend, not just a re-render.
    verify(() => api.requestAccountDelete(authToken: 'tok')).called(2);
    // And the button re-arms behind the server's own cooldown rather than
    // letting the worker burn OTPs back to back.
    expect(find.text('Dobara bhejne ke liye 30 second'), findsOneWidget);
    expect(find.text('Dobara OTP bhejein'), findsNothing);

    // Close the dialog so the countdown timer is disposed with its State.
    await tester.tap(find.text('Rehne dein'));
    await tester.pumpAndSettle();
  });

  testWidgets('a rate-limited resend surfaces the honest reason in the dialog',
      (WidgetTester tester) async {
    await openDeleteOtpDialog(tester);
    when(() => api.requestAccountDelete(authToken: any(named: 'authToken')))
        .thenThrow(ApiException(429, 'too many'));

    await tester.tap(find.text('Dobara OTP bhejein'));
    await tester.pump();
    await tester.pump();

    // Not a silent no-op: the worker is told why, and can try again.
    expect(find.text('Bahut requests. Thodi der baad dobara try karein.'),
        findsOneWidget);
    expect(find.text('Dobara OTP bhejein'), findsOneWidget);
  });

  testWidgets('while the cooldown runs there is no resend to tap',
      (WidgetTester tester) async {
    await openDeleteOtpDialog(tester, firstCooldown: 45);

    expect(find.text('Dobara bhejne ke liye 45 second'), findsOneWidget);
    expect(find.text('Dobara OTP bhejein'), findsNothing);

    await tester.tap(find.text('Rehne dein'));
    await tester.pumpAndSettle();
  });

  testWidgets(
      'ADR-0031 cold start via PIN UNLOCK with NOTHING pending → the ordinary '
      'delete row, no banner, no fabricated date', (WidgetTester tester) async {
    await coldStartViaPinUnlock(); // server omits deletion_scheduled_for

    await tester.pumpWidget(MaterialApp(
      theme: AppTheme.light(),
      home: const SettingsScreen(),
    ));

    expect(find.text('Account delete karein'), findsOneWidget);
    expect(find.text('Delete cancel karein'), findsNothing);
    expect(find.textContaining('delete hoga'), findsNothing);
    expect(locator<SessionRepository>().deletionScheduledFor, isNull);
  });
}
