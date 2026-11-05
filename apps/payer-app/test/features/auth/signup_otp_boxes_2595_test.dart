import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_auth_api.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart' show PayerApiException;
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/core/widgets/bb_otp_input.dart';
import 'package:payer_app/features/auth/presentation/signup_screen.dart';
import 'package:payer_app/features/auth/presentation/widgets/auth_form_support.dart';

/// #2595 (M7) — the sign-up code step on the six-box OTP. The sixth digit runs
/// the same verify as the Verify button, the two never both fire, and a failed
/// verify empties the boxes so the same code can be entered again.
void main() {
  const Key codeField = Key('code_field');
  const Key verifyButton = Key('verify_otp');
  const Key passwordField = Key('signup_password');

  late _VerifyAuthApi auth;

  setUp(() async {
    await GetIt.instance.reset();
    auth = _VerifyAuthApi();
    setupLocator(
      apiClient: MockPayerApiClient(),
      authApi: auth,
      secureStore: InMemoryKeyValueStore(),
    );
  });

  tearDown(() async {
    await GetIt.instance.reset();
  });

  /// Fixed pumps past the 220ms step swap. Never `pumpAndSettle`: the busy
  /// button's spinner would not let it settle.
  Future<void> settle(WidgetTester tester) async {
    for (int i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  /// Sign-up on a 360dp phone with the details filled in and a code
  /// requested, so the code step is on screen.
  Future<void> openCodeStep(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light(), home: const SignupScreen()),
    );
    await tester.enterText(find.byKey(const Key('org_field')), 'Acme Works');
    await tester.enterText(find.byKey(const Key('contact_field')), 'a@b.com');
    await tester.ensureVisible(find.byKey(const Key('get_otp')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('get_otp')));
    await settle(tester);
    expect(find.byKey(codeField), findsOneWidget);
  }

  /// The digit drawn in each of the six boxes ('' while empty).
  List<String> boxes(WidgetTester tester) => <String>[
        for (int i = 0; i < 6; i++)
          tester
              .widget<Text>(find.descendant(
                of: find.byKey(BbOtpInput.boxKey(i)),
                matching: find.byType(Text),
              ))
              .data!,
      ];

  testWidgets('the code step is six OTP boxes over the code field', (
    WidgetTester tester,
  ) async {
    await openCodeStep(tester);

    expect(find.byType(BbOtpInput), findsOneWidget);
    for (int i = 0; i < 6; i++) {
      expect(find.byKey(BbOtpInput.boxKey(i)), findsOneWidget);
    }
    // The stable test key is the boxes' one real input.
    expect(
      find.descendant(
        of: find.byType(BbOtpInput),
        matching: find.byKey(codeField),
      ),
      findsOneWidget,
    );
    // A screen reader still calls it what the old field's label did, and the
    // keyboard can still offer the code from the SMS.
    expect(find.bySemanticsLabel('OTP code'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byKey(codeField)).autofillHints,
      const <String>[AutofillHints.oneTimeCode],
    );

    await tester.enterText(find.byKey(codeField), '482');
    await tester.pump();
    expect(boxes(tester), <String>['4', '8', '2', '', '', '']);
    // Short of six digits nothing is sent; the manual button stays.
    expect(auth.verified, isEmpty);
    expect(find.byKey(verifyButton), findsOneWidget);
  });

  testWidgets('the sixth digit verifies the code, with no tap on Verify', (
    WidgetTester tester,
  ) async {
    await openCodeStep(tester);

    await tester.enterText(find.byKey(codeField), '12345');
    expect(auth.verified, isEmpty);
    await tester.enterText(find.byKey(codeField), '123456');
    expect(auth.verified, <String>['123456']);

    await settle(tester);
    expect(find.byKey(passwordField), findsOneWidget);
  });

  testWidgets('a tap on Verify as the sixth digit lands sends one verify', (
    WidgetTester tester,
  ) async {
    final Completer<PayerLoginResult> inFlight = Completer<PayerLoginResult>();
    auth.answers.add(() => inFlight.future);
    await openCodeStep(tester);

    await tester.enterText(find.byKey(codeField), '123456');
    // The tap lands before the frame that shows the button busy, so it still
    // reaches the button's handler.
    await tester.tap(find.byKey(verifyButton));
    await tester.pump();
    // Once the button shows busy, a tap does nothing either.
    await tester.tap(find.byKey(verifyButton));
    await tester.pump();
    expect(auth.verified, <String>['123456']);

    inFlight.complete(_session);
    await settle(tester);
    expect(auth.verified, <String>['123456']);
    expect(find.byKey(passwordField), findsOneWidget);
  });

  testWidgets('the sixth digit after a tap on Verify does not verify again', (
    WidgetTester tester,
  ) async {
    final Completer<PayerLoginResult> inFlight = Completer<PayerLoginResult>();
    auth.answers.add(() => inFlight.future);
    await openCodeStep(tester);

    await tester.enterText(find.byKey(codeField), '12345');
    await tester.tap(find.byKey(verifyButton));
    await tester.pump();
    expect(auth.verified, <String>['12345']);

    // The last digit lands while that verify is still out.
    await tester.enterText(find.byKey(codeField), '123456');
    await tester.pump();
    expect(auth.verified, <String>['12345']);

    inFlight.complete(_rejected);
    await settle(tester);
    expect(auth.verified, <String>['12345']);
  });

  testWidgets('a tap on the fading Verify after the code was accepted does '
      'not verify again', (WidgetTester tester) async {
    await openCodeStep(tester);

    // Verify answers at once (MOCK mode does too), so the code is accepted
    // before the next frame and the code step fades out with its button live.
    await tester.enterText(find.byKey(codeField), '123456');
    await tester.pump();
    expect(find.byKey(passwordField), findsOneWidget);
    expect(find.byKey(verifyButton), findsOneWidget);

    await tester.tap(find.byKey(verifyButton));
    await settle(tester);
    expect(auth.verified, <String>['123456']);
    expect(find.byKey(passwordField), findsOneWidget);
  });

  testWidgets('a rejected code empties the boxes and the same code retries', (
    WidgetTester tester,
  ) async {
    auth.answers.add(() async => _rejected);
    await openCodeStep(tester);

    await tester.enterText(find.byKey(codeField), '123456');
    await settle(tester);
    expect(auth.verified, <String>['123456']);
    // The screen's one error line (not repeated under the boxes), the boxes
    // empty, and still on the code step.
    expect(find.text('That code did not work. Try again.'), findsOneWidget);
    expect(boxes(tester), <String>['', '', '', '', '', '']);
    expect(find.byKey(passwordField), findsNothing);

    // Re-armed: the code entered again submits again.
    await tester.enterText(find.byKey(codeField), '123456');
    await settle(tester);
    expect(auth.verified, <String>['123456', '123456']);
    expect(find.byKey(passwordField), findsOneWidget);
  });

  testWidgets('a verify that could not complete empties the boxes too', (
    WidgetTester tester,
  ) async {
    const PayerApiException outage = PayerApiException(503);
    auth.answers.add(() => Future<PayerLoginResult>.error(outage));
    await openCodeStep(tester);

    await tester.enterText(find.byKey(codeField), '123456');
    await settle(tester);
    expect(find.text(authErrorFor(outage, otp: true)), findsOneWidget);
    expect(boxes(tester), <String>['', '', '', '', '', '']);

    // The same, correct code entered again retries.
    await tester.enterText(find.byKey(codeField), '123456');
    await settle(tester);
    expect(auth.verified, <String>['123456', '123456']);
    expect(find.byKey(passwordField), findsOneWidget);
  });

  testWidgets('the Verify button still submits by hand', (
    WidgetTester tester,
  ) async {
    await openCodeStep(tester);

    // Nothing entered: the screen asks for the code, as before.
    await tester.tap(find.byKey(verifyButton));
    await tester.pump();
    expect(find.text('Enter the code we sent you.'), findsOneWidget);
    expect(auth.verified, isEmpty);

    // Short of six digits, the button sends what was entered.
    await tester.enterText(find.byKey(codeField), '12345');
    await tester.tap(find.byKey(verifyButton));
    await settle(tester);
    expect(auth.verified, <String>['12345']);
  });
}

/// The session a good code mints.
const PayerLoginResult _session = PayerLoginResult(
  accessToken: 'verify-token',
  payerId: 'p1',
  role: 'employer',
  isNewPayer: true,
);

/// What verify returns for a wrong or expired code (a 4xx verdict on the
/// code): no token.
const PayerLoginResult _rejected = PayerLoginResult(
  accessToken: '',
  payerId: '',
  role: 'employer',
  isNewPayer: false,
);

/// Records every code sent to verify. A verify takes the next queued answer
/// from [answers]; with none queued it succeeds at once, as MOCK mode does.
class _VerifyAuthApi implements PayerAuthApi {
  final List<String> verified = <String>[];
  final List<Future<PayerLoginResult> Function()> answers =
      <Future<PayerLoginResult> Function()>[];

  @override
  Future<PayerLoginResult> loginVerify({
    String? email,
    String? phone,
    required String code,
  }) {
    verified.add(code);
    return answers.isEmpty
        ? Future<PayerLoginResult>.value(_session)
        : answers.removeAt(0)();
  }

  @override
  Future<void> signup({
    required String role,
    required String orgName,
    String? email,
    String? phone,
  }) async {}

  @override
  Future<void> loginRequest({String? email, String? phone}) async {}

  @override
  Future<void> setPassword({
    required String accessToken,
    required String password,
  }) async {}

  @override
  Future<PayerPasswordLoginOutcome> loginWithPassword({
    required String identifier,
    required String password,
    String? newPassword,
  }) async =>
      throw UnimplementedError();

  @override
  Future<String?> refresh() async => null;

  @override
  Future<void> logout() async {}
}
