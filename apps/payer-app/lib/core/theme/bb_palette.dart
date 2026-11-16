import 'package:flutter/material.dart';

import 'app_colors.dart';

/// **The theme-role palette for the BadaBhai payer app.** [#2830]
///
/// Same role names as the worker app's `BbPalette`, so both apps read alike.
/// * **Light** = today's [AppColors] values, exactly.
/// * **Dark** = the `[data-theme="ink"]` tokens of
///   `packages/design-tokens/tokens.css` (page `#050D22`, card `#0A1838`,
///   raised `#10224A`).
///
/// Dark ratios are against the ink card; see `test/core/theme/bb_palette_test`.
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

  static const BbPalette light = BbPalette(
    brightness: Brightness.light,
    page: AppColors.surfacePage,
    ivory: AppColors.paper2,
    card: AppColors.surfaceCard,
    raised: AppColors.surfaceSunken,
    sunken: AppColors.surfaceSunken,
    inset: AppColors.surfaceInset,
    brandSurface: AppColors.surfaceInk,
    brandSurfaceLight: AppColors.bluePressed,
    brandSurfaceRaised: AppColors.blue,
    textPrimary: AppColors.textPrimary,
    textSecondary: AppColors.textSecondary,
    textMuted: AppColors.textMuted,
    textBrand: AppColors.textBrand,
    link: AppColors.textLink,
    iconSecondary: AppColors.ink700,
    onBrandSurface: AppColors.onBlue,
    onBrandSurfaceMuted: AppColors.onBlueMuted,
    onBrandSurface70: Color(0xB3FFFFFF),
    action: AppColors.brand,
    actionPressed: AppColors.brandPress,
    onAction: AppColors.textOnBrand,
    actionTint: AppColors.brandTint,
    borderDefault: AppColors.borderDefault,
    borderSubtle: AppColors.borderSubtle,
    borderActive: AppColors.brand,
    borderCard: AppColors.borderDefault,
    success: AppColors.success,
    successBg: AppColors.successTint,
    successBorder: AppColors.greenTintBorder,
    danger: AppColors.danger,
    dangerBg: AppColors.dangerTint,
    warning: AppColors.warning,
    warningBg: AppColors.warningTint,
    info: AppColors.info,
    infoBg: AppColors.infoTint,
    infoBorder: AppColors.blueTintChat,
    infoTitle: AppColors.blue,
    infoText: AppColors.blue,
    disabledBg: AppColors.disabled,
    disabledText: AppColors.textSecondary,
    scrim: AppColors.scrim,
    selectedCardBg: AppColors.brandTint,
    noteBg: AppColors.surfaceSunken,
    cardIconBg: AppColors.surfaceSunken,
    shieldCircle: AppColors.infoTint,
    focusRing: AppColors.brand,
    haldi: AppColors.haldi,
  );

  static const BbPalette dark = BbPalette(
    brightness: Brightness.dark,
    page: Color(0xFF050D22),
    ivory: Color(0xFF050D22),
    card: Color(0xFF0A1838),
    raised: Color(0xFF10224A),
    sunken: Color(0xFF07122B),
    inset: Color(0xFF050D22),
    brandSurface: Color(0xFF05194C),
    brandSurfaceLight: Color(0xFF0A256E),
    brandSurfaceRaised: Color(0xFF0F2B7A),
    textPrimary: Color(0xFFFFFFFF), // 17.49:1 on card
    textSecondary: Color(0xFFB9C0CE), // 9.57:1 on card
    textMuted: Color(0xFF8A92A6), // 5.62:1 on card
    textBrand: Color(0xFFB9C8E6), // 10.38:1 on card
    link: Color(0xFFFFB32C), // 9.77:1 on card
    iconSecondary: Color(0xFFB9C0CE),
    onBrandSurface: Color(0xFFFFFFFF),
    onBrandSurfaceMuted: Color(0xFFB9C8E6),
    onBrandSurface70: Color(0xB3FFFFFF),
    action: Color(0xFFFFB32C), // Safety Yellow — 9.77:1 on card
    actionPressed: Color(0xFFE09A1F),
    onAction: Color(0xFF05194C), // 9.39:1 on Safety Yellow
    actionTint: Color(0x24FFB32C),
    borderDefault: Color(0xFF1F3160),
    borderSubtle: Color(0xFF16264D),
    borderActive: Color(0xFFFFB32C),
    borderCard: Color(0xFF1F3160),
    success: Color(0xFF6DB588), // 7.18:1 on card
    successBg: Color(0x381E7A3C),
    successBorder: Color(0xFF356B4A),
    danger: Color(0xFFE38B8B), // 6.94:1 on card
    dangerBg: Color(0x38C62828),
    warning: Color(0xFFFCD34D), // 12.35:1 on card
    warningBg: Color(0x38D97706),
    info: Color(0xFF8FA3D6),
    infoBg: Color(0x2E8FA3D6),
    infoBorder: Color(0xFF34497D),
    infoTitle: Color(0xFFDDE4F2),
    infoText: Color(0xFFB9C8E6),
    disabledBg: Color(0xFF1F3160),
    disabledText: Color(0xFF8A92A6),
    scrim: Color(0xA803070F),
    selectedCardBg: Color(0xFF182A50),
    noteBg: Color(0xFF10224A),
    cardIconBg: Color(0xFF10224A),
    shieldCircle: Color(0xFF16264D),
    focusRing: Color(0xFFFFB32C),
    haldi: Color(0xFFFFC400),
  );

  final Brightness brightness;
  final Color page;
  final Color ivory;
  final Color card;
  final Color raised;
  final Color sunken;
  final Color inset;
  final Color brandSurface;
  final Color brandSurfaceLight;
  final Color brandSurfaceRaised;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;
  final Color textBrand;
  final Color link;
  final Color iconSecondary;
  final Color onBrandSurface;
  final Color onBrandSurfaceMuted;
  final Color onBrandSurface70;
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
  final Color focusRing;
  final Color haldi;

  bool get isDark => brightness == Brightness.dark;

  @override
  BbPalette copyWith({Brightness? brightness}) {
    if (brightness == null || brightness == this.brightness) return this;
    return brightness == Brightness.dark ? BbPalette.dark : BbPalette.light;
  }

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

extension BbPaletteContext on BuildContext {
  BbPalette get bb =>
      Theme.of(this).extension<BbPalette>() ?? BbPalette.light;
}
