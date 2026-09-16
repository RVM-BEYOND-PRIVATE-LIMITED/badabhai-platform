import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';

void main() {
  group('AppTheme — UI kit v3', () {
    testWidgets('uses Material 3', (tester) async {
      expect(AppTheme.light().useMaterial3, isTrue);
    });

    testWidgets('page sits on the cool canvas, not the default grey/white', (
      tester,
    ) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.scaffoldBackgroundColor, AppColors.surfacePage);
      expect(theme.scaffoldBackgroundColor, const Color(0xFFF2F4F8));
    });

    testWidgets(
      'yellow is the action colour (primary), navy is the structure',
      (tester) async {
        final ThemeData theme = AppTheme.light();
        expect(theme.colorScheme.primary, AppColors.brand); // yellow action
        expect(theme.colorScheme.primary, OnboardingColors.safetyYellow);
        expect(theme.colorScheme.secondary, AppColors.blue); // navy structure
        expect(theme.colorScheme.secondary, OnboardingColors.shiftBlue);
        expect(theme.colorScheme.error, AppColors.danger);
        // Text on yellow is ALWAYS shift blue.
        expect(theme.colorScheme.onPrimary, OnboardingColors.textOnYellow);
      },
    );

    testWidgets('the old material blue seed is gone from primary', (
      tester,
    ) async {
      // The old Material seed was #4F8CFF; assert primary is the brand, not it.
      expect(
        AppTheme.light().colorScheme.primary,
        isNot(const Color(0xFF4F8CFF)),
      );
    });

    testWidgets('primary CTA (FilledButton) is the yellow action colour', (
      tester,
    ) async {
      final ButtonStyle? style = AppTheme.light().filledButtonTheme.style;
      final Color? bg = style?.backgroundColor?.resolve(<WidgetState>{});
      expect(bg, AppColors.brand);
      // Flat: the design bans shadows outright.
      expect(style?.elevation?.resolve(<WidgetState>{}), 0);
    });

    testWidgets('app bar wears the NAVY chrome with a left-aligned title', (
      tester,
    ) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.appBarTheme.backgroundColor, OnboardingColors.shiftBlue);
      expect(theme.appBarTheme.foregroundColor, OnboardingColors.textOnBlue);
      expect(theme.appBarTheme.elevation, 0);
      // v3 headers are left-aligned; a centred title is the old chrome.
      expect(theme.appBarTheme.centerTitle, isFalse);
    });

    testWidgets('a FOCUSED input rings navy at 1.8, never yellow', (
      tester,
    ) async {
      // Spec §3.3's one focus rule. Yellow means SELECTED (a card, a chip, a
      // ticked box); an input is never "selected", so a yellow focus ring here
      // would collide with the one state yellow is reserved for.
      final InputDecorationThemeData input =
          AppTheme.light().inputDecorationTheme;
      final BorderSide focused =
          (input.focusedBorder! as OutlineInputBorder).borderSide;
      expect(focused.color, OnboardingColors.shiftBlue);
      expect(focused.width, 1.8);

      final BorderSide enabled =
          (input.enabledBorder! as OutlineInputBorder).borderSide;
      expect(enabled.color, OnboardingColors.borderDefault);
      expect(enabled.width, 1.2);
    });

    testWidgets(
      'a ticked checkbox is navy fill + yellow border + yellow tick',
      (tester) async {
        final CheckboxThemeData box = AppTheme.light().checkboxTheme;
        const Set<WidgetState> on = <WidgetState>{WidgetState.selected};
        expect(box.fillColor?.resolve(on), OnboardingColors.shiftBlue);
        expect(box.checkColor?.resolve(on), OnboardingColors.safetyYellow);
        // `side` is a WidgetStateBorderSide, which presents itself AS a
        // BorderSide — resolveAs is how a state-dependent one is read back.
        expect(
          WidgetStateProperty.resolveAs<BorderSide?>(box.side, on)?.color,
          OnboardingColors.safetyYellow,
        );
        expect(
          WidgetStateProperty.resolveAs<BorderSide?>(
            box.side,
            <WidgetState>{},
          )?.color,
          OnboardingColors.borderDefault,
        );
      },
    );

    testWidgets('a switch reads navy track + yellow knob when on', (
      tester,
    ) async {
      final SwitchThemeData sw = AppTheme.light().switchTheme;
      const Set<WidgetState> on = <WidgetState>{WidgetState.selected};
      expect(sw.trackColor?.resolve(on), OnboardingColors.shiftBlue);
      expect(sw.thumbColor?.resolve(on), OnboardingColors.safetyYellow);
      expect(
        sw.trackColor?.resolve(<WidgetState>{}),
        OnboardingColors.disabledBg,
      );
    });

    testWidgets('dialogs and sheets are flat white with 16dp corners', (
      tester,
    ) async {
      final ThemeData theme = AppTheme.light();
      expect(theme.dialogTheme.backgroundColor, OnboardingColors.paperWhite);
      expect(theme.dialogTheme.elevation, 0);
      expect(theme.dialogTheme.barrierColor, OnboardingColors.scrim);
      expect(
        theme.dialogTheme.shape,
        const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(16)),
        ),
      );
      expect(
        theme.bottomSheetTheme.backgroundColor,
        OnboardingColors.paperWhite,
      );
      expect(theme.bottomSheetTheme.modalBarrierColor, OnboardingColors.scrim);
    });

    testWidgets('the body font is the BUNDLED Inter, not a platform guess', (
      tester,
    ) async {
      // 'Roboto' was never a bundled family in this app, so every themed label
      // silently rendered in the platform font.
      final ThemeData theme = AppTheme.light();
      expect(theme.textTheme.bodyMedium?.fontFamily, 'Inter');
    });
  });
}
