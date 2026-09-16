import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/kit/phone_number_field.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/brand_badge.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/enter_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/enter_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/forgot_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_set_pin_form.dart';

import '../../support/kit_matrix.dart';

class _MockManager extends Mock implements AuthSessionManager {}

/// D13 for the PIN surfaces: unlock (enter PIN), the custom keypad and the
/// three-phase forgot-PIN reset.
///
/// These are the screens a worker CANNOT get past — an overflow here locks them
/// out of the app entirely, so each one is pumped across every device shape at
/// 100% / 150% / 200% system font (ruling R1: the app honours the phone's font
/// size up to 2.0, chrome clamps itself at 1.3 and body copy scrolls). The
/// matrix also asserts the far-bottom control is REACHABLE, because a
/// "PIN bhool gaye?" link or a "Save PIN & Continue" button that exists below
/// the fold with nothing to scroll is the same dead end as a crash.
void main() {
  setUpAll(() {
    // A caret that blinks forever keeps a frame scheduled forever.
    BbPinView.debugDeterministicCaret = true;
  });
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  late _MockManager manager;

  setUp(() async {
    await locator.reset();
    manager = _MockManager();
    // The reset request SUCCEEDS so the phone phase can advance to the OTP
    // phase, and unlock never resolves (the matrix never types a PIN).
    when(() => manager.requestPinReset(any())).thenAnswer((_) async {});
    locator.registerSingleton<AuthSessionManager>(manager);
    locator.registerFactory<EnterPinCubit>(() => EnterPinCubit(manager));
  });

  tearDown(() => locator.reset());

  // ---- enter PIN (unlock) --------------------------------------------------

  kitMatrixTest(
    'enter PIN keeps the keypad and the reset link reachable',
    () => const EnterPinScreen(),
    primary: () => find.text('PIN bhool gaye?'),
    arrange: (WidgetTester tester) async {
      // The whole point of the screen: four masked slots and the keys that
      // fill them. Neither may be dropped or clipped at any size.
      expect(find.byType(BbPinView), findsOneWidget);
      expect(find.byType(BbPinKeypad), findsOneWidget);
      expect(find.text('PIN DAALEIN'), findsOneWidget);
    },
  );

  testWidgets('enter PIN: every key clears the 48dp floor on a real handset', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(const EnterPinScreen()));
    await tester.pump();

    await expectKitTapTargets(tester);
  });

  testWidgets('enter PIN: the keypad stays thumb-sized at the 320dp floor', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(320, 568));
    await tester.pumpWidget(kitTestApp(const EnterPinScreen()));
    await tester.pump();

    // 3 keys x 80 + 6 x 12 padding = 312 > the 280 a 320dp screen leaves inside
    // the 20dp gutter, so the row scales DOWN rather than clipping the
    // backspace key (#1469). Scaled, a key must still clear the touch floor.
    final Size key = tester.getSize(find.text('5'));
    expect(key.width, lessThanOrEqualTo(80));
    // The KEY, not the glyph: the backspace now sits on the same white tile as
    // the digits (so its press ink is clipped to it), and the glyph inside that
    // tile is its own 24dp icon rather than a box stretched to the key.
    final Size backspace = tester.getSize(
      find
          .ancestor(
            of: find.byIcon(Icons.backspace_outlined),
            matching: find.byType(InkWell),
          )
          .first,
    );
    expect(
      backspace.height,
      greaterThanOrEqualTo(48),
      reason: 'the one key that fixes a typo must never shrink below a thumb',
    );
  });

  testWidgets('enter PIN: the column centres on a tablet, never stretches', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(const EnterPinScreen()));
    await tester.pump();

    expect(
      tester.getCenter(find.byType(BbPinKeypad)).dx,
      closeTo(384, 1),
      reason: 'the kit column centres on glass this wide',
    );
    expect(tester.getCenter(find.byType(BbPinView)).dx, closeTo(384, 1));
  });

  // ---- forgot PIN: phone → OTP → new PIN ----------------------------------

  /// Phone phase → OTP phase. `ensureVisible` first: at 320dp and 200% font the
  /// CTA is below the fold, and a tap on an off-screen widget is not a tap.
  Future<void> advanceToOtp(WidgetTester tester) async {
    await tester.enterText(find.byType(TextField).first, '9876543210');
    await tester.pump();
    final Finder send = find.text('Send OTP');
    await tester.ensureVisible(send);
    await tester.pump();
    await tester.tap(send);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// …then OTP phase → the new-PIN page.
  Future<void> advanceToPin(WidgetTester tester) async {
    await advanceToOtp(tester);
    await tester.enterText(find.byType(TextField).first, '123456');
    await tester.pump();
    final Finder next = find.text('Aage badhein');
    await tester.ensureVisible(next);
    await tester.pump();
    await tester.tap(next);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  kitMatrixTest(
    'forgot PIN (phone) keeps the number box and Send OTP reachable',
    () => const ForgotPinScreen(),
    primary: () => find.text('Send OTP'),
    arrange: (WidgetTester tester) async {
      expect(find.byType(PhoneNumberField), findsOneWidget);
      expect(find.text('MOBILE NUMBER'), findsOneWidget);
    },
  );

  kitMatrixTest(
    'forgot PIN (new PIN) keeps both rows and the save button reachable',
    () => const ForgotPinScreen(),
    primary: () => find.text('Save PIN & Continue'),
    arrange: (WidgetTester tester) async {
      await advanceToPin(tester);
      expect(find.byKey(kSetPinFirstFieldKey), findsOneWidget);
      expect(find.byKey(kSetPinConfirmFieldKey), findsOneWidget);
    },
  );

  testWidgets('forgot PIN: the OTP phase survives the whole matrix too', (
    WidgetTester tester,
  ) async {
    for (final Size size in kKitMatrixSizes) {
      for (final double scale in kKitMatrixTextScales) {
        tester.view.physicalSize = size;
        tester.view.devicePixelRatio = 1.0;
        await tester.pumpWidget(
          kitTestApp(const ForgotPinScreen(), textScale: scale),
        );
        await tester.pump();
        await advanceToOtp(tester);

        expect(
          tester.takeException(),
          isNull,
          reason: 'the OTP phase threw at $size, text x$scale',
        );
        expect(find.text('OTP DAALEIN'), findsOneWidget);
        await tester.pumpWidget(const SizedBox.shrink());
      }
    }
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  });

  testWidgets(
    'forgot PIN with the keyboard up: the header collapses and the CTA is '
    'still reachable',
    (WidgetTester tester) async {
      // The real crowding case — a 568dp handset with ~300dp of keyboard leaves
      // the form a sliver, which is exactly when ShiftBlueHeader drops its
      // badge row (auto-compact).
      setKitSurface(tester, const Size(320, 568), keyboard: 300);
      await tester.pumpWidget(kitTestApp(const ForgotPinScreen()));
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(
        find.byType(BrandBadge),
        findsNothing,
        reason: 'the badge row is the space the form needs back',
      );
      final Finder send = find.text('Send OTP');
      await tester.scrollUntilVisible(
        send,
        120,
        scrollable: find.byType(Scrollable).first,
      );
      expect(send, findsOneWidget);
    },
  );

  testWidgets('forgot PIN: the new-PIN page holds up with the keyboard up', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(320, 568), keyboard: 300);
    await tester.pumpWidget(kitTestApp(const ForgotPinScreen()));
    await tester.pump();
    await advanceToPin(tester);

    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      find.text('Save PIN & Continue'),
      120,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Save PIN & Continue'), findsOneWidget);
  });

  testWidgets('forgot PIN: the form column stops at 440 on a tablet', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(const ForgotPinScreen()));
    await tester.pump();

    expect(
      widthOf(tester, find.byType(PhoneNumberField)),
      440,
      reason: 'a 54dp phone box must not stretch across 768dp of glass',
    );
  });

  testWidgets('forgot PIN: tap targets clear 48dp on a real handset', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(const ForgotPinScreen()));
    await tester.pump();

    await expectKitTapTargets(tester);
  });
}
