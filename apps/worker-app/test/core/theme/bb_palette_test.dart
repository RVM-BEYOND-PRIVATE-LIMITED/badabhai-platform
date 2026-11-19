import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/bb_palette.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';

/// Pins the worker app's theme-role palette to the brand (#2824).
///
/// Two jobs:
/// 1. **Light is not a re-skin.** Every light role that existed in the UI kit
///    v3 token layer is the SAME hex as [OnboardingColors].
/// 2. **Dark stays at AA.** Every dark text/background pair the app uses is at
///    least 4.5:1 (body) or 3:1 (large text, icons, borders). A future edit
///    that "looks nicer" but drops a pair below AA fails here.
///
/// It also pins the ink hexes to `packages/design-tokens/tokens.css`, so the
/// app and the web portals cannot drift.
void main() {
  group('Light is exactly today\'s UI kit v3', () {
    void same(String name, Color role, Color token) {
      test(name, () => expect(role, token));
    }

    same('page', BbPalette.light.page, OnboardingColors.canvasBg);
    same('ivory', BbPalette.light.ivory, OnboardingColors.canvasIvory);
    same('card', BbPalette.light.card, OnboardingColors.paperWhite);
    same('raised', BbPalette.light.raised, OnboardingColors.chipBg);
    same('textPrimary', BbPalette.light.textPrimary, OnboardingColors.ink900);
    same(
      'textSecondary',
      BbPalette.light.textSecondary,
      OnboardingColors.ink600,
    );
    same('textMuted', BbPalette.light.textMuted, OnboardingColors.ink500);
    same('textBrand', BbPalette.light.textBrand, OnboardingColors.shiftBlue);
    same('action', BbPalette.light.action, OnboardingColors.safetyYellow);
    same(
      'actionPressed',
      BbPalette.light.actionPressed,
      OnboardingColors.safetyYellowDark,
    );
    same('onAction', BbPalette.light.onAction, OnboardingColors.textOnYellow);
    same(
      'onBrandSurface',
      BbPalette.light.onBrandSurface,
      OnboardingColors.textOnBlue,
    );
    same(
      'borderDefault',
      BbPalette.light.borderDefault,
      OnboardingColors.borderDefault,
    );
    same(
      'borderSubtle',
      BbPalette.light.borderSubtle,
      OnboardingColors.borderSubtle,
    );
    same(
      'borderActive',
      BbPalette.light.borderActive,
      OnboardingColors.borderActive,
    );
    same('success', BbPalette.light.success, OnboardingColors.successGreen);
    same('danger', BbPalette.light.danger, OnboardingColors.errorRed);
    same('scrim', BbPalette.light.scrim, OnboardingColors.scrim);
    same('focusRing', BbPalette.light.focusRing, OnboardingColors.shiftBlue);
  });

  group('Dark pins the ink tokens in packages/design-tokens/tokens.css', () {
    final Map<String, (Color, int)> ink = <String, (Color, int)>{
      'page': (BbPalette.dark.page, 0xFF050D22),
      'card': (BbPalette.dark.card, 0xFF0A1838),
      'raised': (BbPalette.dark.raised, 0xFF10224A),
      'sunken': (BbPalette.dark.sunken, 0xFF07122B),
      'borderDefault': (BbPalette.dark.borderDefault, 0xFF1F3160),
      'borderSubtle': (BbPalette.dark.borderSubtle, 0xFF16264D),
      'textPrimary': (BbPalette.dark.textPrimary, 0xFFFFFFFF),
      'textSecondary': (BbPalette.dark.textSecondary, 0xFFB9C0CE),
      'textMuted': (BbPalette.dark.textMuted, 0xFF8A92A6),
      'textBrand': (BbPalette.dark.textBrand, 0xFFB9C8E6),
      'link': (BbPalette.dark.link, 0xFFFFB32C),
      'action': (BbPalette.dark.action, 0xFFFFB32C),
      'success': (BbPalette.dark.success, 0xFF6DB588),
      'danger': (BbPalette.dark.danger, 0xFFE38B8B),
    };
    ink.forEach((String name, (Color, int) entry) {
      test('$name is #${entry.$2.toRadixString(16).toUpperCase()}', () {
        expect(entry.$1, Color(entry.$2));
      });
    });

    test('the ink page is not pure black or neutral grey', () {
      // Shift Blue based, per the brand kit. #050D22 has blue in it.
      expect(BbPalette.dark.page, isNot(const Color(0xFF000000)));
      final Color page = BbPalette.dark.page;
      final int argb = page.toARGB32();
      final int r = (argb >> 16) & 0xFF;
      final int g = (argb >> 8) & 0xFF;
      final int b = argb & 0xFF;
      expect(b, greaterThan(r), reason: 'the ink page leans Shift Blue');
      expect(b, greaterThan(g), reason: 'the ink page leans Shift Blue');
    });
  });

  group('Every dark pair meets WCAG AA', () {
    double contrast(Color a, Color b) {
      double channel(int v) {
        final double s = v / 255.0;
        return s <= 0.03928
            ? s / 12.92
            : math.pow((s + 0.055) / 1.055, 2.4).toDouble();
      }

      final int aa = a.toARGB32();
      final int bb = b.toARGB32();
      double lum(int argb) {
        final int r = (argb >> 16) & 0xFF;
        final int g = (argb >> 8) & 0xFF;
        final int bl = argb & 0xFF;
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(bl);
      }

      final double la = lum(aa);
      final double lb = lum(bb);
      final double hi = la > lb ? la : lb;
      final double lo = la > lb ? lb : la;
      return (hi + 0.05) / (lo + 0.05);
    }

    void aa(
      String name,
      Color foreground,
      Color background, {
      double min = 4.5,
    }) {
      test('$name is at least $min:1', () {
        expect(
          contrast(foreground, background),
          greaterThanOrEqualTo(min),
          reason: '$name on its surface is below AA',
        );
      });
    }

    const BbPalette p = BbPalette.dark;
    aa('textPrimary on card', p.textPrimary, p.card);
    aa('textPrimary on page', p.textPrimary, p.page);
    aa('textPrimary on raised', p.textPrimary, p.raised);
    aa('textSecondary on card', p.textSecondary, p.card);
    aa('textSecondary on raised', p.textSecondary, p.raised);
    aa('textMuted on card', p.textMuted, p.card);
    aa('textMuted on raised', p.textMuted, p.raised);
    aa('textBrand on card', p.textBrand, p.card);
    aa('link on card', p.link, p.card);
    aa('onBrandSurface on brandSurface', p.onBrandSurface, p.brandSurface);
    aa(
      'onBrandSurfaceMuted on brandSurface',
      p.onBrandSurfaceMuted,
      p.brandSurface,
    );
    aa('onAction on action', p.onAction, p.action);
    aa('success on card', p.success, p.card);
    aa('danger on card', p.danger, p.card);
    aa('warning on card', p.warning, p.card);
    aa('infoTitle on card', p.infoTitle, p.card);
    aa('infoText on card', p.infoText, p.card);

    // 3:1 for icons, large text and control borders.
    aa('action (icon) on card', p.action, p.card, min: 3);
    aa('action (icon) on page', p.action, p.page, min: 3);
    aa('focusRing on card', p.focusRing, p.card, min: 3);
    aa('borderDefault on card', p.borderDefault, p.card, min: 1.2);
  });
}
