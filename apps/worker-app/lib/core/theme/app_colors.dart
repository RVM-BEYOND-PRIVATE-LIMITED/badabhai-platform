import 'package:flutter/material.dart';

import 'onboarding_theme.dart';

/// BadaBhai colour tokens — **LEGACY FACADE over UI kit v3**.
///
/// [OnboardingColors] is the canonical v3 token layer (spec §1.1). This class
/// is kept so the ~66 files that import it still compile: every token NAME is
/// preserved, and every VALUE is re-pointed to its v3 equivalent. So a screen
/// nobody has migrated yet (voice_form, any missed call site) renders in v3
/// colours on day one instead of drifting to the dead JUL31 "Josh" palette.
///
/// **New code must import [OnboardingColors], not this class.**
///
/// ── TWO NAMES WHOSE *ROLE* SURVIVED, NOT THEIR HEX ──────────────────────────
///
/// These are the only two places where a name here and the same name in the
/// spec mean different hexes. Resolved by documentation on purpose: mechanically
/// renaming them would have edited 43 call sites owned by other packages to fix
/// a naming collision that changes nothing on screen.
///
///  - [haldi] means **"the CTA yellow"** → #FFB32C (`safetyYellow`).
///    The spec's own `haldi` (#FFC400, an alternate bright yellow) lives at
///    [OnboardingColors.haldi] and is NOT this.
///  - [borderSubtle] means **"the default 1px outline"** → #D8DEE9
///    (`borderDefault`), and deliberately does NOT move to the spec's
///    `borderSubtle` hairline #E2E8F0 — that hex is [divider] / [ink100] here.
///
/// ── THE PALETTE ─────────────────────────────────────────────────────────────
///
///  - Safety yellow — the hero. Primary CTAs, selected state, rails.
///                    Text on yellow is ALWAYS shift blue.
///  - Shift blue    — structure, trust, headers, links, dark surfaces.
///  - Green         — success / money / WhatsApp (never decorative).
///  - Ink           — cool near-black text on a #F2F4F8 canvas; white cards.
///  - Border        — #D8DEE9 hairlines are the ONLY separation tool (no shadows).
///
/// `test/core/theme/token_parity_test.dart` asserts that every member below is
/// either exactly a v3 token or a documented v3 tint.
class AppColors {
  AppColors._();

  // ============================================================
  // BASE — re-pointed to UI kit v3 (§1.1).
  // ============================================================

  /// The CTA yellow (v3 `safetyYellow`). See the class doc: this is #FFB32C,
  /// not the spec's `haldi`.
  static const Color haldi = OnboardingColors.safetyYellow;
  static const Color haldiPressed = OnboardingColors.safetyYellowDark;

  /// The selected-card wash (v3 `selectedCardBg`).
  static const Color haldiTint = OnboardingColors.selectedCardBg;
  static const Color blue = OnboardingColors.shiftBlue;
  static const Color bluePressed = OnboardingColors.shiftBlueLight;

  /// Incoming-chat tint — now the v3 informational disc (#EFF6FF).
  static const Color blueTintChat = OnboardingColors.infoBg;

  /// The worker's own chat bubble. v3 fills it with the full [blue] and white
  /// text, so the old faded mid-blue is gone.
  static const Color blueChatOut = OnboardingColors.shiftBlue;
  static const Color onHaldi = blue; // text on yellow is ALWAYS shift blue
  static const Color onBlue = OnboardingColors.textOnBlue;
  static const Color onBlueMuted = OnboardingColors.textOnBlueMuted;
  static const Color canvas = OnboardingColors.canvasBg;
  static const Color paper = OnboardingColors.paperWhite;
  static const Color disabled = OnboardingColors.disabledBg;
  static const Color greenTint = OnboardingColors.successBg;
  static const Color greenTintBorder = OnboardingColors.successBorder;

  // ---- Vermilion (dead brand name) — folded onto the SAFETY YELLOW ramp ----
  // Only `vermilion500` has a v3 equivalent (the CTA yellow). The rest are
  // legacy ramp steps with no spec counterpart, kept so call sites compile and
  // shaded around the new base.
  static const Color vermilion50 = Color(0xFFFFF8EB);
  static const Color vermilion100 = Color(0xFFFFEFCC);
  static const Color vermilion200 = Color(0xFFFFDE99);
  static const Color vermilion300 = Color(0xFFFFCD66);
  static const Color vermilion400 = Color(0xFFFFC04A);
  static const Color vermilion500 = OnboardingColors.safetyYellow; // base
  static const Color vermilion600 = OnboardingColors.safetyYellowDark;
  static const Color vermilion700 = Color(0xFFBD8119);
  static const Color vermilion800 = Color(0xFF9C6A14);
  static const Color vermilion900 = Color(0xFF7D550F);

  // ---- Saffron (dead brand name) — same ramp as above ----
  static const Color saffron50 = Color(0xFFFFF8EB);
  static const Color saffron100 = Color(0xFFFFEFCC);
  static const Color saffron200 = Color(0xFFFFDE99);
  static const Color saffron300 = Color(0xFFFFCD66);
  static const Color saffron400 = OnboardingColors.safetyYellow; // base
  static const Color saffron500 = Color(0xFFF0A522);
  static const Color saffron600 = OnboardingColors.safetyYellowDark;
  static const Color saffron700 = Color(0xFFBD8119);

  // ---- Green (success / money / WhatsApp) ----
  static const Color green50 = OnboardingColors.successBg;
  static const Color green100 = OnboardingColors.successBorder;
  static const Color green200 = Color(0xFF4ADE80);
  static const Color green300 = Color(0xFF22C55E);
  static const Color green500 = OnboardingColors.successGreen; // base
  static const Color green600 = Color(0xFF145C2D); // pressed — no v3 equivalent
  static const Color green700 = Color(0xFF0F4623);

  // ---- Rani pink — NOT in v3, folded to SHIFT BLUE ----
  static const Color pink50 = OnboardingColors.shiftBlue;
  static const Color pink100 = OnboardingColors.shiftBlue;
  static const Color pink500 = OnboardingColors.shiftBlue;
  static const Color pink600 = OnboardingColors.shiftBlue;

  // ---- Turquoise — NOT in v3, folded to SHIFT BLUE ----
  static const Color teal50 = OnboardingColors.shiftBlue;
  static const Color teal100 = OnboardingColors.shiftBlue;
  static const Color teal500 = OnboardingColors.shiftBlue;
  static const Color teal600 = OnboardingColors.shiftBlue;
  static const Color teal700 = OnboardingColors.shiftBlue;

  // ---- Crimson (danger — failure only) ----
  static const Color red50 = OnboardingColors.errorBg;
  static const Color red100 = Color(0xFFFECACA);
  static const Color red300 = Color(0xFFEF6A6A);
  static const Color red500 = OnboardingColors.errorRed; // base
  static const Color red600 = Color(0xFFA21F1F); // pressed — no v3 equivalent
  static const Color red700 = Color(0xFF7F1818);

  // ---- Ink — the v3 cool neutral text ramp ----
  static const Color ink950 = Color(0xFF0A0E18); // deepest — no v3 equivalent
  static const Color ink900 = OnboardingColors.ink900; // primary text
  static const Color ink800 = Color(0xFF232D42); // legacy step
  static const Color ink700 = Color(0xFF333E58); // legacy step
  static const Color ink600 = OnboardingColors.ink600; // secondary text
  static const Color ink550 = OnboardingColors.ink500; // v3 muted / placeholder
  // The legacy ramp's "muted text" step, pointed at the v3 muted ink — the
  // SAME token as [ink550], not `disabledText`. A name that means one hex here
  // and another in [OnboardingColors] is exactly the collision the class doc
  // says there are only two of, and this one buys nothing: no call site reads
  // it (the app uses `OnboardingColors.ink500` directly).
  static const Color ink500 = OnboardingColors.ink500; // v3 muted
  static const Color ink400 = Color(0xFFA8AFBF); // legacy step
  static const Color ink300 = OnboardingColors.disabledBg; // disabled
  static const Color ink200 = OnboardingColors.borderDefault; // outline
  static const Color ink100 = OnboardingColors.borderSubtle; // hairline
  static const Color ink50 = OnboardingColors.canvasBg; // canvas

  // ---- Paper / canvas ----
  static const Color paper0 = OnboardingColors.paperWhite;
  static const Color paper1 = OnboardingColors.paperWhite;
  static const Color paper2 = OnboardingColors.canvasBg; // page
  static const Color paper3 = OnboardingColors.pillMutedBg; // sunken
  static const Color paper4 = OnboardingColors.pillMutedBg; // inset

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
  static const Color textOnBrand = blue; // text on yellow is ALWAYS shift blue
  static const Color textLink = blue;

  // surfaces
  static const Color surfacePage = paper2; // canvas
  static const Color surfaceCard = paper0; // white
  static const Color surfaceRaised = paper1; // white
  static const Color surfaceSunken = paper3;
  static const Color surfaceInset = paper4;
  static const Color surfaceInk = blue;
  static const Color surfaceInk2 = bluePressed;

  // brand (the CTA yellow)
  static const Color brand = haldi;
  static const Color brandHover = haldi;
  static const Color brandPress = haldiPressed;
  static const Color brandTint = haldiTint;

  /// Safety yellow at 20% — a tonal fill / a pill on navy (v3 `yellowTint20`).
  static const Color brandTint2 = OnboardingColors.yellowTint20;

  /// A yellow-edged hairline. No v3 equivalent; kept for its one call site.
  static const Color brandBorder = Color(0xFFE7C34A);

  // festive accents (dead names, folded onto the live palette)
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
  /// The default 1px OUTLINE (#D8DEE9). See the class doc: this is v3
  /// `borderDefault`, not v3 `borderSubtle`.
  static const Color borderSubtle = OnboardingColors.borderDefault;
  static const Color borderDefault = OnboardingColors.borderDefault;
  static const Color borderStrong = OnboardingColors.borderDefault;
  static const Color borderInk = blue;

  /// The hairline BETWEEN rows (#E2E8F0) — v3 `borderSubtle`.
  static const Color divider = OnboardingColors.borderSubtle;

  /// Focus ring — safety yellow at ~42%. Yellow is the SELECTED state; a
  /// focused input rings in [blue] 1.8 instead (spec §3.3).
  static const Color ring = Color(0x6BFFB32C);

  /// The modal scrim — shift blue at 56% (v3 `scrim`).
  static const Color scrim = OnboardingColors.scrim;

  /// Accent border colours used on hero cards (green rail + yellow rail).
  static const Color borderFestive = green500;
  static const Color borderDouble = haldi;
}
