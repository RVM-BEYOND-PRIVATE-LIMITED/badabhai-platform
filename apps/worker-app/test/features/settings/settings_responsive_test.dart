import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_card.dart';
import 'package:badabhai_worker_app/features/settings/presentation/cubit/account_delete_cubit.dart';
import 'package:badabhai_worker_app/features/settings/presentation/settings_screen.dart';

import '../../core/auth/fakes.dart';
import '../../support/kit_matrix.dart';

class _MockApiClient extends Mock implements ApiClient {}

/// Settings is the screen with the most rows, the longest subtitles and the two
/// modal flows a worker must be able to READ — the DPDP withdraw confirm and the
/// delete-OTP dialog. None of that was pinned at a small size or a large system
/// font before.
void main() {
  late _MockApiClient api;

  setUp(() async {
    // The notifications toggle reads its value through SharedPreferences when
    // there is no session; without this the plugin channel is missing and the
    // row's async load throws into the zone mid-pump.
    SharedPreferences.setMockInitialValues(<String, Object>{});
    api = _MockApiClient();
    await locator.reset();
    setupLocator(apiClient: api, secureStore: FakeSecureStore());
    locator<SessionRepository>().setWorker(
          phone: '+910000000000',
          workerId: 'w1',
          sessionToken: 'tok',
        );
    // #1630 — the employer-contact row loads server truth on mount.
    when(() => api.getConsentState(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ConsentStateDto(
              consentId: 'c1',
              purposes: <String>[
                'profiling',
                'employer_sharing',
                'employer_messaging',
              ],
            ));
    when(() => api.withdrawEmployerContact(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const EmployerContactWithdrawDto(ok: true));
  });

  tearDown(() async => locator.reset());

  testWidgets('the DPDP withdraw confirm is readable at 320x568 @ 2.0', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(320, 568));
    await tester.pumpWidget(kitTestApp(const SettingsScreen(), textScale: 2.0));
    await tester.pump();

    // scrollUntilVisible only guarantees the row EXISTS (it is built a screen
    // ahead of the viewport); ensureVisible is what puts it under the thumb.
    await tester.scrollUntilVisible(
      find.text('Consent wapas lein'),
      120,
      scrollable: find.byType(Scrollable),
    );
    await tester.ensureVisible(find.text('Consent wapas lein'));
    await tester.pump();
    await tester.tap(find.text('Consent wapas lein'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull);
    expect(find.text('Consent wapas lein?'), findsOneWidget);
    // The APPROVED copy, verbatim — the consequence a worker is agreeing to.
    expect(
      find.textContaining('sabhi devices se logout ho jaayenge'),
      findsOneWidget,
    );
    expect(find.text('Rehne dein'), findsOneWidget);

    // Non-dismissible: a legally-meaningful action cannot be tapped past.
    await tester.tapAt(const Offset(4, 4));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Consent wapas lein?'), findsOneWidget);

    await tester.tap(find.text('Rehne dein'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Consent wapas lein?'), findsNothing);
  });

  testWidgets(
    'the delete-OTP dialog still reaches its field and confirm at 320x568 '
    '@ 2.0 with the keyboard up',
    (WidgetTester tester) async {
      when(
        () => api.requestAccountDelete(authToken: any(named: 'authToken')),
      ).thenAnswer(
        (_) async => const AccountDeleteRequestResult(
          success: true,
          resendInSeconds: 30,
        ),
      );
      final SessionRepository session = SessionRepository()
        ..setWorker(
          phone: '+910000000000',
          workerId: 'w1',
          sessionToken: 'tok',
        );
      final AccountDeleteCubit cubit = AccountDeleteCubit(
        api: api,
        session: session,
      );
      await cubit.requestDelete();
      expect(cubit.state.status, AccountDeleteStatus.otpSent);

      // The delete flow is hidden behind `Visibility(visible: false)` today, so
      // the dialog is shown directly through its test seam.
      setKitSurface(tester, const Size(320, 568), keyboard: 260);
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: Builder(
              builder: (BuildContext context) => TextButton(
                onPressed: () => showDialog<bool>(
                  context: context,
                  barrierDismissible: false,
                  builder: (_) => BlocProvider<AccountDeleteCubit>.value(
                    value: cubit,
                    child: const DeleteOtpDialog(),
                  ),
                ),
                child: const Text('open otp'),
              ),
            ),
          ),
          textScale: 2.0,
        ),
      );
      await tester.tap(find.text('open otp'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(tester.takeException(), isNull);
      expect(find.text('OTP daalein'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '123456');
      await tester.pump();

      // The confirm arms at ≥4 digits…
      final TextButton confirm = tester.widget<TextButton>(
        find.widgetWithText(TextButton, 'Delete karein'),
      );
      expect(confirm.onPressed, isNotNull);
      // …and the resend is still an honest countdown off the server cooldown,
      // not an affordance that does nothing.
      expect(find.textContaining('Dobara bhejne ke liye'), findsOneWidget);
      expect(find.text('Dobara OTP bhejein'), findsNothing);

      // Unmount so the 1-second countdown timer does not outlive the test.
      await tester.pumpWidget(const SizedBox.shrink());
      await cubit.close();
    },
  );

  testWidgets('at 768 the group cards stop instead of stretching', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(const SettingsScreen()));
    await tester.pump();

    expect(widthOf(tester, find.byType(KitCard).first), lessThanOrEqualTo(440));
  });

  testWidgets('every settings control clears the 48dp touch floor', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(const SettingsScreen()));
    await tester.pump();

    // Includes the build-id footer: the guideline counts a long-press target
    // exactly like a tap target, and that strip used to be 14dp tall.
    await expectKitTapTargets(tester);
  });

  testWidgets('no raw route, enum or status token is ever rendered', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(kitTestApp(const SettingsScreen()));
    await tester.pump();

    for (final Text t in tester.widgetList<Text>(find.byType(Text))) {
      final String s = t.data ?? '';
      expect(s.contains('/profile'), isFalse);
      expect(s.contains('AccountDeleteStatus'), isFalse);
      expect(s.contains('_'), isFalse, reason: 'no snake_case wire token');
    }
  });

  group('matrix', () {
    kitMatrixTest(
      'settings',
      () => const SettingsScreen(),
      primary: () => find.text('WhatsApp alerts'),
    );
  });
}
