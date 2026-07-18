import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/otp_verify_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/otp_verify_screen.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// #336 — the ported OTP surface: segmented cells + a server-driven resend
/// timer. The screen used to be a single centred TextField with
/// `letterSpacing: 12` faking cells, and had no resend control at all — a
/// worker whose SMS never arrived (the common case on a weak rural signal) had
/// no way forward but to kill the app and start the login over.
void main() {
  const String phone = '+919876543210';
  const Key resendKey = Key('otpResendButton');
  const Key codeKey = Key('otpCodeField');

  late MockAuthSessionManager manager;

  setUp(() async {
    manager = MockAuthSessionManager();
    // Swap the real graph for a cubit backed by a manager we control. English
    // locale so the asserted error copy is deterministic.
    //
    // `GetIt.reset()` is ASYNC — await it, or the reset lands AFTER the
    // registration below and silently wipes it, and every test then dies on
    // "OtpVerifyCubit is not registered" the moment the screen resolves
    // `locator<OtpVerifyCubit>()`. chat_profiling_screen_test.dart carries the
    // same warning for the same reason.
    await locator.reset();
    locator.registerFactory<OtpVerifyCubit>(
        () => OtpVerifyCubit(manager, locale: 'en'));
    // Default verify = FAILS. A success pushes Routes.consent through
    // go_router, which a bare MaterialApp has no router for — and nothing here
    // is about routing.
    when(() => manager.verifyOtp(any(), any()))
        .thenThrow(const AuthFailure(AuthErrorCode.otpInvalid));
  });

  tearDown(() => locator.reset());

  /// Pumps the screen. [resendIn] is the server's `resend_in_seconds` from the
  /// send that got the worker here.
  ///
  /// Never pumpAndSettle: the countdown is a periodic Timer, so settling would
  /// spin until the test timed out.
  Future<void> pumpScreen(WidgetTester tester, {Duration? resendIn}) async {
    await tester.pumpWidget(MaterialApp(
      home: OtpVerifyScreen(phone: phone, resendIn: resendIn),
    ));
    await tester.pump(); // let autofocus settle
  }

  /// Unmounts the tree. Called by tests that end with a live cooldown so the
  /// ticker is cancelled through dispose() — flutter_test fails a test that
  /// leaves a Timer pending, which is the leak this control could introduce.
  Future<void> unmount(WidgetTester tester) =>
      tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));

  TextButton resendButton(WidgetTester tester) =>
      tester.widget<TextButton>(find.byKey(resendKey));

  group('OTP cells', () {
    testWidgets('a whole code lands in the cells and reaches verify intact',
        (WidgetTester tester) async {
      await pumpScreen(tester);

      // enterText takes the same path a PASTE does: the platform hands the
      // field the complete string in one edit, not digit by digit.
      await tester.enterText(find.byKey(codeKey), '482913');
      await tester.pump();

      // Every digit is shown in its own cell...
      for (final String digit in <String>['4', '8', '2', '9', '1', '3']) {
        expect(find.text(digit), findsOneWidget);
      }
      // ...but there is still exactly ONE editable field behind them. Six real
      // fields would break SMS auto-read, iOS oneTimeCode autofill and paste,
      // all of which deliver the whole code to a single field.
      expect(find.byType(TextField), findsOneWidget);

      await tester.tap(find.text('Verify'));
      await tester.pump();

      verify(() => manager.verifyOtp(phone, '482913')).called(1);
    });

    testWidgets('a screen reader hears ONE labelled field, not six boxes',
        (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await pumpScreen(tester);
      await tester.enterText(find.byKey(codeKey), '4829');
      await tester.pump();

      // The merged node for the real field carries the spoken name.
      expect(
        tester.getSemantics(find.byKey(codeKey)).label,
        contains(kOtpFieldSemanticLabel),
      );
      // The cells are decoration (ExcludeSemantics): TalkBack cannot land on
      // four nameless digit nodes and leave the worker guessing.
      expect(find.bySemanticsLabel('4'), findsNothing);
      expect(find.bySemanticsLabel('8'), findsNothing);

      handle.dispose();
    });
  });

  group('resend cooldown', () {
    // Every resend is a real, billed Fast2SMS message — the countdown is a
    // spend control, not decoration.
    testWidgets('resend is disabled for the SERVER cooldown and says how long',
        (WidgetTester tester) async {
      await pumpScreen(tester, resendIn: const Duration(seconds: 45));

      expect(find.text('Naya code 45s mein'), findsOneWidget);
      expect(resendButton(tester).onPressed, isNull);

      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Naya code 44s mein'), findsOneWidget);

      // 45 seconds means 45 — still locked one tick before the end.
      for (int i = 0; i < 43; i++) {
        await tester.pump(const Duration(seconds: 1));
      }
      expect(find.text('Naya code 1s mein'), findsOneWidget);
      expect(resendButton(tester).onPressed, isNull);

      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Naya code bhejein'), findsOneWidget);
      expect(resendButton(tester).onPressed, isNotNull);
    });

    testWidgets('the countdown honours the FRESH server value on every resend',
        (WidgetTester tester) async {
      // The server may hand back a different window than last time (config
      // change, a tightened limit). 12s here proves the client is reading the
      // response and not counting down a constant of its own.
      when(() => manager.requestOtp(any())).thenAnswer(
        (_) async => const OtpRequestResult(resendIn: Duration(seconds: 12)),
      );

      await pumpScreen(tester, resendIn: const Duration(seconds: 2));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(seconds: 1));
      expect(resendButton(tester).onPressed, isNotNull);

      await tester.tap(find.byKey(resendKey));
      await tester.pump(); // sending
      await tester.pump(); // sent -> the listener restarts the countdown

      expect(find.text('Naya code 12s mein'), findsOneWidget);
      expect(resendButton(tester).onPressed, isNull);
      verify(() => manager.requestOtp(phone)).called(1);

      await unmount(tester);
    });

    testWidgets('a failed resend says WHY and leaves the worker a retry',
        (WidgetTester tester) async {
      when(() => manager.requestOtp(any()))
          .thenThrow(const AuthFailure(AuthErrorCode.otpRateLimited));

      await pumpScreen(tester); // no cooldown known -> control is armed
      await tester.tap(find.byKey(resendKey));
      await tester.pump(); // sending
      await tester.pump(); // failure -> listener fires the SnackBar

      // The honest reason, never a generic "check internet": rate-limited and
      // offline need different things from the worker.
      expect(
        find.text('OTP send limit reached. Please try again after some time.'),
        findsOneWidget,
      );
      // Nothing was sent, so no cooldown started — the control stays usable
      // instead of stranding them in front of a dead button.
      expect(resendButton(tester).onPressed, isNotNull);
    });

    testWidgets('the ticker dies with the screen — no tick after dispose',
        (WidgetTester tester) async {
      await pumpScreen(tester, resendIn: const Duration(seconds: 30));
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('Naya code 29s mein'), findsOneWidget);

      // The real case: the verify succeeds and the worker routes on to consent
      // with 20-odd seconds still on the clock. A surviving Timer would call
      // setState on a defunct State once a second.
      await unmount(tester);
      await tester.pump(const Duration(seconds: 5));

      expect(tester.takeException(), isNull);
      // flutter_test's own "A Timer is still pending after the widget tree was
      // disposed" check is the other half of this assertion — it fails the test
      // at teardown if dispose() ever stops cancelling the ticker.
    });
  });

  group('privacy', () {
    // CLAUDE.md §2 — state is what a BlocObserver or an error dump prints. A
    // one-time code sitting in it is a credential leaked into diagnostics.
    testWidgets('the entered code never reaches cubit state',
        (WidgetTester tester) async {
      late OtpVerifyCubit cubit;
      // Await the reset (see setUp): unawaited, the clear has not happened yet
      // and this re-registration throws "already registered".
      await locator.reset();
      locator.registerFactory<OtpVerifyCubit>(
          () => cubit = OtpVerifyCubit(manager, locale: 'en'));

      await pumpScreen(tester);
      await tester.enterText(find.byKey(codeKey), '482913');
      await tester.pump();
      await tester.tap(find.text('Verify'));
      await tester.pump(); // submitting
      await tester.pump(); // failure

      expect(cubit.state.props, isNot(contains('482913')));
      // toString() is the shape that actually reaches a log line.
      expect(cubit.state.toString(), isNot(contains('482913')));
      // Nor the phone: raw PII must not ride along in state either.
      expect(cubit.state.toString(), isNot(contains(phone)));
    });
  });
}
