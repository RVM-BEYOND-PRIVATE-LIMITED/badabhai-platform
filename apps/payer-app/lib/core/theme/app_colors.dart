import 'package:flutter/material.dart';

/// BadaBhai colour tokens — **"Desi Vernacular Pop"** (LOCKED).
///
/// A 1:1 port of the design system's `tokens/colors.css`
/// (`docs/design/BadaBhai Design System/`). This is the single source of
/// truth for colour in the worker app — never hard-code a hex anywhere else;
/// reference these tokens (or the semantic aliases below).
///
/// Truck-art / bazaar-signage energy, made legible:
///  - Vermilion — the brand (sindoor). Logo, highlights, brand moments.
///  - Green     — the action / "go" colour: Apply, verified, ₹/money, consent.
///  - Saffron   — haldi warmth: tags, resume header, kit icons.
///  - Ink       — warm near-black brown. Grounded, earthy text & chrome.
///  - Cream     — warm paper. The page; cards sit on it as crisp white.
class AppColors {
  AppColors._();

  // ---- Vermilion (brand) ----
  static const Color vermilion50 = Color(0xFFFCEAE3);
  static const Color vermilion100 = Color(0xFFF8D0C3);
  static const Color vermilion200 = Color(0xFFF1A78F);
  static const Color vermilion300 = Color(0xFFE97D5E);
  static const Color vermilion400 = Color(0xFFE35636);
  static const Color vermilion500 = Color(0xFFE0371C); // base brand
  static const Color vermilion600 = Color(0xFFC22A12);
  static const Color vermilion700 = Color(0xFF9C220F);
  static const Color vermilion800 = Color(0xFF7B1D11);
  static const Color vermilion900 = Color(0xFF641A10);

  // ---- Saffron (haldi warm) ----
  static const Color saffron50 = Color(0xFFFEF4DD);
  static const Color saffron100 = Color(0xFFFBE3AC);
  static const Color saffron200 = Color(0xFFF8CD6B);
  static const Color saffron300 = Color(0xFFF5B435);
  static const Color saffron400 = Color(0xFFF29D10); // base
  static const Color saffron500 = Color(0xFFE5870A);
  static const Color saffron600 = Color(0xFFC06E08);
  static const Color saffron700 = Color(0xFF965507);

  // ---- Green (go / verified / money) ----
  static const Color green50 = Color(0xFFE5F4ED);
  static const Color green100 = Color(0xFFC2E6D3);
  static const Color green200 = Color(0xFF8FD0AE);
  static const Color green300 = Color(0xFF52B384);
  static const Color green500 = Color(0xFF0E7A4F); // base
  static const Color green600 = Color(0xFF0A6341);
  static const Color green700 = Color(0xFF084D33);

  // ---- Rani pink (festive accent) ----
  static const Color pink50 = Color(0xFFFBE7F0);
  static const Color pink100 = Color(0xFFF4C2D9);
  static const Color pink500 = Color(0xFFC2186A);
  static const Color pink600 = Color(0xFFA01357);

  // ---- Turquoise (festive / info) ----
  static const Color teal50 = Color(0xFFE2F3F3);
  static const Color teal100 = Color(0xFFBEE5E5);
  static const Color teal500 = Color(0xFF0E8488);
  static const Color teal600 = Color(0xFF0A6A6E);
  static const Color teal700 = Color(0xFF08565A);

  // ---- Crimson (danger, distinct from brand) ----
  static const Color red50 = Color(0xFFFCE9EB);
  static const Color red100 = Color(0xFFF7CBD0);
  static const Color red300 = Color(0xFFE5808B);
  static const Color red500 = Color(0xFFC8142C);
  static const Color red600 = Color(0xFFA50F23);
  static const Color red700 = Color(0xFF820B1B);

  // ---- Ink (warm brown neutrals) ----
  static const Color ink950 = Color(0xFF1C1108);
  static const Color ink900 = Color(0xFF2A1A0E);
  static const Color ink800 = Color(0xFF3D2A1A);
  static const Color ink700 = Color(0xFF523A26);
  static const Color ink600 = Color(0xFF6E5238);
  static const Color ink500 = Color(0xFF8E7252);
  static const Color ink400 = Color(0xFFB29977);
  static const Color ink300 = Color(0xFFD3BF9F);
  static const Color ink200 = Color(0xFFE7D9C2);
  static const Color ink100 = Color(0xFFF1E7D5);
  static const Color ink50 = Color(0xFFF8F1E4);

  // ---- Cream / paper (warm surfaces) ----
  static const Color paper0 = Color(0xFFFFFFFF);
  static const Color paper1 = Color(0xFFFFFDF8);
  static const Color paper2 = Color(0xFFFFF6E8); // page — warm cream
  static const Color paper3 = Color(0xFFFBEAD0); // sunken
  static const Color paper4 = Color(0xFFF4DEBE);

  // ============================================================
  // SEMANTIC ALIASES — reference these in widgets/theme.
  // ============================================================

  // text
  static const Color textPrimary = ink900;
  static const Color textSecondary = ink600;
  static const Color textMuted = ink500;
  static const Color textFaint = ink400;
  static const Color textInverse = paper1;
  static const Color textBrand = vermilion700;
  static const Color textOnBrand = Color(0xFFFFFFFF);
  static const Color textLink = green600;

  // surfaces
  static const Color surfacePage = paper2;
  static const Color surfaceCard = paper0;
  static const Color surfaceRaised = paper1;
  static const Color surfaceSunken = paper3;
  static const Color surfaceInset = paper4;
  static const Color surfaceInk = ink900;
  static const Color surfaceInk2 = ink800;

  // brand (vermilion)
  static const Color brand = vermilion500;
  static const Color brandHover = vermilion600;
  static const Color brandPress = vermilion700;
  static const Color brandTint = vermilion50;
  static const Color brandTint2 = vermilion100;
  static const Color brandBorder = vermilion200;

  // festive accents
  static const Color saffron = saffron400;
  static const Color saffronDeep = saffron600;
  static const Color pink = pink500;
  static const Color teal = teal500;

  // status
  /// The action / "go" colour. Primary worker CTAs (Apply, Continue, consent)
  /// are green — see the Android build kit.
  static const Color success = green500;
  static const Color successPress = green600;
  static const Color successTint = green50;
  static const Color danger = red500;
  static const Color dangerPress = red600;
  static const Color dangerTint = red50;
  static const Color warning = saffron600;
  static const Color warningTint = saffron50;
  static const Color info = teal500;
  static const Color infoTint = teal50;

  // lines & dividers (ink at low alpha — warm hairlines, never grey)
  static const Color borderSubtle = Color(0x1A2A1A0E); // rgba(42,26,14,.10)
  static const Color borderDefault = Color(0x262A1A0E); // .15
  static const Color borderStrong = Color(0x422A1A0E); // .26
  static const Color borderInk = ink800;
  static const Color divider = Color(0x172A1A0E); // .09

  // focus ring (vermilion, never browser blue)
  static const Color ring = Color(0x6BE0371C); // rgba(224,55,28,.42)

  // scrim
  static const Color scrim = Color(0x8F1C1108); // rgba(28,17,8,.56)

  /// Festive-motif border colours (dashed-green + double-vermilion) used on
  /// hero cards — job card, resume header, form pop-up.
  static const Color borderFestive = green500;
  static const Color borderDouble = vermilion500;
}
