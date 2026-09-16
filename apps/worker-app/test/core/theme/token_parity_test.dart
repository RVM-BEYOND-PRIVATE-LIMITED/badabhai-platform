import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';

/// Locks the v3 token layer to the SPEC, hex by hex, and locks the legacy
/// [AppColors] facade to the v3 layer.
///
/// WHY THIS FILE EXISTS. The app carries two colour classes: [OnboardingColors]
/// (canonical v3) and [AppColors] (the legacy JUL31 names, kept so ~66 files
/// still compile, with their VALUES re-pointed). Nothing stops those two
/// drifting apart again except this test — and "drift" here means a screen
/// quietly rendering last season's palette while the code reads as if it were
/// migrated, which is exactly the state this redesign was cleaning up.
///
/// So: every §1.1 name must equal its documented hex, and every single
/// [AppColors] member must be either a v3 token or a DOCUMENTED tint with a
/// reason. There is no third category.
void main() {
  group('UI kit v3 §1.1 — OnboardingColors matches the spec hex for hex', () {
    const Map<String, (Color, int)> spec = <String, (Color, int)>{
      'shiftBlue': (OnboardingColors.shiftBlue, 0xFF05194C),
      'shiftBlueLight': (OnboardingColors.shiftBlueLight, 0xFF0A256E),
      'shiftBlueSurface': (OnboardingColors.shiftBlueSurface, 0xFF0F2B7A),
      'safetyYellow': (OnboardingColors.safetyYellow, 0xFFFFB32C),
      'safetyYellowDark': (OnboardingColors.safetyYellowDark, 0xFFE09A1F),
      'haldi': (OnboardingColors.haldi, 0xFFFFC400),
      'canvasBg': (OnboardingColors.canvasBg, 0xFFF2F4F8),
      'canvasIvory': (OnboardingColors.canvasIvory, 0xFFF3F5F4),
      'paperWhite': (OnboardingColors.paperWhite, 0xFFFFFFFF),
      'surfaceMuted': (OnboardingColors.surfaceMuted, 0xFFF8FAFC),
      'borderDefault': (OnboardingColors.borderDefault, 0xFFD8DEE9),
      'borderSubtle': (OnboardingColors.borderSubtle, 0xFFE2E8F0),
      'borderActive': (OnboardingColors.borderActive, 0xFFFFB32C),
      'ink900': (OnboardingColors.ink900, 0xFF101828),
      'ink600': (OnboardingColors.ink600, 0xFF475069),
      'ink500': (OnboardingColors.ink500, 0xFF667085),
      'textOnBlue': (OnboardingColors.textOnBlue, 0xFFFFFFFF),
      'textOnBlueMuted': (OnboardingColors.textOnBlueMuted, 0xFFB9C8E6),
      'textOnYellow': (OnboardingColors.textOnYellow, 0xFF05194C),
      'successGreen': (OnboardingColors.successGreen, 0xFF1E7A3C),
      'successBg': (OnboardingColors.successBg, 0xFFDCFCE7),
      'successBorder': (OnboardingColors.successBorder, 0xFF86EFAC),
      'errorRed': (OnboardingColors.errorRed, 0xFFC62828),
      'errorBg': (OnboardingColors.errorBg, 0xFFFEE2E2),
      'disabledBg': (OnboardingColors.disabledBg, 0xFFC5CEDF),
      'disabledText': (OnboardingColors.disabledText, 0xFF8A9BAD),
      'infoBg': (OnboardingColors.infoBg, 0xFFEFF6FF),
      'infoBorder': (OnboardingColors.infoBorder, 0xFFBFDBFE),
      'infoTitle': (OnboardingColors.infoTitle, 0xFF1E3A8A),
      'infoText': (OnboardingColors.infoText, 0xFF1E40AF),
      'rowBg': (OnboardingColors.rowBg, 0xFFF8FAFC),
      'pillMutedBg': (OnboardingColors.pillMutedBg, 0xFFF1F5F9),
      'yellowTint20': (OnboardingColors.yellowTint20, 0x33FFB32C),
      'scrim': (OnboardingColors.scrim, 0x8F05194C),
      'textOnBlue70': (OnboardingColors.textOnBlue70, 0xB3FFFFFF),
    };

    spec.forEach((String name, (Color, int) entry) {
      test('$name is #${entry.$2.toRadixString(16).toUpperCase()}', () {
        expect(entry.$1, Color(entry.$2));
      });
    });

    test('the checkbox rule is navy fill + yellow border + yellow tick', () {
      // The spec states this one as a rule, not a colour, and it is the control
      // a worker reads to confirm what they picked.
      expect(OnboardingColors.blueThemeDark, OnboardingColors.shiftBlue);
      expect(OnboardingColors.borderActive, OnboardingColors.safetyYellow);
    });
  });

  group('AppColors is a facade over v3 — no member escapes', () {
    /// Every v3 token value. A legacy member equal to any of these is fine by
    /// definition: it IS the kit colour, just reached by an older name.
    ///
    /// A LIST, not a set literal: several v3 names deliberately share a hex
    /// (`surfaceMuted` and `rowBg` are both #F8FAFC, `borderActive` is
    /// `safetyYellow`, `textOnYellow` is `shiftBlue`), and a set literal would
    /// be a lint error for the duplicates rather than the lookup table wanted.
    final Set<int> v3 = <Color>[
      OnboardingColors.shiftBlue,
      OnboardingColors.shiftBlueLight,
      OnboardingColors.shiftBlueSurface,
      OnboardingColors.safetyYellow,
      OnboardingColors.safetyYellowDark,
      OnboardingColors.haldi,
      OnboardingColors.canvasBg,
      OnboardingColors.canvasIvory,
      OnboardingColors.paperWhite,
      OnboardingColors.surfaceMuted,
      OnboardingColors.borderDefault,
      OnboardingColors.borderSubtle,
      OnboardingColors.borderActive,
      OnboardingColors.borderCard,
      OnboardingColors.ink900,
      OnboardingColors.ink600,
      OnboardingColors.ink500,
      OnboardingColors.textOnBlue,
      OnboardingColors.textOnBlueMuted,
      OnboardingColors.textOnYellow,
      OnboardingColors.successGreen,
      OnboardingColors.successBg,
      OnboardingColors.successBorder,
      OnboardingColors.errorRed,
      OnboardingColors.errorBg,
      OnboardingColors.disabledBg,
      OnboardingColors.disabledText,
      OnboardingColors.infoBg,
      OnboardingColors.infoBorder,
      OnboardingColors.infoTitle,
      OnboardingColors.infoText,
      OnboardingColors.rowBg,
      OnboardingColors.pillMutedBg,
      OnboardingColors.yellowTint20,
      OnboardingColors.scrim,
      OnboardingColors.textOnBlue70,
      OnboardingColors.selectedCardBg,
      OnboardingColors.noteBg,
    ].map((Color c) => c.toARGB32()).toSet();

    /// Legacy members with NO v3 counterpart, each with the reason it survives.
    ///
    /// An entry here is a permanent exception, so the reason must be a real one:
    /// a pressed/failed shade the spec never defines, or a ramp step a call site
    /// still names. "It looked fine" is not a reason — re-point it instead.
    const Map<String, (Color, int, String)>
    tints = <String, (Color, int, String)>{
      'ink950': (
        AppColors.ink950,
        0xFF0A0E18,
        'deepest ink — ColorScheme.shadow',
      ),
      'ink800': (AppColors.ink800, 0xFF232D42, 'legacy ink ramp step'),
      'ink700': (AppColors.ink700, 0xFF333E58, 'legacy ink ramp step'),
      'ink400': (AppColors.ink400, 0xFFA8AFBF, 'legacy ink ramp step'),
      'green600': (
        AppColors.green600,
        0xFF145C2D,
        'pressed green — no spec shade',
      ),
      'green700': (AppColors.green700, 0xFF0F4623, 'darkest green ramp step'),
      'green200': (AppColors.green200, 0xFF4ADE80, 'legacy green ramp step'),
      'green300': (AppColors.green300, 0xFF22C55E, 'legacy green ramp step'),
      'red600': (AppColors.red600, 0xFFA21F1F, 'pressed red — no spec shade'),
      'red700': (AppColors.red700, 0xFF7F1818, 'darkest red ramp step'),
      'red100': (AppColors.red100, 0xFFFECACA, 'legacy red ramp step'),
      'red300': (AppColors.red300, 0xFFEF6A6A, 'legacy red ramp step'),
      'brandBorder': (
        AppColors.brandBorder,
        0xFFE7C34A,
        'yellow-edged hairline',
      ),
      'ring': (AppColors.ring, 0x6BFFB32C, 'yellow focus ring at 42%'),
      'vermilion50': (AppColors.vermilion50, 0xFFFFF8EB, 'yellow ramp step'),
      'vermilion100': (AppColors.vermilion100, 0xFFFFEFCC, 'yellow ramp step'),
      'vermilion200': (AppColors.vermilion200, 0xFFFFDE99, 'yellow ramp step'),
      'vermilion300': (AppColors.vermilion300, 0xFFFFCD66, 'yellow ramp step'),
      'vermilion400': (AppColors.vermilion400, 0xFFFFC04A, 'yellow ramp step'),
      'vermilion700': (AppColors.vermilion700, 0xFFBD8119, 'yellow ramp step'),
      'vermilion800': (AppColors.vermilion800, 0xFF9C6A14, 'yellow ramp step'),
      'vermilion900': (AppColors.vermilion900, 0xFF7D550F, 'yellow ramp step'),
      'saffron50': (AppColors.saffron50, 0xFFFFF8EB, 'yellow ramp step'),
      'saffron100': (AppColors.saffron100, 0xFFFFEFCC, 'yellow ramp step'),
      'saffron200': (AppColors.saffron200, 0xFFFFDE99, 'yellow ramp step'),
      'saffron300': (AppColors.saffron300, 0xFFFFCD66, 'yellow ramp step'),
      'saffron500': (AppColors.saffron500, 0xFFF0A522, 'yellow ramp step'),
      'saffron700': (AppColors.saffron700, 0xFFBD8119, 'yellow ramp step'),
    };

    /// Every member of the facade, by name.
    final Map<String, Color> all = <String, Color>{
      'haldi': AppColors.haldi,
      'haldiPressed': AppColors.haldiPressed,
      'haldiTint': AppColors.haldiTint,
      'blue': AppColors.blue,
      'bluePressed': AppColors.bluePressed,
      'blueTintChat': AppColors.blueTintChat,
      'blueChatOut': AppColors.blueChatOut,
      'onHaldi': AppColors.onHaldi,
      'onBlue': AppColors.onBlue,
      'onBlueMuted': AppColors.onBlueMuted,
      'canvas': AppColors.canvas,
      'paper': AppColors.paper,
      'disabled': AppColors.disabled,
      'greenTint': AppColors.greenTint,
      'greenTintBorder': AppColors.greenTintBorder,
      'green50': AppColors.green50,
      'green100': AppColors.green100,
      'green500': AppColors.green500,
      'red50': AppColors.red50,
      'red500': AppColors.red500,
      'vermilion500': AppColors.vermilion500,
      'vermilion600': AppColors.vermilion600,
      'saffron400': AppColors.saffron400,
      'saffron600': AppColors.saffron600,
      'pink50': AppColors.pink50,
      'pink100': AppColors.pink100,
      'pink500': AppColors.pink500,
      'pink600': AppColors.pink600,
      'teal50': AppColors.teal50,
      'teal100': AppColors.teal100,
      'teal500': AppColors.teal500,
      'teal600': AppColors.teal600,
      'teal700': AppColors.teal700,
      'ink900': AppColors.ink900,
      'ink600': AppColors.ink600,
      'ink550': AppColors.ink550,
      'ink500': AppColors.ink500,
      'ink300': AppColors.ink300,
      'ink200': AppColors.ink200,
      'ink100': AppColors.ink100,
      'ink50': AppColors.ink50,
      'paper0': AppColors.paper0,
      'paper1': AppColors.paper1,
      'paper2': AppColors.paper2,
      'paper3': AppColors.paper3,
      'paper4': AppColors.paper4,
      'textPrimary': AppColors.textPrimary,
      'textSecondary': AppColors.textSecondary,
      'textMuted': AppColors.textMuted,
      'textFaint': AppColors.textFaint,
      'textInverse': AppColors.textInverse,
      'textBrand': AppColors.textBrand,
      'textOnBrand': AppColors.textOnBrand,
      'textLink': AppColors.textLink,
      'surfacePage': AppColors.surfacePage,
      'surfaceCard': AppColors.surfaceCard,
      'surfaceRaised': AppColors.surfaceRaised,
      'surfaceSunken': AppColors.surfaceSunken,
      'surfaceInset': AppColors.surfaceInset,
      'surfaceInk': AppColors.surfaceInk,
      'surfaceInk2': AppColors.surfaceInk2,
      'brand': AppColors.brand,
      'brandHover': AppColors.brandHover,
      'brandPress': AppColors.brandPress,
      'brandTint': AppColors.brandTint,
      'brandTint2': AppColors.brandTint2,
      'saffron': AppColors.saffron,
      'saffronDeep': AppColors.saffronDeep,
      'pink': AppColors.pink,
      'teal': AppColors.teal,
      'success': AppColors.success,
      'successPress': AppColors.successPress,
      'successTint': AppColors.successTint,
      'danger': AppColors.danger,
      'dangerPress': AppColors.dangerPress,
      'dangerTint': AppColors.dangerTint,
      'warning': AppColors.warning,
      'warningTint': AppColors.warningTint,
      'info': AppColors.info,
      'infoTint': AppColors.infoTint,
      'borderSubtle': AppColors.borderSubtle,
      'borderDefault': AppColors.borderDefault,
      'borderStrong': AppColors.borderStrong,
      'borderInk': AppColors.borderInk,
      'divider': AppColors.divider,
      'scrim': AppColors.scrim,
      'borderFestive': AppColors.borderFestive,
      'borderDouble': AppColors.borderDouble,
      ...tints.map(
        (String name, (Color, int, String) e) =>
            MapEntry<String, Color>(name, e.$1),
      ),
    };

    test('every documented tint still holds its stated hex', () {
      tints.forEach((String name, (Color, int, String) e) {
        expect(
          e.$1,
          Color(e.$2),
          reason: '$name (${e.$3}) drifted from its documented value',
        );
      });
    });

    test('every AppColors member is a v3 token or a documented tint', () {
      // Matched by VALUE as well as by name: several semantic aliases point at
      // a documented tint (`successPress` IS `green600`), and an alias of a
      // documented colour is documented.
      final Set<int> tintValues = tints.values
          .map(((Color, int, String) e) => e.$1.toARGB32())
          .toSet();
      final List<String> stray = <String>[];
      all.forEach((String name, Color value) {
        final bool known =
            v3.contains(value.toARGB32()) ||
            tints.containsKey(name) ||
            tintValues.contains(value.toARGB32());
        if (!known) {
          stray.add(
            '$name = #${value.toARGB32().toRadixString(16).toUpperCase()}',
          );
        }
      });
      expect(
        stray,
        isEmpty,
        reason:
            'These legacy colours are neither a v3 token nor a documented '
            'tint. Re-point them to OnboardingColors, or add them to the tint '
            'table WITH a reason:\n${stray.join('\n')}',
      );
    });

    test('the two role-collision names keep their documented meaning', () {
      // Named in app_colors.dart's class doc. Both are load-bearing: a
      // mechanical rename would have edited 43 call sites owned by other
      // packages to fix a naming clash that changes nothing on screen.
      expect(
        AppColors.haldi,
        OnboardingColors.safetyYellow,
        reason:
            'AppColors.haldi means "the CTA yellow" (#FFB32C), NOT the '
            "spec's own haldi (#FFC400)",
      );
      expect(AppColors.haldi, isNot(OnboardingColors.haldi));
      expect(
        AppColors.borderSubtle,
        OnboardingColors.borderDefault,
        reason: 'AppColors.borderSubtle means "the default 1px outline"',
      );
      expect(AppColors.borderSubtle, isNot(OnboardingColors.borderSubtle));
      expect(
        AppColors.divider,
        OnboardingColors.borderSubtle,
        reason: "the spec's hairline lives at AppColors.divider",
      );
    });
  });
}
