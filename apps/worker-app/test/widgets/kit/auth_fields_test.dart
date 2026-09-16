import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/kit/otp_code_field.dart';
import 'package:badabhai_worker_app/core/widgets/kit/phone_number_field.dart';
import 'package:badabhai_worker_app/core/widgets/kit/secure_note.dart';

import '../../support/kit_matrix.dart';

void main() {
  group('PhoneNumberField — spec §3.2', () {
    late TextEditingController controller;
    late FocusNode focusNode;

    setUp(() {
      controller = TextEditingController();
      focusNode = FocusNode();
    });

    tearDown(() {
      controller.dispose();
      focusNode.dispose();
    });

    Widget host() => Scaffold(
      body: Center(
        child: SizedBox(
          width: 340,
          child: PhoneNumberField(
            controller: controller,
            focusNode: focusNode,
            fieldKey: const Key('phone'),
            semanticLabel: 'Mobile number',
          ),
        ),
      ),
    );

    testWidgets('is 54 tall with a fixed +91 and a mono hint', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(host()));

      expect(tester.getSize(find.byType(PhoneNumberField)).height, 54);
      expect(find.text('+91'), findsOneWidget);
      expect(find.text('XXXXXXXXXX'), findsOneWidget);
    });

    testWidgets('rings NAVY at 1.8 on focus, never yellow', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(host()));

      BoxDecoration boxAt() =>
          tester
                  .widget<Container>(
                    find
                        .descendant(
                          of: find.byType(PhoneNumberField),
                          matching: find.byType(Container),
                        )
                        .first,
                  )
                  .decoration!
              as BoxDecoration;

      expect(boxAt().border!.top.color, OnboardingColors.borderDefault);
      expect(boxAt().border!.top.width, 1.2);

      focusNode.requestFocus();
      await tester.pump();

      // Yellow means SELECTED in v3; an input is never selected.
      expect(boxAt().border!.top.color, OnboardingColors.shiftBlue);
      expect(boxAt().border!.top.width, 1.8);
      expect(boxAt().border!.top.color, isNot(OnboardingColors.borderActive));
    });

    testWidgets('strips punctuation and caps at 10 digits, so nothing '
        'malformed can reach the E.164 boundary', (WidgetTester tester) async {
      await tester.pumpWidget(kitTestApp(host()));

      await tester.enterText(find.byKey(const Key('phone')), '98765-43210');
      expect(controller.text, '9876543210');

      // Over-long input keeps the FIRST ten digits rather than silently
      // shifting the number.
      await tester.enterText(find.byKey(const Key('phone')), '98765432109999');
      expect(controller.text, '9876543210');
    });
  });

  group('OtpCodeField — spec §3.3', () {
    late TextEditingController controller;
    late FocusNode focusNode;

    setUp(() {
      controller = TextEditingController();
      focusNode = FocusNode();
    });

    tearDown(() {
      controller.dispose();
      focusNode.dispose();
    });

    Widget host({double width = 360}) => Scaffold(
      body: Center(
        child: SizedBox(
          width: width,
          child: OtpCodeField(
            controller: controller,
            focusNode: focusNode,
            autofocus: false,
            fieldKey: const Key('otp'),
          ),
        ),
      ),
    );

    testWidgets('draws six 48x54 cells with 10dp corners where they fit', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(host()));

      final Finder cells = find.descendant(
        of: find.byType(OtpCodeField),
        matching: find.byType(Container),
      );
      expect(cells, findsNWidgets(6));

      final Size cell = tester.getSize(cells.first);
      expect(cell.width, 48);
      expect(cell.height, 54);

      final BoxDecoration decoration =
          tester.widget<Container>(cells.first).decoration! as BoxDecoration;
      expect(
        decoration.borderRadius,
        BorderRadius.circular(OnboardingRadii.otpBox),
      );
    });

    testWidgets('SHRINKS the cells on a 320 handset rather than overflowing', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(kitTestApp(host(width: 280)));
      await tester.pump();

      expect(tester.takeException(), isNull);
      final Size cell = tester.getSize(
        find
            .descendant(
              of: find.byType(OtpCodeField),
              matching: find.byType(Container),
            )
            .first,
      );
      expect(cell.width, lessThan(48));
    });

    testWidgets('the focused cell rings NAVY at 1.8', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(host()));
      focusNode.requestFocus();
      await tester.pump();

      final BoxDecoration first =
          tester
                  .widget<Container>(
                    find
                        .descendant(
                          of: find.byType(OtpCodeField),
                          matching: find.byType(Container),
                        )
                        .first,
                  )
                  .decoration!
              as BoxDecoration;
      expect(first.border!.top.color, OnboardingColors.shiftBlue);
      expect(first.border!.top.width, 1.8);
    });

    testWidgets('ONE field takes the whole code, and the cells render it', (
      WidgetTester tester,
    ) async {
      // Six real fields would break SMS autofill, paste, and TalkBack. The
      // cells are decoration over a single input.
      await tester.pumpWidget(kitTestApp(host()));

      expect(find.byType(TextField), findsOneWidget);
      await tester.enterText(find.byKey(const Key('otp')), '123456');
      await tester.pump();

      for (final String digit in <String>['1', '2', '3', '4', '5', '6']) {
        expect(find.text(digit), findsOneWidget);
      }
    });

    testWidgets('digits only, capped at the length the API mints', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(host()));

      await tester.enterText(
        find.byKey(const Key('otp')),
        'Your OTP is 123456',
      );
      expect(controller.text, '123456');
    });
  });

  group('SecureNote', () {
    testWidgets('uses a real shield GLYPH, not an emoji', (
      WidgetTester tester,
    ) async {
      // An emoji renders in a different font on every handset, is announced
      // literally by TalkBack, and scales with the emoji setting, not the text.
      await tester.pumpWidget(
        kitTestApp(const Scaffold(body: Center(child: SecureNote()))),
      );

      expect(find.byIcon(Icons.shield_outlined), findsOneWidget);
      expect(find.text('100% Safe & Secure • No agent fees'), findsOneWidget);
    });
  });
}
