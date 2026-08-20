import 'package:flutter/material.dart';

/// BadaBhai colour tokens — **JUL31 "JOSH" system** (LOCKED 2026-07-27).
///
/// Values re-pointed to the CEO-approved Haldi-yellow + Deep-blue palette
/// (`docs/design/BadaBhai_AppDesign_JUL31/.../tokens.dart`). The **token
/// NAMES are preserved** so every widget/screen keeps compiling — only the
/// underlying hex values moved. This stays the single source of truth for
/// colour; never hard-code a hex in a widget, reference these tokens.
///
///  - **Haldi** #FFC400 — the hero. Primary CTAs, highlights, rails (ONE per
///    screen). Text on haldi is ALWAYS deep blue.
///  - **Blue**  #123D8C — structure, trust, headers, links, dark surfaces.
///  - **Green** #1E7A3C — success / money / WhatsApp only.
///  - **Red**   #C62828 — failure only.
///  - **Ink**   #101828 → #475069 → #8A92A6 — neutral slate text ramp.
///  - **Canvas** #F2F4F8 page / **Paper** #FFFFFF cards; separated by 1px
///    #D8DEE9 hairlines — the only separation tool (elevation is always 0).
class AppColors {
  AppColors._();

  // ============================================================
  // JUL31 base palette (the LOCKED tokens — reference these first).
  // ============================================================
  static const Color haldi = Color(0xFFFFC400); // hero — CTAs, highlights, rails
  static const Color haldiPressed = Color(0xFFE0AC00);
  static const Color haldiTint = Color(0xFFFFF3CC); // soft warning/brand tint
  static const Color onHaldi = Color(0xFF123D8C); // text on yellow = deep blue

  static const Color blue = Color(0xFF123D8C); // structure, trust, headers, links
  static const Color bluePressed = Color(0xFF0D2D68);
  static const Color blueTintChat = Color(0xFFE9F0FB); // outgoing chat / info tint
  static const Color onBlue = Color(0xFFFFFFFF);
  static const Color onBlueMuted = Color(0xFFB9C8E6);

  static const Color canvas = Color(0xFFF2F4F8); // page background
  static const Color paper = Color(0xFFFFFFFF); // cards
  static const Color border = Color(0xFFD8DEE9); // 1px hairline — only separator
  static const Color borderLight = Color(0xFFEDF0F5);

  static const Color green = Color(0xFF1E7A3C); // success, money, WhatsApp
  static const Color greenTint = Color(0xFFE9F5EC);
  static const Color greenTintBorder = Color(0xFFCFE5D6);
  static const Color red = Color(0xFFC62828); // failure ONLY
  static const Color disabled = Color(0xFFC5CEDF);

  // ============================================================
  // Raw scale names — KEPT for compat, re-pointed to the nearest new value
  // (vermilion → haldi ramp, saffron → haldi ramp, warm ink → neutral slate,
  //  cream paper → canvas/white, pink/teal → blue). Anything referencing a raw
  //  name inherits the new look.
  // ============================================================

  // ---- Vermilion (brand) → Haldi ramp ----
  static const Color vermilion50 = Color(0xFFFFF9E0);
  static const Color vermilion100 = Color(0xFFFFF3CC);
  static const Color vermilion200 = Color(0xFFFFE99A);
  static const Color vermilion300 = Color(0xFFFFDD66);
  static const Color vermilion400 = Color(0xFFFFD033);
  static const Color vermilion500 = Color(0xFFFFC400); // haldi base
  static const Color vermilion600 = Color(0xFFE0AC00); // haldi pressed
  static const Color vermilion700 = Color(0xFFC29500);
  static const Color vermilion800 = Color(0xFFA37E00);
  static const Color vermilion900 = Color(0xFF856600);

  // ---- Saffron (haldi warm) → Haldi ramp ----
  static const Color saffron50 = Color(0xFFFFF3CC);
  static const Color saffron100 = Color(0xFFFFE99A);
  static const Color saffron200 = Color(0xFFFFDD66);
  static const Color saffron300 = Color(0xFFFFD033);
  static const Color saffron400 = Color(0xFFFFC400); // haldi base
  static const Color saffron500 = Color(0xFFEBB800);
  static const Color saffron600 = Color(0xFFE0AC00); // haldi pressed
  static const Color saffron700 = Color(0xFFC29500);

  // ---- Green (go / verified / money) — new green ramp ----
  static const Color green50 = Color(0xFFE9F5EC);
  static const Color green100 = Color(0xFFCFE5D6);
  static const Color green200 = Color(0xFFA7D0B4);
  static const Color green300 = Color(0xFF6FB588);
  static const Color green500 = Color(0xFF1E7A3C); // base
  static const Color green600 = Color(0xFF145C2D); // success pressed
  static const Color green700 = Color(0xFF0F4A24);

  // ---- Rani pink (not in the system) → fold to Blue ----
  static const Color pink50 = Color(0xFFE9F0FB);
  static const Color pink100 = Color(0xFFB9C8E6);
  static const Color pink500 = Color(0xFF123D8C);
  static const Color pink600 = Color(0xFF0D2D68);

  // ---- Turquoise (not in the system) → fold to Blue ----
  static const Color teal50 = Color(0xFFE9F0FB);
  static const Color teal100 = Color(0xFFB9C8E6);
  static const Color teal500 = Color(0xFF123D8C);
  static const Color teal600 = Color(0xFF0D2D68);
  static const Color teal700 = Color(0xFF0D2D68);

  // ---- Crimson (danger) — new red ramp ----
  static const Color red50 = Color(0xFFFBEAEA);
  static const Color red100 = Color(0xFFF5D0D0);
  static const Color red300 = Color(0xFFE08A8A);
  static const Color red500 = Color(0xFFC62828); // base
  static const Color red600 = Color(0xFFA21F1F); // danger pressed
  static const Color red700 = Color(0xFF841A1A);

  // ---- Ink → neutral slate ramp (#101828 → #475069 → #8A92A6) ----
  static const Color ink950 = Color(0xFF0B0F1A);
  static const Color ink900 = Color(0xFF101828); // primary text
  static const Color ink800 = Color(0xFF1C2536);
  static const Color ink700 = Color(0xFF313A4D);
  static const Color ink600 = Color(0xFF475069); // secondary text
  static const Color ink500 = Color(0xFF8A92A6); // muted text
  static const Color ink400 = Color(0xFFA8AFBF);
  static const Color ink300 = Color(0xFFC5CEDF); // disabled
  static const Color ink200 = Color(0xFFD8DEE9); // border
  static const Color ink100 = Color(0xFFEDF0F5); // border light
  static const Color ink50 = Color(0xFFF2F4F8); // canvas

  // ---- Cream / paper → Canvas + white ----
  static const Color paper0 = Color(0xFFFFFFFF);
  static const Color paper1 = Color(0xFFFFFFFF);
  static const Color paper2 = Color(0xFFF2F4F8); // page — canvas
  static const Color paper3 = Color(0xFFEDF0F5); // sunken
  static const Color paper4 = Color(0xFFEDF0F5); // inset

  // ============================================================
  // SEMANTIC ALIASES — reference these in widgets/theme.
  // ============================================================

  // text
  static const Color textPrimary = ink900; // #101828
  static const Color textSecondary = ink600; // #475069
  // #1084 — ink500 (#8A92A6) is only ~3.1:1 on the paper canvas, failing WCAG AA
  // for body text. Muted/faint TEXT roles repoint to #667085 (payer-web's proven
  // --ink-500), which clears 4.5:1 while staying distinct from textSecondary
  // (#475069). ink500 itself is untouched — it keeps its decorative/border roles.
  static const Color textMuted = Color(0xFF667085);
  static const Color textFaint = Color(0xFF667085);
  static const Color textInverse = paper0; // white
  static const Color textBrand = blue; // #123D8C
  static const Color textOnBrand = blue; // #123D8C — text on haldi is deep blue
  static const Color textLink = blue; // #123D8C

  // surfaces
  static const Color surfacePage = paper2; // canvas #F2F4F8
  static const Color surfaceCard = paper0; // white
  static const Color surfaceRaised = paper1; // white
  static const Color surfaceSunken = paper3; // #EDF0F5
  static const Color surfaceInset = paper4; // #EDF0F5
  static const Color surfaceInk = blue; // #123D8C dark surface
  static const Color surfaceInk2 = bluePressed; // #0D2D68

  // brand (haldi)
  static const Color brand = haldi;
  static const Color brandHover = haldi;
  static const Color brandPress = haldiPressed;
  static const Color brandTint = haldiTint; // #FFF3CC
  static const Color brandTint2 = Color(0xFFFFE99A);
  static const Color brandBorder = Color(0xFFE7C34A);

  // festive accents (pink/teal are not in the system → fold to blue)
  static const Color saffron = haldi;
  static const Color saffronDeep = haldiPressed;
  static const Color pink = blue;
  static const Color teal = blue;

  // status
  /// The action / "go" colour. Success, money, WhatsApp — see the design system.
  static const Color success = green; // #1E7A3C
  static const Color successPress = green600; // #145C2D
  static const Color successTint = green50; // #E9F5EC
  static const Color danger = red; // #C62828
  static const Color dangerPress = red600; // #A21F1F
  static const Color dangerTint = red50; // #FBEAEA
  static const Color warning = haldi;
  static const Color warningTint = haldiTint;
  static const Color info = blue;
  static const Color infoTint = blueTintChat; // #E9F0FB

  // lines & dividers (solid #D8DEE9 hairlines — the only separation tool)
  static const Color borderSubtle = border; // #D8DEE9
  static const Color borderDefault = border; // #D8DEE9
  static const Color borderStrong = border; // #D8DEE9
  static const Color borderInk = blue;
  static const Color divider = borderLight; // #EDF0F5

  // focus ring (haldi @ ~42%, never browser blue)
  static const Color ring = Color(0x6BFFC400);

  // scrim (deep-blue)
  static const Color scrim = Color(0x8F0D1B3A);

  /// Motif border colours — festive (green) + double (haldi) — used on hero
  /// cards (job card, resume header, form pop-up).
  static const Color borderFestive = green;
  static const Color borderDouble = haldi;
}
