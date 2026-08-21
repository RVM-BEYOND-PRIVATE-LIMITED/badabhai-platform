import 'package:flutter/material.dart';

/// BadaBhai colour tokens — **"Josh" system** (LOCKED 2026-07-27).
///
/// Values are repointed to the JUL31 CEO-approved palette — **Haldi yellow +
/// Deep blue** on a cool paper canvas — while every token NAME is preserved so
/// the whole app re-skins through this shared layer. This is the single source
/// of truth for colour in the worker app — never hard-code a hex anywhere else;
/// reference these tokens (or the semantic aliases below).
///
///  - Haldi  — the hero. Primary CTAs, highlights, rails (one per screen).
///             Text on haldi is ALWAYS deep blue.
///  - Blue   — structure, trust, headers, links, dark surfaces.
///  - Green  — success / money / WhatsApp (never decorative).
///  - Ink    — cool near-black text on a #F2F4F8 canvas; white cards.
///  - Border — #D8DEE9 hairlines are the ONLY separation tool (no shadows).
class AppColors {
  AppColors._();

  // ============================================================
  // NEW BASE — JUL31 "Josh" system (LOCKED 2026-07-27).
  // ============================================================
  static const Color haldi = Color(0xFFFFC400); // hero — CTAs, highlights, rails
  static const Color haldiPressed = Color(0xFFE0AC00);
  static const Color haldiTint = Color(0xFFFFF3CC); // soft haldi wash
  static const Color blue = Color(0xFF123D8C); // structure, trust, links
  static const Color bluePressed = Color(0xFF0D2D68);
  static const Color blueTintChat = Color(0xFFE9F0FB); // outgoing chat bubble (legacy tint)
  // Outgoing (worker) chat bubble — a FADED theme blue that carries WHITE text
  // (~5.7:1 contrast). Softer than the deep header [blue] so the two don't merge.
  static const Color blueChatOut = Color(0xFF3E64B0);
  static const Color onHaldi = blue; // text on yellow is ALWAYS deep blue
  static const Color onBlue = Color(0xFFFFFFFF);
  static const Color onBlueMuted = Color(0xFFB9C8E6);
  static const Color canvas = Color(0xFFF2F4F8); // page background
  static const Color paper = Color(0xFFFFFFFF); // cards
  static const Color disabled = Color(0xFFC5CEDF);
  static const Color greenTint = Color(0xFFE9F5EC);
  static const Color greenTintBorder = Color(0xFFCFE5D6);

  // ---- Vermilion (brand) — repointed to the HALDI ramp ----
  static const Color vermilion50 = Color(0xFFFFF9E5);
  static const Color vermilion100 = Color(0xFFFFF0B8);
  static const Color vermilion200 = Color(0xFFFFE380);
  static const Color vermilion300 = Color(0xFFFFD54D);
  static const Color vermilion400 = Color(0xFFFFCB26);
  static const Color vermilion500 = Color(0xFFFFC400); // base brand = haldi
  static const Color vermilion600 = Color(0xFFE0AC00);
  static const Color vermilion700 = Color(0xFFBD9000);
  static const Color vermilion800 = Color(0xFF9C7800);
  static const Color vermilion900 = Color(0xFF7D6000);

  // ---- Saffron (haldi warm) — folded into the haldi ramp ----
  static const Color saffron50 = Color(0xFFFFF3CC);
  static const Color saffron100 = Color(0xFFFFE99A);
  static const Color saffron200 = Color(0xFFFFDD66);
  static const Color saffron300 = Color(0xFFFFD23D);
  static const Color saffron400 = Color(0xFFFFC400); // base = haldi
  static const Color saffron500 = Color(0xFFEDB600);
  static const Color saffron600 = Color(0xFFE0AC00);
  static const Color saffron700 = Color(0xFFB88E00);

  // ---- Green (success / money / WhatsApp) ----
  static const Color green50 = Color(0xFFE9F5EC);
  static const Color green100 = Color(0xFFCFE5D6);
  static const Color green200 = Color(0xFFA6D0B4);
  static const Color green300 = Color(0xFF5FA877);
  static const Color green500 = Color(0xFF1E7A3C); // base
  static const Color green600 = Color(0xFF145C2D);
  static const Color green700 = Color(0xFF0F4623);

  // ---- Rani pink — NOT in the Josh system, folded to BLUE ----
  static const Color pink50 = Color(0xFFE9F0FB);
  static const Color pink100 = Color(0xFFC9D8F0);
  static const Color pink500 = Color(0xFF123D8C);
  static const Color pink600 = Color(0xFF0D2D68);

  // ---- Turquoise — NOT in the Josh system, folded to BLUE ----
  static const Color teal50 = Color(0xFFE9F0FB);
  static const Color teal100 = Color(0xFFC9D8F0);
  static const Color teal500 = Color(0xFF123D8C);
  static const Color teal600 = Color(0xFF0D2D68);
  static const Color teal700 = Color(0xFF0A2352);

  // ---- Crimson (danger — failure only) ----
  static const Color red50 = Color(0xFFFBEAEA);
  static const Color red100 = Color(0xFFF5CFCF);
  static const Color red300 = Color(0xFFE08A8A);
  static const Color red500 = Color(0xFFC62828);
  static const Color red600 = Color(0xFFA21F1F);
  static const Color red700 = Color(0xFF7F1818);

  // ---- Ink — repointed to the cool NEUTRAL text ramp ----
  static const Color ink950 = Color(0xFF0A0E18);
  static const Color ink900 = Color(0xFF101828); // primary text
  static const Color ink800 = Color(0xFF232D42);
  static const Color ink700 = Color(0xFF333E58);
  static const Color ink600 = Color(0xFF475069); // secondary text
  static const Color ink550 = Color(0xFF667085); // muted text — AA ~4.95:1 on white
  static const Color ink500 = Color(0xFF8A92A6); // muted text
  static const Color ink400 = Color(0xFFA8AFBF);
  static const Color ink300 = Color(0xFFC5CEDF); // disabled
  static const Color ink200 = Color(0xFFD8DEE9); // border
  static const Color ink100 = Color(0xFFEDF0F5); // border light
  static const Color ink50 = Color(0xFFF2F4F8); // canvas

  // ---- Paper / canvas ----
  static const Color paper0 = Color(0xFFFFFFFF);
  static const Color paper1 = Color(0xFFFFFFFF);
  static const Color paper2 = Color(0xFFF2F4F8); // page — cool canvas
  static const Color paper3 = Color(0xFFEDF0F5); // sunken
  static const Color paper4 = Color(0xFFEDF0F5); // inset

  // ============================================================
  // SEMANTIC ALIASES — reference these in widgets/theme.
  // ============================================================

  // text
  static const Color textPrimary = ink900;
  static const Color textSecondary = ink600;
  static const Color textMuted = ink550;
  static const Color textFaint = ink550;
  static const Color textInverse = paper1;
  static const Color textBrand = blue;
  static const Color textOnBrand = blue; // text on haldi is ALWAYS deep blue
  static const Color textLink = blue;

  // surfaces
  static const Color surfacePage = paper2; // canvas
  static const Color surfaceCard = paper0; // white
  static const Color surfaceRaised = paper1; // white
  static const Color surfaceSunken = paper3;
  static const Color surfaceInset = paper4;
  static const Color surfaceInk = blue;
  static const Color surfaceInk2 = bluePressed;

  // brand (haldi)
  static const Color brand = haldi;
  static const Color brandHover = haldi;
  static const Color brandPress = haldiPressed;
  static const Color brandTint = haldiTint;
  static const Color brandTint2 = Color(0xFFFFE99A);
  static const Color brandBorder = Color(0xFFE7C34A);

  // festive accents
  static const Color saffron = haldi;
  static const Color saffronDeep = haldiPressed;
  static const Color pink = blue;
  static const Color teal = blue;

  // status
  /// Success / money / WhatsApp — green (never a primary CTA).
  static const Color success = green500;
  static const Color successPress = green600;
  static const Color successTint = green50;
  static const Color danger = red500;
  static const Color dangerPress = red600;
  static const Color dangerTint = red50;
  static const Color warning = haldi;
  static const Color warningTint = haldiTint;
  static const Color info = blue;
  static const Color infoTint = blueTintChat;

  // lines & dividers — solid cool hairlines (the ONLY separation tool)
  static const Color borderSubtle = Color(0xFFD8DEE9);
  static const Color borderDefault = Color(0xFFD8DEE9);
  static const Color borderStrong = Color(0xFFD8DEE9);
  static const Color borderInk = blue;
  static const Color divider = Color(0xFFEDF0F5);

  // focus ring (haldi @ ~42%)
  static const Color ring = Color(0x6BFFC400);

  // scrim (deep-blue)
  static const Color scrim = Color(0x8F0D1B3A);

  /// Accent border colours used on hero cards (green rail + haldi rail).
  static const Color borderFestive = green500;
  static const Color borderDouble = haldi;
}
