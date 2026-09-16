import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/auth/phone_format.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_docked_bar.dart';
import 'package:badabhai_worker_app/core/widgets/kit/otp_code_field.dart';
import 'package:badabhai_worker_app/core/widgets/kit/phone_number_field.dart';
import 'package:badabhai_worker_app/core/widgets/kit/secure_note.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/primary_action_button.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/otp_verify_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/set_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/otp_verify_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/phone_login_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/set_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';
import 'package:badabhai_worker_app/features/splash/presentation/splash_screen.dart';

import '../../support/kit_matrix.dart';

class _MockManager extends Mock implements AuthSessionManager {}

class _MockConsentRepo extends Mock implements ConsentRepository {}

/// The onboarding screens are drawn on one 390x844 artboard. These five run on
/// EVERY device a worker owns, so each is pumped across the matrix
/// (320x568 → tablet → landscape, at 100% / 150% / 200% system font), then
/// again with the keyboard up on the smallest phone, then measured on a tablet
/// and checked against Android's touch floor.
///
/// PASS is two things, both of which have regressed before: nothing throws (a
/// `RenderFlex` overflow surfaces through `takeException`), and the primary
/// action is still reachable — a CTA that exists but sits forever below the
/// fold is not a pass.
void main() {
  setUpAll(() {
    // A focused OTP / PIN box paints a blinking caret; a perpetual blink keeps
    // a frame scheduled forever, so hold it still.
    BbPinView.debugDeterministicCaret = true;
    registerFallbackValue(const <String>[]);
  });
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  setUp(() async {
    // `GetIt.reset()` is ASYNC — await it, or the reset lands after the
    // registrations below and wipes them.
    await locator.reset();
    final _MockManager manager = _MockManager();
    when(
      () => manager.requestOtp(any()),
    ).thenThrow(const AuthFailure(AuthErrorCode.network));
    when(
      () => manager.verifyOtp(any(), any()),
    ).thenThrow(const AuthFailure(AuthErrorCode.otpInvalid));
    locator.registerSingleton<AuthSessionManager>(manager);
    locator.registerFactory<PhoneLoginCubit>(
      () => PhoneLoginCubit(manager, locale: 'en'),
    );
    locator.registerFactory<OtpVerifyCubit>(
      () => OtpVerifyCubit(manager, locale: 'en'),
    );
    locator.registerFactory<SetPinCubit>(() => SetPinCubit(manager));
    final _MockConsentRepo repo = _MockConsentRepo();
    when(
      () => repo.acceptConsent(purposes: any(named: 'purposes')),
    ).thenAnswer((_) async {});
    locator.registerFactory<ConsentCubit>(() => ConsentCubit(repo));
  });

  tearDown(() => locator.reset());

  Widget phoneLogin() => const PhoneLoginScreen();
  Widget otpVerify() => const OtpVerifyScreen(phone: '+919876543210');
  Widget setPin() => const SetPinScreen();
  Widget consent() => const ConsentScreen();

  // ---- 1. the matrix -------------------------------------------------------

  group('splash', () {
    kitMatrixTest(
      'no overflow, CTA present',
      () => const SplashScreen(),
      primary: () => find.text('Get started'),
    );
  });

  group('phone login', () {
    kitMatrixTest(
      'no overflow, CTA present',
      phoneLogin,
      primary: () => find.text('Send OTP'),
    );
  });

  group('otp verify', () {
    kitMatrixTest(
      'no overflow, CTA present',
      otpVerify,
      primary: () => find.text('Verify Code'),
    );
  });

  group('set pin', () {
    kitMatrixTest(
      'no overflow, CTA present',
      setPin,
      primary: () => find.text('Save PIN & Continue'),
    );
  });

  group('consent', () {
    kitMatrixTest(
      'no overflow, CTA present',
      consent,
      primary: () => find.text('Aage Badhein'),
    );
  });

  // ---- 2. the keyboard, on the smallest phone, at the largest font ---------
  //
  // The state that actually breaks an auth screen: 320x568, 200% font AND the
  // keyboard up, which is how a worker types their number. The header collapses
  // itself here (`ShiftBlueHeader.autoCompact`) and the body must still scroll
  // to both the field and the CTA.

  group('keyboard up at 320x568 @2.0', () {
    const double keyboard = 260;

    Future<void> pumpWithKeyboard(WidgetTester tester, Widget screen) async {
      setKitSurface(tester, const Size(320, 568), keyboard: keyboard);
      await tester.pumpWidget(kitTestApp(screen, textScale: 2.0));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
    }

    Future<void> expectReachable(WidgetTester tester, Finder target) async {
      if (target.evaluate().isEmpty) {
        await tester.scrollUntilVisible(
          target,
          120,
          scrollable: find.byType(Scrollable).first,
        );
      }
      expect(target, findsWidgets);
    }

    testWidgets('phone login keeps the field and the CTA reachable', (
      WidgetTester tester,
    ) async {
      await pumpWithKeyboard(tester, phoneLogin());

      expect(tester.takeException(), isNull);
      await expectReachable(tester, find.byType(PhoneNumberField));
      await expectReachable(tester, find.text('Send OTP'));
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('otp verify keeps the cells and the CTA reachable', (
      WidgetTester tester,
    ) async {
      await pumpWithKeyboard(tester, otpVerify());

      expect(tester.takeException(), isNull);
      await expectReachable(tester, find.byType(OtpCodeField));
      await expectReachable(tester, find.text('Verify Code'));
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('set pin keeps both rows and the CTA reachable', (
      WidgetTester tester,
    ) async {
      await pumpWithKeyboard(tester, setPin());

      expect(tester.takeException(), isNull);
      expect(find.byType(BbPinView), findsNWidgets(2));
      await expectReachable(tester, find.text('Save PIN & Continue'));
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('consent keeps the tick and the docked CTA reachable', (
      WidgetTester tester,
    ) async {
      await pumpWithKeyboard(tester, consent());

      expect(tester.takeException(), isNull);
      // The CTA is DOCKED, so the keyboard never buries it.
      expect(find.text('Aage Badhein'), findsOneWidget);
      await expectReachable(tester, find.byType(Checkbox));
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  // ---- 3. the tablet cap ---------------------------------------------------

  group('768x1024 caps the form column at 440 (R13)', () {
    Future<void> pumpTablet(WidgetTester tester, Widget screen) async {
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(kitTestApp(screen));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
    }

    testWidgets('phone login', (WidgetTester tester) async {
      await pumpTablet(tester, phoneLogin());

      // The field and the CTA live in the same capped column, so measuring the
      // CTA measures the column.
      expect(
        widthOf(tester, find.byType(PrimaryActionButton)),
        lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
      );
      expect(
        widthOf(tester, find.byType(PhoneNumberField)),
        lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
      );
    });

    testWidgets('otp verify', (WidgetTester tester) async {
      await pumpTablet(tester, otpVerify());

      expect(
        widthOf(tester, find.byType(OtpCodeField)),
        lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
      );
    });

    testWidgets('set pin', (WidgetTester tester) async {
      await pumpTablet(tester, setPin());

      expect(
        widthOf(tester, find.byKey(const Key('setPinSaveButton'))),
        lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
      );
    });

    testWidgets('consent docks a capped bar, not a 768-wide button', (
      WidgetTester tester,
    ) async {
      await pumpTablet(tester, consent());

      expect(
        widthOf(tester, find.byType(PrimaryActionButton)),
        lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
      );
      // The BAR itself stays full-bleed; only its content column caps.
      expect(widthOf(tester, find.byType(KitDockedBar)), 768);
    });
  });

  // ---- 4. Android's touch floor -------------------------------------------

  group('tap targets at 360x640 @1.0', () {
    Future<void> pumpHandset(WidgetTester tester, Widget screen) async {
      setKitSurface(tester, const Size(360, 640));
      await tester.pumpWidget(kitTestApp(screen));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
    }

    testWidgets('otp verify', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await pumpHandset(tester, otpVerify());
      await expectKitTapTargets(tester);
      handle.dispose();
    });

    testWidgets('set pin', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await pumpHandset(tester, setPin());
      await expectKitTapTargets(tester);
      handle.dispose();
    });

    testWidgets('consent', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await pumpHandset(tester, consent());
      await expectKitTapTargets(tester);
      handle.dispose();
    });

    testWidgets(
      'phone login — the whole 54dp box takes the tap, not just the text run',
      (WidgetTester tester) async {
        // The guideline is not run here: the editable inside the box is a
        // COLLAPSED input (spec §3.2 draws the +91, the divider and the digits
        // as one 54dp box), so its semantics node is the text run's height even
        // though a tap anywhere in the box focuses it. The thing that matters
        // to a thumb is asserted directly instead.
        await pumpHandset(tester, phoneLogin());

        final Size box = tester.getSize(find.byType(PhoneNumberField));
        expect(box.height, 54);
        expect(
          tester.getSize(
            find
                .descendant(
                  of: find.byType(PhoneNumberField),
                  matching: find.byType(GestureDetector),
                )
                .first,
          ),
          box,
        );

        // And it really does focus from the far edge of the box.
        await tester.tapAt(
          tester.getTopLeft(find.byType(PhoneNumberField)) +
              const Offset(4, 27),
        );
        await tester.pump();
        expect(
          tester.widget<TextField>(find.byType(TextField)).focusNode!.hasFocus,
          isTrue,
        );
      },
    );
  });

  // ---- 5. the spec's own values -------------------------------------------

  group('spec values', () {
    testWidgets('phone login draws the kit field: 54dp, +91, mono hint', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(phoneLogin()));
      await tester.pump();

      expect(find.byType(PhoneNumberField), findsOneWidget);
      expect(tester.getSize(find.byType(PhoneNumberField)).height, 54);
      expect(find.text('+91'), findsOneWidget);
      expect(find.text('XXXXXXXXXX'), findsOneWidget);
      expect(find.text('MOBILE NUMBER'), findsOneWidget);
    });

    testWidgets('otp draws six 48x54 cells over ONE field, ringed NAVY', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(otpVerify()));
      await tester.pump();

      expect(find.byType(OtpCodeField), findsOneWidget);
      // The CELLS, not every Container under the field: the active cell also
      // holds the caret, which is itself a (much smaller) Container.
      final Finder cells = find.descendant(
        of: find.byType(OtpCodeField),
        matching: find.byWidgetPredicate(
          (Widget w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration! as BoxDecoration).borderRadius ==
                  BorderRadius.circular(OnboardingRadii.otpBox),
        ),
      );
      expect(cells, findsNWidgets(6));
      expect(tester.getSize(cells.first), const Size(48, 54));

      // Six real fields would break SMS auto-read, paste and TalkBack.
      expect(find.byType(TextField), findsOneWidget);

      // The cell being typed into rings NAVY at 1.8 (D8). It used to ring
      // safety yellow, which in v3 means SELECTED — an input never is.
      final BoxDecoration active =
          tester.widget<Container>(cells.first).decoration! as BoxDecoration;
      expect(active.border!.top.color, OnboardingColors.shiftBlue);
      expect(active.border!.top.width, 1.8);
      expect(active.border!.top.color, isNot(OnboardingColors.borderActive));

      // The screen still supplies the PIN rows' blinking caret.
      expect(find.byKey(kOtpCaretKey), findsOneWidget);

      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('the PIN row being typed into rings NAVY, never yellow', (
      WidgetTester tester,
    ) async {
      // The constant every PIN surface reads (set-PIN, forgot-PIN, unlock).
      expect(BbPinSlotStyle.shiftBlue.borderActive, OnboardingColors.shiftBlue);
      expect(
        BbPinSlotStyle.shiftBlue.borderActive,
        isNot(OnboardingColors.borderActive),
      );
      expect(BbPinSlotStyle.shiftBlue.activeBorderWidth, 1.8);

      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(setPin()));
      await tester.pump();

      // The first row holds focus on mount, so its first slot is the live one.
      final BoxDecoration slot =
          tester
                  .widget<AnimatedContainer>(
                    find
                        .descendant(
                          of: find.byType(BbPinView).first,
                          matching: find.byType(AnimatedContainer),
                        )
                        .first,
                  )
                  .decoration!
              as BoxDecoration;
      expect(slot.border!.top.color, OnboardingColors.shiftBlue);
    });

    testWidgets('set pin keeps the security note, drawn by the kit widget', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(setPin()));
      await tester.pump();

      expect(find.byType(SecureNote), findsOneWidget);
      // Same words as before, and a real glyph rather than an emoji.
      expect(find.text('100% Safe & Secure • No agent fees'), findsOneWidget);
      expect(find.byIcon(Icons.shield_outlined), findsOneWidget);
    });

    testWidgets('consent docks its CTA and lets the THEME draw the tick', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(consent()));
      await tester.pump();

      expect(find.byType(KitDockedBar), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(KitDockedBar),
          matching: find.text('Aage Badhein'),
        ),
        findsOneWidget,
      );

      // The strict guideline's checkbox — navy fill, yellow border, yellow
      // tick — lives in the app theme. A local `side` / `fillColor` override is
      // how this one quietly wore a grey border, so it must stay absent.
      final Checkbox tick = tester.widget<Checkbox>(find.byType(Checkbox));
      expect(tick.side, isNull);
      expect(tick.fillColor, isNull);
      expect(tick.activeColor, isNull);

      final CheckboxThemeData theme = Theme.of(
        tester.element(find.byType(Checkbox)),
      ).checkboxTheme;
      expect(
        theme.fillColor!.resolve(<WidgetState>{WidgetState.selected}),
        OnboardingColors.shiftBlue,
      );
      expect(
        theme.checkColor!.resolve(<WidgetState>{WidgetState.selected}),
        OnboardingColors.safetyYellow,
      );
      expect(
        WidgetStateProperty.resolveAs<BorderSide?>(theme.side, <WidgetState>{
          WidgetState.selected,
        })!.color,
        OnboardingColors.safetyYellow,
      );
    });
  });

  test('OTP subtitle formats the phone the way the kit writes it', () {
    expect(formatIndianPhoneForDisplay('+919876543210'), '+91 98765 43210');
    expect(formatIndianPhoneForDisplay('9876543210'), '+91 98765 43210');
    // Not an Indian mobile — shown as-is, never reshaped into another number.
    expect(formatIndianPhoneForDisplay('+14155550100'), '+14155550100');
    expect(formatIndianPhoneForDisplay(''), '');
  });
}
