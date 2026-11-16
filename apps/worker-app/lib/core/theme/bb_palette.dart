import 'package:flutter/material.dart';

import 'onboarding_theme.dart';

/// **The theme-role palette for the BadaBhai worker app.**
///
/// Screens must read colours from here (or from `ColorScheme`) instead of a
/// palette constant, so one widget tree renders in the brand's light (Ivory)
/// theme and in the dark (ink) theme. [#2824]
///
/// * **Light** values are EXACTLY today's [OnboardingColors] values — the
///   light theme is not a re-skin.
/// * **Dark** values are the `[data-theme="ink"]` tokens of
///   `packages/design-tokens/tokens.css` (page `#050D22`, card `#0A1838`,
///   raised `#10224A`), so the app and the web portals match.
///
/// Every dark text pair below records its contrast ratio against the ink card
/// (`#0A1838`) in a comment. See `test/core/theme/bb_palette_test.dart`, which
/// asserts each ratio so a future edit cannot quietly drop below AA.
///
/// Role notes (a literal token has more than one job, so these are semantic):
/// * [brandSurface] is the Shift Blue *frame* (headers, navy buttons). It is
///   the same navy in both themes.
/// * [textBrand] is brand-coloured *text*: Shift Blue on light, navy-200 on
///   ink, because navy on navy is unreadable.
/// * [link] and [focusRing] move to Safety Yellow on ink, as the web ink
///   theme does.
/// * [card] is a surface; [onBrandSurface] is text on a navy surface. They are
///   deliberately separate — today's `paperWhite` literal is used for both.
@immutable
class BbPalette extends ThemeExtension<BbPalette> {
  const BbPalette({
    required this.brightness,
    required this.page,
    required this.ivory,
    required this.card,
    required this.raised,
    required this.sunken,
    required this.inset,
    required this.brandSurface,
    required this.brandSurfaceLight,
    required this.brandSurfaceRaised,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.textBrand,
    required this.link,
    required this.iconSecondary,
    required this.onBrandSurface,
    required this.onBrandSurfaceMuted,
    required this.onBrandSurface70,
    required this.action,
    required this.actionPressed,
    required this.onAction,
    required this.actionTint,
    required this.borderDefault,
    required this.borderSubtle,
    required this.borderActive,
    required this.borderCard,
    required this.success,
    required this.successBg,
    required this.successBorder,
    required this.danger,
    required this.dangerBg,
    required this.warning,
    required this.warningBg,
    required this.info,
    required this.infoBg,
    required this.infoBorder,
    required this.infoTitle,
    required this.infoText,
    required this.disabledBg,
    required this.disabledText,
    required this.scrim,
    required this.selectedCardBg,
    required this.noteBg,
    required this.cardIconBg,
    required this.shieldCircle,
    required this.focusRing,
    required this.haldi,
  });

  /// Light = today's UI kit v3 values, exactly.
  static const BbPalette light = BbPalette(
    brightness: Brightness.light,
    page: OnboardingColors.canvasBg,
    ivory: OnboardingColors.canvasIvory,
    card: OnboardingColors.paperWhite,
    raised: OnboardingColors.chipBg,
    sunken: OnboardingColors.rowBg,
    inset: OnboardingColors.pillMutedBg,
    brandSurface: OnboardingColors.shiftBlue,
    brandSurfaceLight: OnboardingColors.shiftBlueLight,
    brandSurfaceRaised: OnboardingColors.shiftBlueSurface,
    textPrimary: OnboardingColors.ink900,
    textSecondary: OnboardingColors.ink600,
    textMuted: OnboardingColors.ink500,
    textBrand: OnboardingColors.shiftBlue,
    link: Color(0xFF0F2B7A),
    iconSecondary: OnboardingColors.ink600,
    onBrandSurface: OnboardingColors.textOnBlue,
    onBrandSurfaceMuted: OnboardingColors.textOnBlueMuted,
    onBrandSurface70: OnboardingColors.textOnBlue70,
    action: OnboardingColors.safetyYellow,
    actionPressed: OnboardingColors.safetyYellowDark,
    onAction: OnboardingColors.textOnYellow,
    actionTint: OnboardingColors.yellowTint20,
    borderDefault: OnboardingColors.borderDefault,
    borderSubtle: OnboardingColors.borderSubtle,
    borderActive: OnboardingColors.borderActive,
    borderCard: OnboardingColors.borderCard,
    success: OnboardingColors.successGreen,
    successBg: OnboardingColors.successBg,
    successBorder: OnboardingColors.successBorder,
    danger: OnboardingColors.errorRed,
    dangerBg: OnboardingColors.errorBg,
    warning: Color(0xFFB45309),
    warningBg: Color(0xFFFEF3C7),
    info: OnboardingColors.infoBorder,
    infoBg: OnboardingColors.infoBg,
    infoBorder: OnboardingColors.infoBorder,
    infoTitle: OnboardingColors.infoTitle,
    infoText: OnboardingColors.infoText,
    disabledBg: OnboardingColors.disabledBg,
    disabledText: OnboardingColors.disabledText,
    scrim: OnboardingColors.scrim,
    selectedCardBg: OnboardingColors.selectedCardBg,
    noteBg: OnboardingColors.noteBg,
    cardIconBg: OnboardingColors.cardIconBg,
    shieldCircle: OnboardingColors.shieldCircle,
    focusRing: OnboardingColors.shiftBlue,
    haldi: OnboardingColors.haldi,
  );

  /// Dark = the ink theme of `packages/design-tokens/tokens.css`.
  static const BbPalette dark = BbPalette(
    brightness: Brightness.dark,
    page: Color(0xFF050D22), // --surface-page (ink-950)
    ivory: Color(0xFF050D22),
    card: Color(0xFF0A1838), // --surface-card
    raised: Color(0xFF10224A), // --surface-raised
    sunken: Color(0xFF07122B), // --surface-sunken
    inset: Color(0xFF050D22), // --surface-inset
    // The frame stays Shift Blue in both themes (--surface-ink).
    brandSurface: OnboardingColors.shiftBlue,
    brandSurfaceLight: OnboardingColors.shiftBlueLight,
    brandSurfaceRaised: OnboardingColors.shiftBlueSurface,
    textPrimary: Color(0xFFFFFFFF), // 17.49:1 on card
    textSecondary: Color(0xFFB9C0CE), // 9.57:1 on card
    textMuted: Color(0xFF8A92A6), // 5.62:1 on card
    textBrand: Color(0xFFB9C8E6), // 10.38:1 on card
    link: Color(0xFFFFB32C), // 9.77:1 on card
    iconSecondary: Color(0xFFB9C0CE),
    onBrandSurface: Color(0xFFFFFFFF), // 15.07:1 on Shift Blue
    onBrandSurfaceMuted: Color(0xFFB9C8E6), // 9.97:1 on Shift Blue
    onBrandSurface70: Color(0xB3FFFFFF),
    action: OnboardingColors.safetyYellow, // #FFB32C — 9.77:1 on card
    actionPressed: OnboardingColors.safetyYellowDark,
    onAction: OnboardingColors.shiftBlue, // 9.39:1 on Safety Yellow
    actionTint: Color(0x24FFB32C), // yellow at 14% (--brand-tint)
    borderDefault: Color(0xFF1F3160), // --border-default
    borderSubtle: Color(0xFF16264D), // --border-subtle
    borderActive: OnboardingColors.safetyYellow,
    borderCard: Color(0xFF1F3160),
    success: Color(0xFF6DB588), // green-300 — 7.18:1 on card
    successBg: Color(0x381E7A3C), // green-500 at 22%
    successBorder: Color(0xFF356B4A),
    danger: Color(0xFFE38B8B), // red-300 — 6.94:1 on card
    dangerBg: Color(0x38C62828), // red-500 at 22%
    warning: Color(0xFFFCD34D), // amber-300 — 12.35:1 on card
    warningBg: Color(0x38D97706), // amber-500 at 22%
    info: Color(0xFF8FA3D6), // navy-300
    infoBg: Color(0x2E8FA3D6), // navy-300 at 18%
    infoBorder: Color(0xFF34497D),
    infoTitle: Color(0xFFDDE4F2), // navy-100
    infoText: Color(0xFFB9C8E6), // navy-200
    disabledBg: Color(0xFF1F3160),
    disabledText: Color(0xFF8A92A6),
    scrim: Color(0xA803070F), // rgb(3 7 15 / 0.66)
    selectedCardBg: Color(0xFF182A50),
    noteBg: Color(0xFF10224A),
    cardIconBg: Color(0xFF10224A),
    shieldCircle: Color(0xFF16264D),
    focusRing: OnboardingColors.safetyYellow,
    haldi: OnboardingColors.haldi,
  );

  final Brightness brightness;

  /// Page background (`scaffoldBackgroundColor`).
  final Color page;

  /// The Ivory page token; ink in dark.
  final Color ivory;

  /// Card / sheet / input surface.
  final Color card;

  /// A raised surface: chips, rows, pills.
  final Color raised;

  /// A step *down* from the page.
  final Color sunken;

  /// A step *down* from a card.
  final Color inset;

  /// Shift Blue chrome (header bands, navy buttons).
  final Color brandSurface;
  final Color brandSurfaceLight;
  final Color brandSurfaceRaised;

  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;

  /// Brand-coloured text/heading: Shift Blue on light, navy-200 on ink.
  final Color textBrand;

  /// Text links: navy-700 on light, Safety Yellow on ink.
  final Color link;

  final Color iconSecondary;

  /// Text/icon on a [brandSurface].
  final Color onBrandSurface;
  final Color onBrandSurfaceMuted;
  final Color onBrandSurface70;

  /// The one action per screen (Safety Yellow), its pressed shade and its text.
  final Color action;
  final Color actionPressed;
  final Color onAction;
  final Color actionTint;

  final Color borderDefault;
  final Color borderSubtle;
  final Color borderActive;
  final Color borderCard;

  final Color success;
  final Color successBg;
  final Color successBorder;
  final Color danger;
  final Color dangerBg;
  final Color warning;
  final Color warningBg;
  final Color info;
  final Color infoBg;
  final Color infoBorder;
  final Color infoTitle;
  final Color infoText;

  final Color disabledBg;
  final Color disabledText;
  final Color scrim;

  final Color selectedCardBg;
  final Color noteBg;
  final Color cardIconBg;
  final Color shieldCircle;

  /// Input focus ring: Shift Blue on light, Safety Yellow on ink.
  final Color focusRing;
  final Color haldi;

  bool get isDark => brightness == Brightness.dark;

  @override
  BbPalette copyWith({
    Brightness? brightness,
    Color? page,
    Color? ivory,
    Color? card,
    Color? raised,
    Color? sunken,
    Color? inset,
    Color? brandSurface,
    Color? brandSurfaceLight,
    Color? brandSurfaceRaised,
    Color? textPrimary,
    Color? textSecondary,
    Color? textMuted,
    Color? textBrand,
    Color? link,
    Color? iconSecondary,
    Color? onBrandSurface,
    Color? onBrandSurfaceMuted,
    Color? onBrandSurface70,
    Color? action,
    Color? actionPressed,
    Color? onAction,
    Color? actionTint,
    Color? borderDefault,
    Color? borderSubtle,
    Color? borderActive,
    Color? borderCard,
    Color? success,
    Color? successBg,
    Color? successBorder,
    Color? danger,
    Color? dangerBg,
    Color? warning,
    Color? warningBg,
    Color? info,
    Color? infoBg,
    Color? infoBorder,
    Color? infoTitle,
    Color? infoText,
    Color? disabledBg,
    Color? disabledText,
    Color? scrim,
    Color? selectedCardBg,
    Color? noteBg,
    Color? cardIconBg,
    Color? shieldCircle,
    Color? focusRing,
    Color? haldi,
  }) {
    return BbPalette(
      brightness: brightness ?? this.brightness,
      page: page ?? this.page,
      ivory: ivory ?? this.ivory,
      card: card ?? this.card,
      raised: raised ?? this.raised,
      sunken: sunken ?? this.sunken,
      inset: inset ?? this.inset,
      brandSurface: brandSurface ?? this.brandSurface,
      brandSurfaceLight: brandSurfaceLight ?? this.brandSurfaceLight,
      brandSurfaceRaised: brandSurfaceRaised ?? this.brandSurfaceRaised,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textMuted: textMuted ?? this.textMuted,
      textBrand: textBrand ?? this.textBrand,
      link: link ?? this.link,
      iconSecondary: iconSecondary ?? this.iconSecondary,
      onBrandSurface: onBrandSurface ?? this.onBrandSurface,
      onBrandSurfaceMuted: onBrandSurfaceMuted ?? this.onBrandSurfaceMuted,
      onBrandSurface70: onBrandSurface70 ?? this.onBrandSurface70,
      action: action ?? this.action,
      actionPressed: actionPressed ?? this.actionPressed,
      onAction: onAction ?? this.onAction,
      actionTint: actionTint ?? this.actionTint,
      borderDefault: borderDefault ?? this.borderDefault,
      borderSubtle: borderSubtle ?? this.borderSubtle,
      borderActive: borderActive ?? this.borderActive,
      borderCard: borderCard ?? this.borderCard,
      success: success ?? this.success,
      successBg: successBg ?? this.successBg,
      successBorder: successBorder ?? this.successBorder,
      danger: danger ?? this.danger,
      dangerBg: dangerBg ?? this.dangerBg,
      warning: warning ?? this.warning,
      warningBg: warningBg ?? this.warningBg,
      info: info ?? this.info,
      infoBg: infoBg ?? this.infoBg,
      infoBorder: infoBorder ?? this.infoBorder,
      infoTitle: infoTitle ?? this.infoTitle,
      infoText: infoText ?? this.infoText,
      disabledBg: disabledBg ?? this.disabledBg,
      disabledText: disabledText ?? this.disabledText,
      scrim: scrim ?? this.scrim,
      selectedCardBg: selectedCardBg ?? this.selectedCardBg,
      noteBg: noteBg ?? this.noteBg,
      cardIconBg: cardIconBg ?? this.cardIconBg,
      shieldCircle: shieldCircle ?? this.shieldCircle,
      focusRing: focusRing ?? this.focusRing,
      haldi: haldi ?? this.haldi,
    );
  }

  /// A theme switch must cross-fade the whole tree. Lerping the roles keeps
  /// that transition smooth instead of snapping every surface at once.
  @override
  BbPalette lerp(ThemeExtension<BbPalette>? other, double t) {
    if (other is! BbPalette) return this;
    Color c(Color a, Color b) => Color.lerp(a, b, t)!;
    return BbPalette(
      brightness: t < 0.5 ? brightness : other.brightness,
      page: c(page, other.page),
      ivory: c(ivory, other.ivory),
      card: c(card, other.card),
      raised: c(raised, other.raised),
      sunken: c(sunken, other.sunken),
      inset: c(inset, other.inset),
      brandSurface: c(brandSurface, other.brandSurface),
      brandSurfaceLight: c(brandSurfaceLight, other.brandSurfaceLight),
      brandSurfaceRaised: c(brandSurfaceRaised, other.brandSurfaceRaised),
      textPrimary: c(textPrimary, other.textPrimary),
      textSecondary: c(textSecondary, other.textSecondary),
      textMuted: c(textMuted, other.textMuted),
      textBrand: c(textBrand, other.textBrand),
      link: c(link, other.link),
      iconSecondary: c(iconSecondary, other.iconSecondary),
      onBrandSurface: c(onBrandSurface, other.onBrandSurface),
      onBrandSurfaceMuted: c(onBrandSurfaceMuted, other.onBrandSurfaceMuted),
      onBrandSurface70: c(onBrandSurface70, other.onBrandSurface70),
      action: c(action, other.action),
      actionPressed: c(actionPressed, other.actionPressed),
      onAction: c(onAction, other.onAction),
      actionTint: c(actionTint, other.actionTint),
      borderDefault: c(borderDefault, other.borderDefault),
      borderSubtle: c(borderSubtle, other.borderSubtle),
      borderActive: c(borderActive, other.borderActive),
      borderCard: c(borderCard, other.borderCard),
      success: c(success, other.success),
      successBg: c(successBg, other.successBg),
      successBorder: c(successBorder, other.successBorder),
      danger: c(danger, other.danger),
      dangerBg: c(dangerBg, other.dangerBg),
      warning: c(warning, other.warning),
      warningBg: c(warningBg, other.warningBg),
      info: c(info, other.info),
      infoBg: c(infoBg, other.infoBg),
      infoBorder: c(infoBorder, other.infoBorder),
      infoTitle: c(infoTitle, other.infoTitle),
      infoText: c(infoText, other.infoText),
      disabledBg: c(disabledBg, other.disabledBg),
      disabledText: c(disabledText, other.disabledText),
      scrim: c(scrim, other.scrim),
      selectedCardBg: c(selectedCardBg, other.selectedCardBg),
      noteBg: c(noteBg, other.noteBg),
      cardIconBg: c(cardIconBg, other.cardIconBg),
      shieldCircle: c(shieldCircle, other.shieldCircle),
      focusRing: c(focusRing, other.focusRing),
      haldi: c(haldi, other.haldi),
    );
  }
}

/// `context.bb` is the short form screens use in a `build`.
extension BbPaletteContext on BuildContext {
  BbPalette get bb => Theme.of(this).extension<BbPalette>() ?? BbPalette.light;
}
