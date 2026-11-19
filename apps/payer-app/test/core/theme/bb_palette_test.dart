import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/theme/app_colors.dart';
import 'package:payer_app/core/theme/bb_palette.dart';

/// Pins the payer app's theme-role palette to the brand (#2830).
///
/// Two jobs:
/// 1. **Light is not a re-skin.** Every light role is the SAME hex as the
///    existing [AppColors] token layer, so a light-build screenshot cannot move.
/// 2. **Dark stays at AA.** Every dark text/background pair the app uses is at
///    least 4.5:1 (body) or 3:1 (large text, icons, borders). A future edit
///    that "looks nicer" but drops a pair below AA fails here.
///
/// It also pins the ink hexes to `packages/design-tokens/tokens.css`, so the
/// app and the web portals cannot drift.
void main() {
  group('Light is exactly today\'s AppColors', () {
    void same(String name, Color role, Color token) {
      test(name, () => expect(role, token));
    }

    same('page', BbPalette.light.page, AppColors.surfacePage);
    same('ivory', BbPalette.light.ivory, AppColors.paper2);
    same('card', BbPalette.light.card, AppColors.surfaceCard);
    same('raised', BbPalette.light.raised, AppColors.surfaceSunken);
    same('sunken', BbPalette.light.sunken, AppColors.surfaceSunken);
    same('inset', BbPalette.light.inset, AppColors.surfaceInset);
    same('brandSurface', BbPalette.light.brandSurface, AppColors.surfaceInk);
    same(
      'brandSurfaceLight',
      BbPalette.light.brandSurfaceLight,
      AppColors.bluePressed,
    );
    same(
      'brandSurfaceRaised',
      BbPalette.light.brandSurfaceRaised,
      AppColors.blue,
    );
    same('textPrimary', BbPalette.light.textPrimary, AppColors.textPrimary);
    same(
      'textSecondary',
      BbPalette.light.textSecondary,
      AppColors.textSecondary,
    );
    same('textMuted', BbPalette.light.textMuted, AppColors.textMuted);
    same('textBrand', BbPalette.light.textBrand, AppColors.textBrand);
    same('link', BbPalette.light.link, AppColors.textLink);
    same('iconSecondary', BbPalette.light.iconSecondary, AppColors.ink700);
    same('onBrandSurface', BbPalette.light.onBrandSurface, AppColors.onBlue);
    same(
      'onBrandSurfaceMuted',
      BbPalette.light.onBrandSurfaceMuted,
      AppColors.onBlueMuted,
    );
    same('action', BbPalette.light.action, AppColors.brand);
    same('actionPressed', BbPalette.light.actionPressed, AppColors.brandPress);
    same('onAction', BbPalette.light.onAction, AppColors.textOnBrand);
    same('actionTint', BbPalette.light.actionTint, AppColors.brandTint);
    same(
      'borderDefault',
      BbPalette.light.borderDefault,
      AppColors.borderDefault,
    );
    same(
      'borderSubtle',
      BbPalette.light.borderSubtle,
      AppColors.borderSubtle,
    );
    same('success', BbPalette.light.success, AppColors.success);
    same('successBg', BbPalette.light.successBg, AppColors.successTint);
    same('danger', BbPalette.light.danger, AppColors.danger);
    same('dangerBg', BbPalette.light.dangerBg, AppColors.dangerTint);
    same('warning', BbPalette.light.warning, AppColors.warning);
    same('warningBg', BbPalette.light.warningBg, AppColors.warningTint);
    same('info', BbPalette.light.info, AppColors.info);
    same('infoBg', BbPalette.light.infoBg, AppColors.infoTint);
    same('disabledBg', BbPalette.light.disabledBg, AppColors.disabled);
    same(
      'disabledText',
      BbPalette.light.disabledText,
      AppColors.textSecondary,
    );
    same('scrim', BbPalette.light.scrim, AppColors.scrim);
    same('focusRing', BbPalette.light.focusRing, AppColors.brand);
    same('haldi', BbPalette.light.haldi, AppColors.haldi);
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
