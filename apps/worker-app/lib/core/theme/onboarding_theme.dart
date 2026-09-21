import 'package:flutter/material.dart';

/// **The app-wide v3 token layer.** Source: `ui_kit_v3_spec.md` §1.1 / §1.2.
///
/// ── NO LONGER SCOPED ────────────────────────────────────────────────────────
///
/// This file used to carry a "SCOPED ON PURPOSE — not a re-skin" warning: it
/// was the onboarding flow's private palette, and the rest of the app stayed on
/// the JUL31 "Josh" [AppColors] / [AppTypography]. **That is no longer true.**
/// UI kit v3 applies to the WHOLE worker app, so these classes are now the
/// canonical token layer and the one place a colour, radius or type style is
/// defined.
///
/// New code and every migrated screen import ONLY these, plus
/// `lib/core/widgets/kit/*` and the restyled `Bb*` widgets.
///
/// [AppColors] / [AppTypography] survive as a LEGACY FACADE: every member name
/// is kept (so the ~120 files importing them still compile) with its VALUE
/// re-pointed here. They are not deleted and not mass-renamed — see the role
/// notes in `app_colors.dart`, which explain the two names whose *role* meaning
/// differs from the spec's name for the same hex (`AppColors.haldi` is the CTA
/// yellow #FFB32C, not the spec's `haldi` #FFC400; `AppColors.borderSubtle` is
/// the default 1px outline #D8DEE9, not the spec's hairline #E2E8F0).
///
/// ── THE SPEC'S VALUES ARE COPIED, NOT APPROXIMATED ──────────────────────────
///
/// Names and hexes mirror §1.1 one-for-one so a reviewer can diff this file
/// against the document, and `test/core/theme/token_parity_test.dart` asserts
/// exactly that, hex by hex. Where the kit's own prose and its "Exact Dart
/// Widget" code disagree (the privacy shield circle: prose `#E0E7FF`, code
/// `#EFF6FF`), the CODE value is used and the literal is named below.
class OnboardingColors {
  OnboardingColors._();

  // Brand core
  static const Color shiftBlue = Color(0xFF05194C); // header + brand deep navy
  static const Color shiftBlueLight = Color(0xFF0A256E); // active item borders
  static const Color shiftBlueSurface = Color(0xFF0F2B7A); // pill on navy
  static const Color blueThemeDark = Color(0xFF05194C); // checkbox filled bg
  static const Color safetyYellow = Color(0xFFFFB32C); // hero CTA yellow
  static const Color safetyYellowDark = Color(0xFFE09A1F); // pressed yellow
  static const Color haldi = Color(0xFFFFC400); // alternate bright yellow

  // Surfaces
  static const Color canvasBg = Color(0xFFF2F4F8);
  static const Color canvasIvory = Color(0xFFF3F5F4);
  static const Color paperWhite = Color(0xFFFFFFFF);
  static const Color chipBg = Color(0xFFF8FAFC); // subtle pill / input bg

  /// The spec's own name for [chipBg] (§1.1 `surfaceMuted`) — input and pill
  /// backgrounds. Same hex; both names are kept so a reviewer can find either.
  static const Color surfaceMuted = chipBg;

  /// A full-width check row's fill (spec §4, the controllers list).
  static const Color rowBg = Color(0xFFF8FAFC);

  /// A neutral count / status pill's fill (spec §4 '7 Verified', 'DRAFT').
  static const Color pillMutedBg = Color(0xFFF1F5F9);

  // Borders
  static const Color borderDefault = Color(0xFFD8DEE9);
  static const Color borderSubtle = Color(0xFFE2E8F0);
  // Master spec v2: focused / selected card border is SAFETY YELLOW (was navy
  // in the 5-screen kit). Every focus ring and selected card reads from here.
  static const Color borderActive = Color(0xFFFFB32C);
  static const Color borderCard = Color(0xFFE5E7EB);

  // Inks
  static const Color ink900 = Color(0xFF101828);
  static const Color ink600 = Color(0xFF475069);
  static const Color ink500 = Color(0xFF667085);
  static const Color textOnBlue = Color(0xFFFFFFFF);
  static const Color textOnBlueMuted = Color(0xFFB9C8E6);
  static const Color textOnYellow = Color(0xFF05194C);

  // Semantic
  static const Color successGreen = Color(0xFF1E7A3C);
  static const Color successBg = Color(0xFFDCFCE7);
  static const Color successBorder = Color(0xFF86EFAC); // salary box hairline
  static const Color errorRed = Color(0xFFC62828);
  static const Color errorBg = Color(0xFFFEE2E2);
  static const Color disabledBg = Color(0xFFC5CEDF);
  static const Color disabledText = Color(0xFF8A9BAD);

  // Informational callout (spec §4 "BLUEPRINTS & GD&T KNOWLEDGE").
  static const Color infoBg = shieldCircle; // #EFF6FF — same disc as §3.5
  static const Color infoBorder = Color(0xFFBFDBFE);
  static const Color infoTitle = Color(0xFF1E3A8A);
  static const Color infoText = Color(0xFF1E40AF);

  /// Safety yellow at 20% — a pill on navy (spec §4 'READY').
  static const Color yellowTint20 = Color(0x33FFB32C);

  /// The modal scrim: [shiftBlue] at 56%. A dialog separates by scrim + fill,
  /// never a shadow.
  static const Color scrim = Color(0x8F05194C);

  /// White at 70% — a subline on the navy status banner (spec §4).
  static const Color textOnBlue70 = Color(0xB3FFFFFF);

  // Screen literals from the kit's widget code, named rather than inlined.
  static const Color shieldCircle = Color(0xFFEFF6FF); // privacy shield disc
  static const Color noteBg = Color(0xFFF8FAFC); // privacy "Dhyaan dein" box
  static const Color selectedCardBg = Color(0xFFFFFBEB); // selected card fill
  static const Color cardIconBg = Color(
    0xFFF1F5F9,
  ); // unselected card icon tile
}

/// Which drawing of a shared kit widget to render.
///
/// The kit's header, docked bar and option cards are shared by the whole
/// resume-creation flow (auth, name, chat, profile preview, building, …) AND
/// the form flow (trade form question + marker pages, finishing pages). The
/// form flow was redrawn from the Workholding (15) / Measuring Instruments (16)
/// / Turning Operations (14) mockups; every other screen keeps the kit's
/// original drawing. So the form flow asks for [formFlow] explicitly and the
/// default stays [standard] — a new caller never repaints by accident.
enum OnboardingVariant { standard, formFlow }

/// Colours the form-flow mockups (14/15/16) use beyond the kit's §1.1 palette.
///
/// Measured off the mockup screenshot, which is Display-P3 shifted: the navy
/// and safety yellow there equal [OnboardingColors.shiftBlue] /
/// [OnboardingColors.safetyYellow] once the shift is undone, so they are NOT
/// redefined here. Only the neutrals that genuinely differ are.
class FormFlowColors {
  FormFlowColors._();

  /// The body behind the option cards.
  static const Color canvas = Color(0xFFF8F9FA);

  /// The header's "STEP n OF m • CATEGORY" line — a neutral light slate, not
  /// the kit's blue-tinted [OnboardingColors.textOnBlueMuted].
  static const Color headerStepLine = Color(0xFFCBD5E1);

  /// The soft shadow the header casts onto the progress strip (6% black at
  /// the edge, fading out over [FormFlowLayout.headerShadowExtent]).
  static const Color headerShadow = Color(0x0F000000);

  /// The progress strip's bottom hairline.
  static const Color stripBorder = Color(0xFFEAEDF2);

  /// The docked bar's top hairline.
  static const Color bottomBarBorder = Color(0xFFEDF0F5);

  /// An unselected option card's hairline. Measured as integrated edge
  /// darkness at the mockup's own scale, frames 16 and 14 read as #D8DEE9 at
  /// 1.2dp; #E2E8F0 read ~30% too light.
  static const Color cardBorder = OnboardingColors.borderDefault;

  /// The option tile's glyph on an unselected card (slate); a selected card's
  /// glyph is navy ([OnboardingColors.shiftBlue]).
  static const Color tileGlyph = Color(0xFF475569);

  /// The question's explanation and an option card's description.
  static const Color whyText = OnboardingColors.ink500;

  /// The decline link's help glyph (lighter than its text) and its hairline.
  static const Color declineIcon = Color(0xFF94A3B8);
  static const Color declineUnderline = OnboardingColors.borderSubtle;

  /// The green "100% complete" pill on the last step (mockup 16).
  static const Color completeBg = Color(0xFFECFDF5);
  static const Color completeText = Color(0xFF047857);
}

/// Geometry of the form-flow mockups (14/15/16), in dp at their 390dp width.
///
/// Measured off the mockup at 0.6718 px/dp (262px frames ÷ 390dp); the
/// fixed-size parts land on round dp values at that scale (card side margins
/// 20, checkbox 24, tile 40, button 52), which is what confirms it. Vertical
/// gaps are set so the rendered INK lands where the mockup's ink does, with the
/// bundled fonts' real metrics — not copied from the mockup's box guesses.
class FormFlowLayout {
  FormFlowLayout._();

  /// Side gutter of the header and the body.
  static const double gutter = 20;

  // ---- header ----
  /// Above the back-arrow row (its centre sits 42dp below the header top,
  /// before the device's own status-bar inset).
  static const double headerTopPadding = 18;
  static const double headerBottomPadding = 25;

  /// Between the back-arrow row and the STEP line.
  static const double headerRowToStepGap = 14;
  static const double headerStepLetterSpacing = 1.5;
  static const double headerShadowExtent = 10;

  // ---- progress strip ----
  static const double stripPaddingTop = 17;
  static const double stripPaddingBottom = 12;
  static const double stripLabelToBarGap = 11;
  static const double progressBarHeight = 7;
  static const double stripLabelLetterSpacing = 1;

  /// The green "100% complete" pill on the last step. Its vertical padding
  /// OVERHANGS the label line rather than growing it (mockup 16: the strip is
  /// no taller on the last step than on any other).
  static const double completePillTextSize = 10.5;
  static const double completePillPaddingH = 8;
  static const double completePillPaddingV = 3;
  static const double completePillRadius = 20;

  // ---- body ----
  static const double bodyPaddingTop = 18;
  static const double headlineToWhyGap = 5;
  static const double whyToHintGap = 7;

  /// From the question's intro (headline / why text) to the first option,
  /// when no hint pill sits between them (mockups 15/16: ~26dp from the why
  /// text's descenders to the first card).
  static const double introToOptionsGap = 21;

  /// From the multi-select hint pill to the first option.
  static const double hintToOptionsGap = 20;

  // ---- hint pill ----
  static const double hintPaddingH = 9.5;
  static const double hintPaddingV = 2.5;
  static const double hintIconSize = 14;
  static const double hintIconGap = 4;
  static const double hintTextSize = 10.2;

  // ---- option card ----
  /// The card content's inset from the card's OUTER edge, selected or not.
  static const double cardInset = 16;
  static const double cardRadius = 14;
  static const double tileSize = 40;
  static const double tileRadius = 8;
  static const double tileGlyphSize = 20;
  static const double tileToTitleGap = 11;
  static const double indicatorSize = 24;
  static const double checkboxRadius = 6;

  // ---- decline link ----
  static const double declineIconSize = 16;
  static const double declineIconGap = 6;

  /// How far the decline link is drawn up into the last card's outer bottom
  /// padding. Its 48dp tap target centres ~17dp of text, which otherwise puts
  /// the text ~31dp below the last card; the mockups put it ~23.5dp below.
  static const double declineLinkLift = 3.5;

  // ---- docked bar ----
  static const double bottomBarPaddingTop = 13.5;
  static const double bottomBarPaddingBottom = 14.5;
  static const double buttonRadius = 16;
  static const double listenWidth = 50;
  static const double listenHeight = 46;
  static const double listenToButtonGap = 12;
  static const double buttonArrowSize = 24;
  static const double buttonArrowGap = 5;
}

/// Corner radii the kit specifies per component. These deliberately exceed
/// [AppRadii]'s hard cap of 12 — the kit asks for 14 on the CTA and inputs and
/// 16 on cards — which is exactly why they live here and not there.
class OnboardingRadii {
  OnboardingRadii._();

  static const double button = 14;
  static const double phoneField = 14;
  static const double pinBox = 14;

  /// Spec §3.3: the OTP cell is a 10, not the 12 the v2 kit drew.
  static const double otpBox = 10;
  static const double nameField = 10;
  static const double card = 16;
  static const double note = 12;

  /// An info / select chip (spec §4).
  static const double chip = 10;

  /// A full-width check row (spec §4).
  static const double row = 10;

  /// A small status pill — 'READY', 'DRAFT' (spec §4).
  static const double pillSm = 4;

  /// A count pill — '7' (spec §4).
  static const double countPill = 12;

  /// A docked bar's button (spec §2.2).
  static const double docked = 12;

  /// Kept at 20: shared by the building, chat and trade-form badges.
  static const double badge = 20;
  static const double feedbackButton = 12;
}

/// Layout rules that make the kit's 390pt design hold on every device.
class OnboardingLayout {
  OnboardingLayout._();

  /// The kit is drawn at ~390pt. On a tablet or a landscape phone the content
  /// column stops here and centres, rather than stretching a 52px CTA across
  /// 1000px of glass. Matches `AppSpacing.appMax`.
  static const double maxContentWidth = 440;

  /// Tab content (Jobs / Resume / Profile lists and cards) is wider than a
  /// form: 600 before it stops and centres. Navy headers and the nav bar stay
  /// full-bleed; only their inner rows cap here.
  static const double maxTabContentWidth = 600;

  /// Chrome (the blue header, CTA labels) honours the worker's font size up to
  /// this factor and no further. Past it, a two-line header at 200% ate 577 of
  /// a 640px screen and left the PIN rows a 63px sliver (measured on the old
  /// header). Body copy is NOT clamped — it scrolls instead — so large-text
  /// users still get large text where it is read.
  static const double chromeMaxTextScale = 1.3;

  static const double buttonHeight = 52;

  /// The button inside a docked bar (spec §2.2) — shorter than the in-body
  /// [buttonHeight] because the bar adds its own padding around it.
  static const double dockedButtonHeight = 48;

  /// The title / action row of a tab header (spec §4). 48 so every action in
  /// it clears the touch floor without a taller band than the artboard's.
  static const double tabHeaderRowHeight = 48;

  /// The worker-app touch floor. The kit draws a 32px back glyph; the TAP area
  /// around it is kept at 48 without moving what is painted.
  static const double tapTarget = 48;
}

/// Type styles from the kit's §1.2.
///
/// ── REAL FONTS, NO NETWORK ──────────────────────────────────────────────────
///
/// The kit names Anek Latin (display) and Inter (body). Both are now BUNDLED as
/// static instances cut from the upstream OFL variable fonts (see
/// `assets/fonts/README.md`), so they render on first launch with no
/// connection — the #350 rule for the OTP and PIN screens, which a worker on
/// 2G used to see reflow under their thumb.
///
/// This class never calls `google_fonts`: [AppTypography] remains the single
/// call site in `lib/`, and runtime fetching stays off app-wide.
///
/// The kit's own fallbacks (Baloo 2, Mukta) are declared as
/// `fontFamilyFallback`, both already bundled, then Noto Sans Devanagari — so a
/// glyph the Latin subset does not carry still renders instead of a tofu box.
class OnboardingTypography {
  OnboardingTypography._();

  static const String displayFamily = 'Anek Latin';
  static const String bodyFamily = 'Inter';
  static const String monoFamily = 'Roboto Mono';

  static const List<String> displayFallback = <String>[
    'Baloo 2',
    'Noto Sans Devanagari',
  ];
  static const List<String> bodyFallback = <String>[
    'Mukta',
    'Noto Sans Devanagari',
  ];

  /// Anek Latin at an arbitrary size/weight — for the kit's inline styles.
  static TextStyle anek({
    required double size,
    FontWeight weight = FontWeight.w700,
    Color color = OnboardingColors.ink900,
    double? height,
    double? letterSpacing,
  }) => TextStyle(
    fontFamily: displayFamily,
    fontFamilyFallback: displayFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    height: height,
    letterSpacing: letterSpacing,
  );

  /// Inter at an arbitrary size/weight — for the kit's inline styles.
  static TextStyle inter({
    required double size,
    FontWeight weight = FontWeight.w400,
    Color color = OnboardingColors.ink900,
    double? height,
    double? letterSpacing,
    TextDecoration? decoration,
  }) => TextStyle(
    fontFamily: bodyFamily,
    fontFamilyFallback: bodyFallback,
    fontSize: size,
    fontWeight: weight,
    color: color,
    height: height,
    letterSpacing: letterSpacing,
    decoration: decoration,
    decorationColor: color,
  );

  /// Roboto Mono with tabular figures, so a ticking timer never jitters.
  static TextStyle mono({
    required double size,
    FontWeight weight = FontWeight.w500,
    Color color = OnboardingColors.ink600,
    double? letterSpacing,
  }) => TextStyle(
    fontFamily: monoFamily,
    fontSize: size,
    fontWeight: weight,
    color: color,
    letterSpacing: letterSpacing,
    fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
  );

  // ---- the kit's named styles, verbatim ----

  static TextStyle headerTitle({Color color = OnboardingColors.textOnBlue}) =>
      anek(size: 22, weight: FontWeight.w800, height: 1.25, color: color);

  static TextStyle questionHeadline({Color color = OnboardingColors.ink900}) =>
      anek(size: 20, weight: FontWeight.w700, height: 1.25, color: color);

  static TextStyle subheadBold({Color color = OnboardingColors.ink900}) =>
      anek(size: 16, weight: FontWeight.w700, height: 1.3, color: color);

  static TextStyle fieldMicroLabel({Color color = OnboardingColors.ink600}) =>
      inter(
        size: 11,
        weight: FontWeight.w700,
        letterSpacing: 0.8,
        color: color,
      );

  static TextStyle body({Color color = OnboardingColors.ink900}) =>
      inter(size: 14, weight: FontWeight.w400, height: 1.45, color: color);

  static TextStyle bodyMuted({Color color = OnboardingColors.ink600}) =>
      inter(size: 13, weight: FontWeight.w400, height: 1.4, color: color);

  static TextStyle buttonLabel({Color color = OnboardingColors.shiftBlue}) =>
      anek(size: 16, weight: FontWeight.w800, letterSpacing: 0.3, color: color);

  /// A salary / count / code in mono (spec §1.2 `monoBold`).
  ///
  /// Roboto Mono has no w800 face at all, so the spec's w800 renders as the
  /// bundled w700. Accepted deliberately rather than shipping a synthesised
  /// weight.
  static TextStyle monoBold({Color color = OnboardingColors.ink900}) =>
      mono(size: 14, weight: FontWeight.w700, color: color);

  /// An ALL-CAPS micro label over a group of chips or rows (spec §4
  /// 'OPERATED MACHINES'). The caller uppercases the text — [KitMicroLabel]
  /// does it at render so the source string stays readable.
  static TextStyle microLabel({Color color = OnboardingColors.ink500}) => inter(
    size: 10,
    weight: FontWeight.w700,
    letterSpacing: 0.8,
    color: color,
  );

  /// A small status pill's label — 'READY', 'DRAFT' (spec §4).
  ///
  /// Inter's bundled instances stop at w700, so the spec's w800 renders as
  /// w700 here and in [pillLabel]'s callers.
  static TextStyle pillLabel({Color color = OnboardingColors.safetyYellow}) =>
      inter(size: 10, weight: FontWeight.w800, color: color);

  /// A card header's count pill — digits only (spec §4, ruling R8).
  static TextStyle countPill({Color color = OnboardingColors.ink600}) =>
      inter(size: 11, weight: FontWeight.w700, color: color);

  /// A resume / profile card's title (spec §4 'Machines & CNC Controllers').
  static TextStyle cardTitle({Color color = OnboardingColors.shiftBlue}) =>
      anek(size: 15, weight: FontWeight.w800, color: color);

  /// An info / select chip's label (spec §4).
  static TextStyle chipLabel({Color color = OnboardingColors.ink900}) =>
      inter(size: 12, weight: FontWeight.w600, color: color);

  /// Mono badge / timer / progress (master spec v2 `monoLabel`).
  static TextStyle monoLabel({Color color = OnboardingColors.ink600}) =>
      mono(size: 12, weight: FontWeight.w600, color: color);

  static TextStyle otpDigit({Color color = OnboardingColors.shiftBlue}) =>
      mono(size: 22, weight: FontWeight.w700, color: color);

  static TextStyle monoTimer({Color color = OnboardingColors.ink600}) =>
      mono(size: 13, weight: FontWeight.w500, color: color);

  // ---- the form-flow mockups' styles (14/15/16) ----
  //
  // Multi-line styles use EVEN leading, as the mockups' design tool does, so a
  // taller line height grows a line equally above and below its ink.

  /// A form question: Anek Bold in navy with a loose 1.45 line pitch.
  static TextStyle formQuestionHeadline() => anek(
    size: 18.5,
    weight: FontWeight.w700,
    height: 1.45,
    color: OnboardingColors.shiftBlue,
  ).copyWith(leadingDistribution: TextLeadingDistribution.even);

  /// The explanation under a form question: a ~20.8dp line pitch.
  static TextStyle formWhyText() => inter(
    size: 12.3,
    weight: FontWeight.w500,
    height: 1.69,
    color: FormFlowColors.whyText,
  ).copyWith(leadingDistribution: TextLeadingDistribution.even);

  /// The header's uppercase "STEP n OF m • CATEGORY" line.
  static TextStyle formStepLine() => inter(
    size: 10,
    weight: FontWeight.w700,
    letterSpacing: FormFlowLayout.headerStepLetterSpacing,
    color: FormFlowColors.headerStepLine,
  );

  /// The progress strip's topic and percentage labels.
  static TextStyle formStripLabel() => inter(
    size: 10,
    weight: FontWeight.w700,
    letterSpacing: FormFlowLayout.stripLabelLetterSpacing,
    color: OnboardingColors.shiftBlue,
  );

  /// An option card's title.
  static TextStyle formCardTitle() => anek(
    size: 15,
    weight: FontWeight.w700,
    color: OnboardingColors.shiftBlue,
  );

  /// An option card's description line(s).
  static TextStyle formCardSubtitle() => inter(
    size: 12,
    height: 1.36,
    color: FormFlowColors.whyText,
  ).copyWith(leadingDistribution: TextLeadingDistribution.even);

  /// An option card's description in mono — for measurement specs.
  static TextStyle formCardSubtitleMono() =>
      mono(size: 11, weight: FontWeight.w400, color: FormFlowColors.whyText);
}
