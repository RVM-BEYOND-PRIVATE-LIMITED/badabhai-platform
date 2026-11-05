import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/auth/payer_auth_api.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/widgets/bb_otp_input.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2595 (M7) — the login code step is the six-box [BbOtpInput]. Its last
/// digit submits the code through the same verify as "Verify & continue"
/// (which stays), one verify at a time; a failed verify empties the boxes so
/// the next code — the same one typed again included — submits on its own.
const String _kContact = 'owner@acme.in';

const PayerLoginResult _kSession = PayerLoginResult(
  accessToken: 'tok-otp',
  payerId: 'payer-1',
  role: 'employer',
  isNewPayer: false,
);

/// A wrong or expired code: the verify answers no token (#347).
const PayerLoginResult _kRejected = PayerLoginResult(
  accessToken: '',
  payerId: '',
  role: 'employer',
  isNewPayer: false,
);

typedef _VerifyCall = ({String? email, String? phone, String code});

/// Code sign-in from a script: each verify takes the next answer — a
/// [PayerLoginResult] to return, a [Completer] the test completes later (a
/// verify still in flight), or an error to throw.
class _ScriptedVerifyApi implements PayerAuthApi {
  _ScriptedVerifyApi(this.answers);

  final List<Object> answers;
  final List<_VerifyCall> verifyCalls = <_VerifyCall>[];

  @override
  Future<PayerLoginResult> loginVerify({
    String? email,
    String? phone,
    required String code,
  }) async {
    verifyCalls.add((email: email, phone: phone, code: code));
    final Object answer = answers.removeAt(0);
    if (answer is Completer<PayerLoginResult>) return answer.future;
    if (answer is PayerLoginResult) return answer;
    throw answer;
  }

  @override
  Future<void> loginRequest({String? email, String? phone}) async {}

  @override
  Future<PayerPasswordLoginOutcome> loginWithPassword({
    required String identifier,
    required String password,
    String? newPassword,
  }) =>
      throw UnimplementedError('code sign-in only');

  @override
  Future<void> signup({
    required String role,
    required String orgName,
    String? email,
    String? phone,
  }) async {}

  @override
  Future<void> setPassword({
    required String accessToken,
    required String password,
  }) async {}

  @override
  Future<String?> refresh() async => null;

  @override
  Future<void> logout() async {}
}

const Key _kCodeField = Key('otp_code_field');
const Key _kVerify = Key('otp_verify');
const Key _kContactField = Key('otp_contact_field');

final Finder _shell = find.byType(AppShell);

Future<void> _boot(WidgetTester tester, PayerAuthApi auth) async {
  // A 360×800dp budget handset.
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  setupLocator(
    apiClient: MockPayerApiClient(),
    authApi: auth,
    secureStore: InMemoryKeyValueStore(),
  );
  await GetIt.instance<PayerApiClient>().fetchCredits();
  await tester.pumpWidget(const PayerApp());
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, Key key) async {
  await tester.ensureVisible(find.byKey(key));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(key));
  await tester.pump();
  await tester.pumpAndSettle();
}

/// Password sign-in → "Login with OTP instead" → a contact → the code step.
Future<void> _openCodeStep(WidgetTester tester,
    {String contact = _kContact}) async {
  await _tap(tester, const Key('otp_login_open'));
  await tester.enterText(find.byKey(_kContactField), contact);
  await _tap(tester, const Key('otp_get_code'));
}

/// Types [code] into the boxes and lets whatever it starts finish.
Future<void> _enterCode(WidgetTester tester, String code) async {
  await tester.enterText(find.byKey(_kCodeField), code);
  await tester.pump();
  await tester.pumpAndSettle();
}

String _boxesText(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(_kCodeField)).controller!.text;

void main() {
  setUp(() async => GetIt.instance.reset());

  testWidgets('the code step is six boxes the SMS code can fill',
      (WidgetTester tester) async {
    await _boot(tester, _ScriptedVerifyApi(<Object>[]));
    await _openCodeStep(tester);

    expect(find.byType(BbOtpInput), findsOneWidget);
    for (int i = 0; i < 6; i++) {
      expect(find.byKey(BbOtpInput.boxKey(i)), findsOneWidget);
    }
    expect(
      tester.widget<TextField>(find.byKey(_kCodeField)).autofillHints,
      const <String>[AutofillHints.oneTimeCode],
    );
    // A screen reader still calls it what the old field's label said.
    expect(
      tester.getSemantics(find.byKey(_kCodeField)),
      containsSemantics(label: 'OTP code', isTextField: true),
    );
    // The manual button and the way back stay.
    expect(find.byKey(_kVerify), findsOneWidget);
    expect(find.byKey(const Key('otp_change_contact')), findsOneWidget);
  });

  testWidgets('the sixth digit signs in on its own — no Verify tap',
      (WidgetTester tester) async {
    final _ScriptedVerifyApi auth = _ScriptedVerifyApi(<Object>[_kSession]);
    await _boot(tester, auth);
    await _openCodeStep(tester);

    await _enterCode(tester, '12345');
    expect(auth.verifyCalls, isEmpty);

    await _enterCode(tester, '123456');

    // The same verify the button runs: this contact, this code.
    expect(auth.verifyCalls, <_VerifyCall>[
      (email: _kContact, phone: null, code: '123456'),
    ]);
    expect(_shell, findsOneWidget);
    expect(
        GetIt.instance<PayerTokenStore>().accessToken, _kSession.accessToken);
  });

  testWidgets(
      'one verify at a time: a Verify tap or a new code while it runs sends '
      'nothing more', (WidgetTester tester) async {
    final Completer<PayerLoginResult> verify = Completer<PayerLoginResult>();
    final _ScriptedVerifyApi auth = _ScriptedVerifyApi(<Object>[verify]);
    await _boot(tester, auth);
    await _openCodeStep(tester);
    await tester.ensureVisible(find.byKey(_kVerify));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(_kCodeField), '123456');
    expect(auth.verifyCalls, hasLength(1));

    // A tap that lands before the screen has redrawn as busy…
    await tester.tap(find.byKey(_kVerify));
    // …one on the spinner…
    await tester.pump();
    await tester.tap(find.byKey(_kVerify));
    // …and a different code pasted over the first while it is still out.
    await tester.enterText(find.byKey(_kCodeField), '654321');
    await tester.pump();
    expect(auth.verifyCalls, hasLength(1));

    verify.complete(_kSession);
    await tester.pumpAndSettle();
    expect(auth.verifyCalls.single.code, '123456');
    expect(_shell, findsOneWidget);
  });

  testWidgets('a wrong code empties the boxes for the next one',
      (WidgetTester tester) async {
    final _ScriptedVerifyApi auth =
        _ScriptedVerifyApi(<Object>[_kRejected, _kSession]);
    await _boot(tester, auth);
    await _openCodeStep(tester);

    await _enterCode(tester, '111111');
    expect(find.text('That code did not work. Try again.'), findsOneWidget);
    expect(_boxesText(tester), isEmpty);
    expect(_shell, findsNothing);
    expect(GetIt.instance<PayerTokenStore>().hasSession, isFalse);

    await _enterCode(tester, '123456');
    expect(auth.verifyCalls.map((_VerifyCall c) => c.code),
        <String>['111111', '123456']);
    expect(_shell, findsOneWidget);
  });

  testWidgets(
      'a verify that fails empties the boxes; the same code typed again '
      'submits again', (WidgetTester tester) async {
    final _ScriptedVerifyApi auth = _ScriptedVerifyApi(<Object>[
      Exception('connection reset'),
      const PayerApiException(429),
      _kSession,
    ]);
    await _boot(tester, auth);
    await _openCodeStep(tester);

    await _enterCode(tester, '123456');
    expect(
      find.text('Could not reach the server. Check your connection and retry.'),
      findsOneWidget,
    );
    expect(_boxesText(tester), isEmpty);

    await _enterCode(tester, '123456');
    expect(find.text('Too many attempts. Please wait a minute and try again.'),
        findsOneWidget);
    expect(_boxesText(tester), isEmpty);
    expect(_shell, findsNothing);

    await _enterCode(tester, '123456');
    expect(auth.verifyCalls.map((_VerifyCall c) => c.code),
        <String>['123456', '123456', '123456']);
    expect(_shell, findsOneWidget);
  });

  testWidgets('Verify & continue still verifies by hand',
      (WidgetTester tester) async {
    final _ScriptedVerifyApi auth = _ScriptedVerifyApi(<Object>[_kRejected]);
    await _boot(tester, auth);
    await _openCodeStep(tester);

    // Nothing typed: told what to do, nothing sent.
    await _tap(tester, _kVerify);
    expect(find.text('Enter the code we sent you.'), findsOneWidget);
    expect(auth.verifyCalls, isEmpty);

    // A short code never submits itself; the button sends what is there and
    // the server judges it.
    await _enterCode(tester, '12345');
    expect(auth.verifyCalls, isEmpty);
    await _tap(tester, _kVerify);
    expect(auth.verifyCalls, <_VerifyCall>[
      (email: _kContact, phone: null, code: '12345'),
    ]);
    expect(find.text('That code did not work. Try again.'), findsOneWidget);
    expect(_boxesText(tester), isEmpty);
  });

  testWidgets('the code for a changed contact starts in empty boxes',
      (WidgetTester tester) async {
    final _ScriptedVerifyApi auth = _ScriptedVerifyApi(<Object>[_kSession]);
    await _boot(tester, auth);
    await _openCodeStep(tester);
    await _enterCode(tester, '427');

    await _tap(tester, const Key('otp_change_contact'));
    expect(find.byKey(_kCodeField), findsNothing);
    await tester.enterText(find.byKey(_kContactField), 'ops@acme.in');
    await _tap(tester, const Key('otp_get_code'));

    // Nothing of the last code is left to mix into the new one.
    expect(_boxesText(tester), isEmpty);
    await _enterCode(tester, '815302');
    expect(auth.verifyCalls, <_VerifyCall>[
      (email: 'ops@acme.in', phone: null, code: '815302'),
    ]);
    expect(_shell, findsOneWidget);
  });
}
