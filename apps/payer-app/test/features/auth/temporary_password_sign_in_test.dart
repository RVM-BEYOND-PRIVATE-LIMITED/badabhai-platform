import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/auth/payer_auth_api.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_account_api.dart';
import 'package:payer_app/core/data/payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/widgets/bb_field_error.dart';
import 'package:payer_app/features/auth/presentation/widgets/auth_form_support.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2597 — sign-in with an admin-issued TEMPORARY password (backend #2563 /
/// PR #2628). The set-new-password step is the only way in: no session, no
/// stored bearer and no shell until a new password is accepted. Also the code
/// door's 409, the server's 400s inline, a 401 on the resend, and a new
/// password the server took although this device could not finish signing in.
const String _kId = 'owner@acme.in';
const String _kTemp = 'Temp9xQ2';
const String _kNew = 'MyOwnPass1';

const PayerLoginResult _kSession = PayerLoginResult(
  accessToken: 'tok-after-change',
  payerId: 'payer-1',
  role: 'employer',
  isNewPayer: false,
);

typedef _PasswordCall = ({
  String identifier,
  String password,
  String? newPassword,
});

/// Answers password sign-in from a script: each entry is a
/// [PayerPasswordLoginOutcome] to return or an error to throw.
class _ScriptedAuthApi implements PayerAuthApi {
  _ScriptedAuthApi(this.passwordAnswers, {this.verifyAnswer});

  final List<Object> passwordAnswers;
  final Object? verifyAnswer;
  final List<_PasswordCall> passwordCalls = <_PasswordCall>[];

  @override
  Future<PayerPasswordLoginOutcome> loginWithPassword({
    required String identifier,
    required String password,
    String? newPassword,
  }) async {
    passwordCalls.add(
        (identifier: identifier, password: password, newPassword: newPassword));
    final Object answer = passwordAnswers.removeAt(0);
    if (answer is PayerPasswordLoginOutcome) return answer;
    throw answer;
  }

  @override
  Future<PayerLoginResult> loginVerify({
    String? email,
    String? phone,
    required String code,
  }) async {
    final Object? answer = verifyAnswer;
    if (answer is PayerLoginResult) return answer;
    throw answer ?? const PayerApiException(500);
  }

  @override
  Future<void> loginRequest({String? email, String? phone}) async {}

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

/// Secure storage that remembers every value ever written, so a test can prove
/// no password was persisted.
class _RecordingStore implements SecureKeyValueStore {
  final Map<String, String> _values = <String, String>{};
  final List<String> written = <String>[];

  @override
  Future<String?> read(String key) async => _values[key];

  @override
  Future<void> write(String key, String value) async {
    written.add(value);
    _values[key] = value;
  }

  @override
  Future<void> delete(String key) async => _values.remove(key);
}

/// Secure storage whose next write can be made to fail, like a Keystore write
/// failure (PayerHttp._adoptRollingToken documents it as realistic).
class _FlakyWriteStore extends InMemoryKeyValueStore {
  bool failNextWrite = false;

  @override
  Future<void> write(String key, String value) async {
    if (failNextWrite) {
      failNextWrite = false;
      throw PlatformException(code: 'keystore_write_failed');
    }
    return super.write(key, value);
  }
}

/// `GET /payer/me` that undoes the session once, like PayerHttp's forced
/// re-login on an unrecoverable 401: the bearer is wiped, then it throws.
class _SessionUndoingAccountApi implements PayerAccountApi {
  int undoes = 1;

  @override
  Future<PayerMe> fetchMe() async {
    if (undoes > 0) {
      undoes--;
      await GetIt.instance<PayerTokenStore>().clear();
      throw const PayerApiException(401);
    }
    return const PayerMe(
      id: 'payer-1',
      role: 'employer',
      status: 'active',
      orgName: 'Acme Works',
      email: _kId,
      phoneLast4: '3210',
    );
  }

  @override
  Future<PayerMe> updateMe({String? orgName, String? phone}) async =>
      throw UnimplementedError();

  @override
  Future<void> logout() async {}
}

const Key _kIdentifier = Key('login_identifier');
const Key _kPassword = Key('login_password');
const Key _kLogin = Key('login_button');
const Key _kNewField = Key('new_password_field');
const Key _kConfirmField = Key('new_password_confirm');
const Key _kSubmit = Key('new_password_submit');
const Key _kBack = Key('new_password_back');

final Finder _step = find.text('Set a new password');
final Finder _shell = find.byType(AppShell);

Future<void> _boot(
  WidgetTester tester,
  PayerAuthApi auth, {
  SecureKeyValueStore? store,
  PayerAccountApi? accountApi,
}) async {
  // A 360×800dp budget handset.
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  setupLocator(
    apiClient: MockPayerApiClient(),
    authApi: auth,
    accountApi: accountApi,
    secureStore: store ?? InMemoryKeyValueStore(),
  );
  await GetIt.instance<PayerApiClient>().fetchCredits();
  await tester.pumpWidget(const PayerApp());
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, Key key) async {
  await tester.ensureVisible(find.byKey(key));
  // Let every field's error line (BbFieldError, #2595) finish animating its
  // height before the tap, so the button is where the tap lands.
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(key));
  await tester.pump();
  await tester.pumpAndSettle();
}

Future<void> _signIn(WidgetTester tester, String password,
    {String identifier = _kId}) async {
  await tester.enterText(find.byKey(_kIdentifier), identifier);
  await tester.enterText(find.byKey(_kPassword), password);
  await _tap(tester, _kLogin);
}

/// Types a whole code into the six code boxes: its last digit submits it
/// (#2595), so there is no Verify tap.
Future<void> _enterCode(WidgetTester tester, String code) async {
  await tester.enterText(find.byKey(const Key('otp_code_field')), code);
  await tester.pump();
  await tester.pumpAndSettle();
}

Future<void> _chooseNewPassword(WidgetTester tester, String password,
    {String? confirm}) async {
  await tester.enterText(find.byKey(_kNewField), password);
  await tester.enterText(find.byKey(_kConfirmField), confirm ?? password);
  await _tap(tester, _kSubmit);
}

String _textOf(WidgetTester tester, Key key) =>
    tester.widget<TextField>(find.byKey(key)).controller!.text;

void _expectLockedOut(WidgetTester tester) {
  expect(_shell, findsNothing);
  expect(GetIt.instance<AppSessionCubit>().state, isNull);
  expect(GetIt.instance<PayerTokenStore>().hasSession, isFalse);
}

/// The server took the new password but this device could not finish signing
/// in: back on sign-in and told so, the dead temporary password gone from
/// memory, and nothing stuck on a spinner.
void _expectNewPasswordSetButSignedOut(WidgetTester tester) {
  expect(_shell, findsNothing);
  expect(GetIt.instance<AppSessionCubit>().state, isNull);
  expect(_step, findsNothing);
  expect(
      find.text('Your new password is set. Sign in with it.'), findsOneWidget);
  expect(_textOf(tester, _kPassword), isEmpty);
  expect(_textOf(tester, _kIdentifier), _kId);
  expect(find.byType(CircularProgressIndicator), findsNothing);
  expect(tester.widget<ButtonStyleButton>(find.byKey(_kLogin)).enabled, isTrue);
}

/// What the app told the OS autofill service, in order: `true` commits (the
/// OS may offer to save the new password), `false` cancels.
List<bool> _autofillFinishes(WidgetTester tester) => tester.testTextInput.log
    .where((MethodCall c) => c.method == 'TextInput.finishAutofillContext')
    .map((MethodCall c) => c.arguments as bool)
    .toList();

void main() {
  setUp(() async => GetIt.instance.reset());

  testWidgets('a plain session (server without #2563) signs straight in',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth =
        _ScriptedAuthApi(<Object>[const PayerPasswordSignedIn(_kSession)]);
    await _boot(tester, auth);

    await _signIn(tester, 'Secret123');

    expect(_step, findsNothing);
    expect(_shell, findsOneWidget);
    expect(auth.passwordCalls.single.newPassword, isNull);
  });

  testWidgets('a temporary password opens the step — never the app',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth =
        _ScriptedAuthApi(<Object>[const PayerPasswordChangeRequired()]);
    await _boot(tester, auth);

    await _signIn(tester, _kTemp);

    expect(_step, findsOneWidget);
    expect(find.byKey(_kNewField), findsOneWidget);
    expect(find.byKey(_kPassword), findsNothing);
    _expectLockedOut(tester);
  });

  testWidgets('the step slides in and takes input while it does',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth =
        _ScriptedAuthApi(<Object>[const PayerPasswordChangeRequired()]);
    await _boot(tester, auth);
    await tester.enterText(find.byKey(_kIdentifier), _kId);
    await tester.enterText(find.byKey(_kPassword), _kTemp);
    await tester.tap(find.byKey(_kLogin));
    await tester.pump(); // the request answers
    await tester.pump(); // the step mounts

    double stepOpacity() => tester
        .widget<FadeTransition>(find
            .ancestor(of: _step, matching: find.byType(FadeTransition))
            .first)
        .opacity
        .value;
    expect(stepOpacity(), lessThan(1));

    // Motion never holds input back: type while it is still arriving.
    await tester.enterText(find.byKey(_kNewField), 'abc');
    await tester.pump(const Duration(milliseconds: 100));
    expect(stepOpacity(), inExclusiveRange(0, 1));
    expect(_textOf(tester, _kNewField), 'abc');

    await tester.pump(const Duration(milliseconds: 200));
    expect(stepOpacity(), 1);
  });

  testWidgets('the resend carries the new password; a real session opens it',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerPasswordSignedIn(_kSession),
    ]);
    await _boot(tester, auth);

    await _signIn(tester, _kTemp, identifier: '  $_kId ');
    await _chooseNewPassword(tester, _kNew);

    expect(auth.passwordCalls, hasLength(2));
    expect(auth.passwordCalls.last, (
      identifier: _kId,
      password: _kTemp,
      newPassword: _kNew,
    ));
    expect(_shell, findsOneWidget);
    final PayerTokenStore tokens = GetIt.instance<PayerTokenStore>();
    expect(tokens.accessToken, _kSession.accessToken);
    // The OS password manager may offer to save the accepted new password.
    expect(_autofillFinishes(tester).first, isTrue);
    expect(_autofillFinishes(tester).where((bool save) => save), hasLength(1));
  });

  testWidgets('the server 400 reason shows inline on the step',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerApiException(400,
          validationMessage:
              'Choose a new password - it cannot be the temporary one'),
      const PayerApiException(400,
          validationMessage:
              'Password must include at least one letter and one digit'),
      const PayerApiException(400),
    ]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);

    await _chooseNewPassword(tester, _kNew);
    expect(
      find.text('Choose a new password - it cannot be the temporary one.'),
      findsOneWidget,
    );
    expect(_step, findsOneWidget);
    _expectLockedOut(tester);

    // A policy message from the server (the authority) is shown as-is.
    await _tap(tester, _kSubmit);
    expect(
      find.text('Password must include at least one letter and one digit.'),
      findsOneWidget,
    );

    // A 400 with no reason falls back to the generic line, still inline.
    await _tap(tester, _kSubmit);
    expect(
        find.text('Please check the details and try again.'), findsOneWidget);
    // The inline error is drawn by BbFieldError under the field (#2595).
    expect(
      find.descendant(
        of: find.byType(BbFieldError),
        matching: find.text('Please check the details and try again.'),
      ),
      findsOneWidget,
    );
    _expectLockedOut(tester);
  });

  testWidgets('editing the new password clears a stale server reason',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerApiException(400, validationMessage: 'Password too common'),
    ]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);
    await _chooseNewPassword(tester, _kNew);
    expect(find.text('Password too common.'), findsOneWidget);

    await tester.enterText(find.byKey(_kNewField), 'Another1x');
    // The error line fades out (BbFieldError, #2595) before it is gone.
    await tester.pumpAndSettle();
    expect(find.text('Password too common.'), findsNothing);
  });

  testWidgets('a 401 on the resend returns to sign-in with the neutral error',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerApiException(401),
    ]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);
    await _chooseNewPassword(tester, _kNew);

    expect(_step, findsNothing);
    expect(find.byKey(_kPassword), findsOneWidget);
    expect(
      find.text('Wrong email, phone or company name, or password. '
          'If you already set a new password, sign in with it.'),
      findsOneWidget,
    );
    // The temporary password is gone from the form; the identifier stays.
    expect(_textOf(tester, _kPassword), isEmpty);
    expect(_textOf(tester, _kIdentifier), _kId);
    _expectLockedOut(tester);
  });

  testWidgets('a 429 keeps the step with an honest line; a retry gets in',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerApiException(429),
      const PayerPasswordSignedIn(_kSession),
    ]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);
    await _chooseNewPassword(tester, _kNew);

    expect(_step, findsOneWidget);
    expect(find.text('Too many attempts. Please wait a minute and try again.'),
        findsOneWidget);
    _expectLockedOut(tester);

    await _tap(tester, _kSubmit);
    expect(_shell, findsOneWidget);
    expect(auth.passwordCalls.last.newPassword, _kNew);
  });

  testWidgets('a lost connection keeps the step (and what was typed)',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      Exception('connection reset'),
    ]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);
    await _chooseNewPassword(tester, _kNew);

    expect(_step, findsOneWidget);
    expect(
        find.text(
            'Could not reach the server. Check your connection and retry.'),
        findsOneWidget);
    expect(_textOf(tester, _kNewField), _kNew);
    _expectLockedOut(tester);
  });

  testWidgets('asked for a change again after sending one: no session',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerPasswordChangeRequired(),
    ]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);
    await _chooseNewPassword(tester, _kNew);

    expect(_step, findsOneWidget);
    expect(
      find.text(
          "We couldn't save your new password. Please try again in a moment."),
      findsOneWidget,
    );
    _expectLockedOut(tester);
  });

  testWidgets('Back to sign in abandons the change and drops the password',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerPasswordChangeRequired(),
    ]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);
    await tester.enterText(find.byKey(_kNewField), _kNew);

    await _tap(tester, _kBack);

    expect(_step, findsNothing);
    expect(_textOf(tester, _kPassword), isEmpty);
    expect(_textOf(tester, _kIdentifier), _kId);
    _expectLockedOut(tester);
    // Never offered for saving: the server did not accept it.
    expect(_autofillFinishes(tester), <bool>[false]);

    // Signing in again with the temporary password brings the step back,
    // with nothing carried over from the abandoned attempt.
    await tester.enterText(find.byKey(_kPassword), _kTemp);
    await _tap(tester, _kLogin);
    expect(_step, findsOneWidget);
    expect(_textOf(tester, _kNewField), isEmpty);
  });

  testWidgets('system Back on the step returns to sign-in, not out',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth =
        _ScriptedAuthApi(<Object>[const PayerPasswordChangeRequired()]);
    await _boot(tester, auth);
    await _signIn(tester, _kTemp);
    expect(_step, findsOneWidget);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();

    expect(_step, findsNothing);
    expect(find.byKey(_kPassword), findsOneWidget);
    expect(_textOf(tester, _kPassword), isEmpty);
    _expectLockedOut(tester);
  });

  testWidgets(
      'new password set, but the session cannot be stored: back to sign-in, '
      'told so', (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerPasswordSignedIn(_kSession),
      const PayerPasswordSignedIn(_kSession),
    ]);
    final _FlakyWriteStore store = _FlakyWriteStore();
    await _boot(tester, auth, store: store);
    await _signIn(tester, _kTemp);

    store.failNextWrite = true;
    await _chooseNewPassword(tester, _kNew);

    expect(auth.passwordCalls[1].newPassword, _kNew);
    _expectNewPasswordSetButSignedOut(tester);

    // The new password now signs straight in.
    await tester.enterText(find.byKey(_kPassword), _kNew);
    await _tap(tester, _kLogin);
    expect(auth.passwordCalls.last,
        (identifier: _kId, password: _kNew, newPassword: null));
    expect(_shell, findsOneWidget);
  });

  testWidgets(
      'new password set, but the session is undone while signing in: back to '
      'sign-in, told so', (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(<Object>[
      const PayerPasswordChangeRequired(),
      const PayerPasswordSignedIn(_kSession),
      const PayerPasswordSignedIn(_kSession),
    ]);
    await _boot(tester, auth, accountApi: _SessionUndoingAccountApi());
    await _signIn(tester, _kTemp);

    await _chooseNewPassword(tester, _kNew);

    expect(auth.passwordCalls[1].newPassword, _kNew);
    _expectNewPasswordSetButSignedOut(tester);
    _expectLockedOut(tester);

    // The new password now signs straight in.
    await tester.enterText(find.byKey(_kPassword), _kNew);
    await _tap(tester, _kLogin);
    expect(auth.passwordCalls.last,
        (identifier: _kId, password: _kNew, newPassword: null));
    expect(_shell, findsOneWidget);
  });

  testWidgets('code sign-in 409 → told to use the temporary password',
      (WidgetTester tester) async {
    final _ScriptedAuthApi auth = _ScriptedAuthApi(
      <Object>[],
      verifyAnswer: const PayerPasswordChangeRequiredException(),
    );
    await _boot(tester, auth);

    await _tap(tester, const Key('otp_login_open'));
    await tester.enterText(find.byKey(const Key('otp_contact_field')), _kId);
    await _tap(tester, const Key('otp_get_code'));
    await _enterCode(tester, '123456');

    // Back in password mode, with the contact they proved already filled in.
    expect(find.byKey(_kPassword), findsOneWidget);
    expect(find.byKey(const Key('otp_code_field')), findsNothing);
    expect(find.text(kTemporaryPasswordSignInCopy), findsOneWidget);
    expect(_textOf(tester, _kIdentifier), _kId);
    _expectLockedOut(tester);
  });

  // ---- Acceptance (#2597): no way into the app until a new password is set --
  testWidgets(
      'ACCEPTANCE: a temporary-password holder cannot reach the app until '
      'they set a new one', (WidgetTester tester) async {
    final MockPayerAuthApi auth = MockPayerAuthApi()
      ..issueTemporaryPassword(
        temporaryPassword: _kTemp,
        email: _kId,
        orgName: 'Acme Works',
      );
    final _RecordingStore store = _RecordingStore();
    await _boot(tester, auth, store: store);

    // 1. The temporary password alone opens the step, not the app.
    await _signIn(tester, _kTemp);
    expect(_step, findsOneWidget);
    _expectLockedOut(tester);

    // 2. Walking away and coming back changes nothing.
    await _tap(tester, _kBack);
    _expectLockedOut(tester);

    // 3. The code door is shut for this account too.
    await _tap(tester, const Key('otp_login_open'));
    await tester.enterText(find.byKey(const Key('otp_contact_field')), _kId);
    await _tap(tester, const Key('otp_get_code'));
    await _enterCode(tester, '123456');
    expect(find.text(kTemporaryPasswordSignInCopy), findsOneWidget);
    _expectLockedOut(tester);

    // 4. Back on the step, nothing weak, reused or mismatched gets through.
    await tester.enterText(find.byKey(_kPassword), _kTemp);
    await _tap(tester, _kLogin);
    expect(_step, findsOneWidget);
    await _chooseNewPassword(tester, 'short');
    expect(find.text('Use at least 8 characters.'), findsOneWidget);
    await _chooseNewPassword(tester, _kTemp);
    expect(
      find.text('Choose a different password. It cannot be the temporary one.'),
      findsOneWidget,
    );
    await _chooseNewPassword(tester, _kNew, confirm: 'MyOwnPass2');
    expect(find.text('Passwords do not match.'), findsOneWidget);
    _expectLockedOut(tester);

    // 5. A valid new password is the way in.
    await _chooseNewPassword(tester, _kNew);
    expect(_shell, findsOneWidget);
    expect(GetIt.instance<AppSessionCubit>().state, isNotNull);
    expect(GetIt.instance<PayerTokenStore>().hasSession, isTrue);

    // Neither password was ever written to device storage.
    expect(store.written, isNotEmpty);
    for (final String value in store.written) {
      expect(value.contains(_kTemp), isFalse);
      expect(value.contains(_kNew), isFalse);
    }

    // 6. From now on the new password signs straight in; the old one is dead.
    await GetIt.instance<AppSessionCubit>().signOut();
    await tester.pumpAndSettle();
    await _signIn(tester, _kTemp);
    expect(find.text('Wrong email, phone or company name, or password.'),
        findsOneWidget);
    expect(_step, findsNothing);
    await tester.enterText(find.byKey(_kPassword), _kNew);
    await _tap(tester, _kLogin);
    expect(_step, findsNothing);
    expect(_shell, findsOneWidget);
  });
}
