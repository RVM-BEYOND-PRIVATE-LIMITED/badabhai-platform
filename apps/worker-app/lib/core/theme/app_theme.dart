import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_colors.dart';
import 'app_typography.dart';
import 'bb_palette.dart';
import 'onboarding_theme.dart';

/// The BadaBhai **UI kit v3** theme, assembled from [OnboardingColors] /
/// [OnboardingTypography] (spec §1.1 / §1.2).
///
/// Material 3, skinned to the tokens — we do **not** ship default Material
/// colours. Build the whole app from [AppTheme.light]; never hard-code a
/// colour, radius or text style in a widget.
///
/// Colour intent: **safety yellow is the hero / primary CTA** (one per screen;
/// text on yellow is ALWAYS shift blue) and **shift blue is structure / trust /
/// chrome**. Green means success / money / WhatsApp only. Surfaces are
/// separated by **hairline borders, never shadows** — every elevation is 0.
///
/// **Yellow is SELECTED, blue is FOCUSED.** The one focus rule in the spec
/// (§3.3, the OTP cell) rings a focused input in [OnboardingColors.shiftBlue]
/// at 1.8; [OnboardingColors.borderActive] yellow is reserved for the selected
/// state of a card, chip or checkbox. Both live here so no screen re-decides it.
class AppTheme {
  AppTheme._();

  static ThemeData light() {
    const ColorScheme scheme = ColorScheme(
      brightness: Brightness.light,
      // primary = the safety-yellow hero CTA (shift-blue label)
      primary: OnboardingColors.safetyYellow,
      onPrimary: OnboardingColors.textOnYellow,
      primaryContainer: OnboardingColors.selectedCardBg,
      onPrimaryContainer: OnboardingColors.shiftBlue,
      // secondary = shift blue (structure, trust, chrome)
      secondary: OnboardingColors.shiftBlue,
      onSecondary: OnboardingColors.textOnBlue,
      secondaryContainer: OnboardingColors.infoBg,
      onSecondaryContainer: OnboardingColors.shiftBlue,
      // tertiary = green (success / money accent)
      tertiary: OnboardingColors.successGreen,
      onTertiary: OnboardingColors.textOnBlue,
      tertiaryContainer: OnboardingColors.successBg,
      onTertiaryContainer: OnboardingColors.successGreen,
      error: OnboardingColors.errorRed,
      onError: OnboardingColors.textOnBlue,
      errorContainer: OnboardingColors.errorBg,
      onErrorContainer: OnboardingColors.errorRed,
      surface: OnboardingColors.paperWhite,
      onSurface: OnboardingColors.ink900,
      onSurfaceVariant: OnboardingColors.ink600,
      surfaceContainerLowest: OnboardingColors.paperWhite,
      surfaceContainerLow: OnboardingColors.paperWhite,
      surfaceContainer: OnboardingColors.canvasBg,
      surfaceContainerHigh: OnboardingColors.pillMutedBg,
      surfaceContainerHighest: OnboardingColors.pillMutedBg,
      outline: OnboardingColors.borderDefault,
      outlineVariant: OnboardingColors.borderSubtle,
      shadow: AppColors.ink950,
      scrim: OnboardingColors.scrim,
      inverseSurface: OnboardingColors.ink900,
      onInverseSurface: OnboardingColors.paperWhite,
      inversePrimary: OnboardingColors.yellowTint20,
    );

    final TextTheme textTheme = AppTypography.textTheme();

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      extensions: const <ThemeExtension<dynamic>>[BbPalette.light],
      scaffoldBackgroundColor: OnboardingColors.canvasBg,
      textTheme: textTheme,
      fontFamily: OnboardingTypography.bodyFamily,
      fontFamilyFallback: OnboardingTypography.bodyFallback,
      primaryColor: OnboardingColors.safetyYellow,
      splashColor: OnboardingColors.selectedCardBg,
      highlightColor: OnboardingColors.selectedCardBg,
      dividerColor: OnboardingColors.borderSubtle,

      iconTheme: const IconThemeData(color: OnboardingColors.ink600, size: 24),

      // The navy chrome, for any leftover or dormant AppBar caller. Migrated
      // screens use ShiftBlueHeader / KitTabHeader instead, which are not
      // AppBars at all.
      appBarTheme: AppBarTheme(
        backgroundColor: OnboardingColors.shiftBlue,
        foregroundColor: OnboardingColors.textOnBlue,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        shadowColor: Colors.transparent,
        centerTitle: false,
        titleTextStyle: OnboardingTypography.anek(
          size: 20,
          weight: FontWeight.w800,
          color: OnboardingColors.textOnBlue,
        ),
        iconTheme: const IconThemeData(
          color: OnboardingColors.textOnBlue,
          size: 22,
        ),
        actionsIconTheme: const IconThemeData(
          color: OnboardingColors.textOnBlue,
          size: 22,
        ),
        systemOverlayStyle: SystemUiOverlayStyle.light,
      ),

      // Primary worker CTA — the yellow action button, shift-blue label. Flat.
      filledButtonTheme: FilledButtonThemeData(style: KitButtonStyles.primary),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: KitButtonStyles.primary,
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: KitButtonStyles.secondary,
      ),
      textButtonTheme: TextButtonThemeData(style: KitButtonStyles.ghost),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: OnboardingColors.paperWhite,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 14,
        ),
        hintStyle: OnboardingTypography.inter(
          size: 14,
          color: OnboardingColors.ink500,
        ),
        labelStyle: OnboardingTypography.fieldMicroLabel(),
        enabledBorder: _inputBorder(OnboardingColors.borderDefault, 1.2),
        border: _inputBorder(OnboardingColors.borderDefault, 1.2),
        // The spec's ONE focus rule (§3.3): navy at 1.8. Yellow means selected.
        focusedBorder: _inputBorder(OnboardingColors.shiftBlue, 1.8),
        errorBorder: _inputBorder(OnboardingColors.errorRed, 1.2),
        focusedErrorBorder: _inputBorder(OnboardingColors.errorRed, 1.8),
        errorStyle: OnboardingTypography.inter(
          size: 12,
          weight: FontWeight.w500,
          color: OnboardingColors.errorRed,
        ),
      ),

      // Strict guideline: a ticked box is a NAVY fill with a YELLOW border and
      // a YELLOW tick — never a white tick on navy.
      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? OnboardingColors.shiftBlue
              : Colors.transparent,
        ),
        checkColor: const WidgetStatePropertyAll<Color>(
          OnboardingColors.safetyYellow,
        ),
        side: WidgetStateBorderSide.resolveWith(
          (Set<WidgetState> states) => BorderSide(
            color: states.contains(WidgetState.selected)
                ? OnboardingColors.safetyYellow
                : OnboardingColors.borderDefault,
            width: 1.8,
          ),
        ),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(6)),
        ),
      ),

      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? OnboardingColors.shiftBlue
              : OnboardingColors.borderDefault,
        ),
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? OnboardingColors.safetyYellow
              : OnboardingColors.paperWhite,
        ),
        trackColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? OnboardingColors.shiftBlue
              : OnboardingColors.disabledBg,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? OnboardingColors.safetyYellow
              : OnboardingColors.disabledBg,
        ),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: OnboardingColors.paperWhite,
        // Design law: separation is the scrim + fill, never a shadow.
        elevation: 0,
        shadowColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        barrierColor: OnboardingColors.scrim,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.card)),
        ),
        titleTextStyle: OnboardingTypography.anek(
          size: 18,
          weight: FontWeight.w800,
          color: OnboardingColors.ink900,
        ),
        contentTextStyle: OnboardingTypography.inter(
          size: 14,
          height: 1.45,
          color: OnboardingColors.ink600,
        ),
      ),

      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: OnboardingColors.paperWhite,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        modalElevation: 0,
        modalBarrierColor: OnboardingColors.scrim,
        dragHandleColor: OnboardingColors.borderDefault,
        dragHandleSize: Size(40, 4),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(OnboardingRadii.card),
          ),
        ),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: OnboardingColors.ink900,
        contentTextStyle: OnboardingTypography.inter(
          size: 14,
          color: OnboardingColors.paperWhite,
        ),
        actionTextColor: OnboardingColors.safetyYellow,
        behavior: SnackBarBehavior.floating,
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(
            Radius.circular(OnboardingRadii.docked),
          ),
        ),
      ),

      dividerTheme: const DividerThemeData(
        color: OnboardingColors.borderSubtle,
        thickness: 1,
        space: 1,
      ),

      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: OnboardingColors.shiftBlue,
        linearTrackColor: OnboardingColors.borderSubtle,
        circularTrackColor: OnboardingColors.borderSubtle,
      ),

      chipTheme: ChipThemeData(
        backgroundColor: OnboardingColors.paperWhite,
        side: const BorderSide(color: OnboardingColors.borderDefault),
        labelStyle: OnboardingTypography.chipLabel(),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.chip)),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: OnboardingColors.ink600,
        titleTextStyle: OnboardingTypography.inter(
          size: 14,
          weight: FontWeight.w600,
        ),
        subtitleTextStyle: OnboardingTypography.inter(
          size: 13,
          color: OnboardingColors.ink600,
        ),
      ),

      // Cards separate by a 1px hairline, never a shadow. Flat (elevation 0).
      cardTheme: const CardThemeData(
        color: OnboardingColors.paperWhite,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.card)),
          side: BorderSide(color: OnboardingColors.borderDefault),
        ),
      ),

      textSelectionTheme: TextSelectionThemeData(
        cursorColor: OnboardingColors.shiftBlue,
        selectionHandleColor: OnboardingColors.shiftBlue,
        selectionColor: OnboardingColors.safetyYellow.withValues(alpha: 0.35),
      ),

      tooltipTheme: TooltipThemeData(
        decoration: const BoxDecoration(
          color: OnboardingColors.shiftBlue,
          borderRadius: BorderRadius.all(Radius.circular(8)),
        ),
        textStyle: OnboardingTypography.inter(
          size: 12,
          color: OnboardingColors.paperWhite,
        ),
      ),
    );
  }

  /// The brand's dark **ink** theme (#2824). Same shapes, radii and typography
  /// as [light]; every colour is a [BbPalette.dark] role, and the Material
  /// components (inputs, cards, sheets, dialogs, chips, snackbars, switches)
  /// agree with it.
  ///
  /// It is only ever used when the theme controller says the worker may see it
  /// (see `ThemeController`); a closed [ThemeMode] stays light.
  static ThemeData dark() {
    const BbPalette p = BbPalette.dark;
    final ColorScheme scheme = ColorScheme(
      brightness: Brightness.dark,
      primary: p.action,
      onPrimary: p.onAction,
      primaryContainer: p.selectedCardBg,
      onPrimaryContainer: p.textPrimary,
      secondary: p.textBrand,
      onSecondary: p.card,
      secondaryContainer: p.raised,
      onSecondaryContainer: p.textPrimary,
      tertiary: p.success,
      onTertiary: p.card,
      tertiaryContainer: p.successBg,
      onTertiaryContainer: p.success,
      error: p.danger,
      onError: p.card,
      errorContainer: p.dangerBg,
      onErrorContainer: p.danger,
      surface: p.card,
      onSurface: p.textPrimary,
      onSurfaceVariant: p.textSecondary,
      surfaceContainerLowest: p.inset,
      surfaceContainerLow: p.card,
      surfaceContainer: p.raised,
      surfaceContainerHigh: p.raised,
      surfaceContainerHighest: p.raised,
      outline: p.borderDefault,
      outlineVariant: p.borderSubtle,
      shadow: p.inset,
      scrim: p.scrim,
      inverseSurface: p.textPrimary,
      onInverseSurface: p.card,
      inversePrimary: p.actionTint,
    );

    final TextTheme textTheme = AppTypography.textTheme();

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: scheme,
      extensions: const <ThemeExtension<dynamic>>[BbPalette.dark],
      scaffoldBackgroundColor: p.page,
      textTheme: textTheme,
      fontFamily: OnboardingTypography.bodyFamily,
      fontFamilyFallback: OnboardingTypography.bodyFallback,
      primaryColor: p.action,
      splashColor: p.actionTint,
      highlightColor: p.actionTint,
      dividerColor: p.borderSubtle,
      iconTheme: IconThemeData(color: p.iconSecondary, size: 24),
      appBarTheme: AppBarTheme(
        backgroundColor: p.brandSurface,
        foregroundColor: p.onBrandSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        shadowColor: Colors.transparent,
        centerTitle: false,
        titleTextStyle: OnboardingTypography.anek(
          size: 20,
          weight: FontWeight.w800,
          color: p.onBrandSurface,
        ),
        iconTheme: IconThemeData(color: p.onBrandSurface, size: 22),
        actionsIconTheme: IconThemeData(color: p.onBrandSurface, size: 22),
        systemOverlayStyle: SystemUiOverlayStyle.light,
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: KitButtonStyles.primaryFor(p),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: KitButtonStyles.primaryFor(p),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: KitButtonStyles.secondaryFor(p),
      ),
      textButtonTheme: TextButtonThemeData(style: KitButtonStyles.ghostFor(p)),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: p.card,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 14,
        ),
        hintStyle: OnboardingTypography.inter(size: 14, color: p.textMuted),
        labelStyle: OnboardingTypography.fieldMicroLabel(color: p.textMuted),
        enabledBorder: _inputBorder(p.borderDefault, 1.2),
        border: _inputBorder(p.borderDefault, 1.2),
        focusedBorder: _inputBorder(p.focusRing, 1.8),
        errorBorder: _inputBorder(p.danger, 1.2),
        focusedErrorBorder: _inputBorder(p.danger, 1.8),
        errorStyle: OnboardingTypography.inter(
          size: 12,
          weight: FontWeight.w500,
          color: p.danger,
        ),
      ),

      checkboxTheme: CheckboxThemeData(
        fillColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? p.brandSurface
              : Colors.transparent,
        ),
        checkColor: WidgetStatePropertyAll<Color>(p.action),
        side: WidgetStateBorderSide.resolveWith(
          (Set<WidgetState> states) => BorderSide(
            color: states.contains(WidgetState.selected)
                ? p.borderActive
                : p.borderDefault,
            width: 1.8,
          ),
        ),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(6)),
        ),
      ),

      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? p.action
              : p.borderDefault,
        ),
      ),

      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) =>
              states.contains(WidgetState.selected) ? p.action : p.textMuted,
        ),
        trackColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) => states.contains(WidgetState.selected)
              ? p.brandSurface
              : p.disabledBg,
        ),
        trackOutlineColor: WidgetStateProperty.resolveWith<Color>(
          (Set<WidgetState> states) =>
              states.contains(WidgetState.selected) ? p.action : p.disabledBg,
        ),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: p.card,
        elevation: 0,
        shadowColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        barrierColor: p.scrim,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.card)),
        ),
        titleTextStyle: OnboardingTypography.anek(
          size: 18,
          weight: FontWeight.w800,
          color: p.textPrimary,
        ),
        contentTextStyle: OnboardingTypography.inter(
          size: 14,
          height: 1.45,
          color: p.textSecondary,
        ),
      ),

      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: p.card,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        modalElevation: 0,
        modalBarrierColor: p.scrim,
        dragHandleColor: p.borderDefault,
        dragHandleSize: const Size(40, 4),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(OnboardingRadii.card),
          ),
        ),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: p.raised,
        contentTextStyle: OnboardingTypography.inter(
          size: 14,
          color: p.textPrimary,
        ),
        actionTextColor: p.action,
        behavior: SnackBarBehavior.floating,
        elevation: 0,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(
            Radius.circular(OnboardingRadii.docked),
          ),
        ),
      ),

      dividerTheme: DividerThemeData(
        color: p.borderSubtle,
        thickness: 1,
        space: 1,
      ),

      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: p.action,
        linearTrackColor: p.borderSubtle,
        circularTrackColor: p.borderSubtle,
      ),

      chipTheme: ChipThemeData(
        backgroundColor: p.raised,
        side: BorderSide(color: p.borderDefault),
        labelStyle: OnboardingTypography.chipLabel(color: p.textPrimary),
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.chip)),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: p.iconSecondary,
        titleTextStyle: OnboardingTypography.inter(
          size: 14,
          weight: FontWeight.w600,
          color: p.textPrimary,
        ),
        subtitleTextStyle: OnboardingTypography.inter(
          size: 13,
          color: p.textSecondary,
        ),
      ),

      cardTheme: CardThemeData(
        color: p.card,
        surfaceTintColor: Colors.transparent,
        shadowColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.all(
            Radius.circular(OnboardingRadii.card),
          ),
          side: BorderSide(color: p.borderDefault),
        ),
      ),

      textSelectionTheme: TextSelectionThemeData(
        cursorColor: p.action,
        selectionHandleColor: p.action,
        selectionColor: p.action.withValues(alpha: 0.35),
      ),

      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: p.raised,
          borderRadius: const BorderRadius.all(Radius.circular(8)),
        ),
        textStyle: OnboardingTypography.inter(size: 12, color: p.textPrimary),
      ),
    );
  }

  static OutlineInputBorder _inputBorder(Color color, double width) {
    return OutlineInputBorder(
      borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
      borderSide: BorderSide(color: color, width: width),
    );
  }
}

/// The ONE source of every button paint in the app (spec §2.2 / §4).
///
/// [BbButton], [PrimaryActionButton] and [QuestionnaireBottomBar] all read
/// their style from here, so a button's fill, pressed shade, disabled shade and
/// label voice are decided once. All flat: elevation is always 0 — separation
/// is fill + hairline, never a shadow.
///
/// Every style carries `minimumSize: 48x48` and
/// [MaterialTapTargetSize.padded], so a visually small control (the spec's
/// h10/v4 'Edit') still clears the worker-app touch floor without being drawn
/// any bigger.
class KitButtonStyles {
  KitButtonStyles._();

  /// The hero CTA: safety yellow, shift-blue Anek label.
  static ButtonStyle get primary => _style(
    background: OnboardingColors.safetyYellow,
    pressed: OnboardingColors.safetyYellowDark,
    foreground: OnboardingColors.shiftBlue,
  );

  /// A strong secondary commitment (download / continue): navy, white label.
  static ButtonStyle get navy => _style(
    background: OnboardingColors.shiftBlue,
    pressed: OnboardingColors.shiftBlueLight,
    foreground: OnboardingColors.textOnBlue,
  );

  /// Money / WhatsApp / done ONLY.
  static ButtonStyle get success => _style(
    background: OnboardingColors.successGreen,
    pressed: AppColors.green600,
    foreground: OnboardingColors.textOnBlue,
  );

  /// A destructive action (delete account), white label.
  static ButtonStyle get danger => _style(
    background: OnboardingColors.errorRed,
    pressed: AppColors.red600,
    foreground: OnboardingColors.textOnBlue,
  );

  /// A quiet outlined button: white fill, ink label, grey hairline.
  static ButtonStyle get secondary => _style(
    background: OnboardingColors.paperWhite,
    pressed: OnboardingColors.canvasBg,
    foreground: OnboardingColors.ink900,
    side: const BorderSide(color: OnboardingColors.borderDefault, width: 1.2),
    textStyle: OnboardingTypography.inter(size: 13, weight: FontWeight.w600),
  );

  /// White fill with a navy label and a navy border — "everything else".
  static ButtonStyle get outline => _style(
    background: OnboardingColors.paperWhite,
    pressed: OnboardingColors.canvasBg,
    foreground: OnboardingColors.shiftBlue,
    side: const BorderSide(color: OnboardingColors.shiftBlue, width: 1.5),
  );

  /// A soft yellow wash behind a navy label.
  static ButtonStyle get tonal => _style(
    background: OnboardingColors.yellowTint20,
    pressed: OnboardingColors.selectedCardBg,
    foreground: OnboardingColors.shiftBlue,
  );

  /// Text only.
  static ButtonStyle get ghost => _style(
    background: Colors.transparent,
    pressed: Colors.transparent,
    foreground: OnboardingColors.shiftBlue,
  );

  // ── Theme-role variants (#2824) ───────────────────────────────────────────
  // The dark theme and any converted screen read these, so a button's paint is
  // decided once per palette instead of per screen.

  static ButtonStyle primaryFor(BbPalette p) => _style(
    background: p.action,
    pressed: p.actionPressed,
    foreground: p.onAction,
    disabledBg: p.disabledBg,
    disabledText: p.disabledText,
  );

  static ButtonStyle navyFor(BbPalette p) => _style(
    background: p.brandSurface,
    pressed: p.brandSurfaceLight,
    foreground: p.onBrandSurface,
    disabledBg: p.disabledBg,
    disabledText: p.disabledText,
  );

  static ButtonStyle secondaryFor(BbPalette p) => _style(
    background: p.card,
    pressed: p.raised,
    foreground: p.textPrimary,
    side: BorderSide(color: p.borderDefault, width: 1.2),
    textStyle: OnboardingTypography.inter(size: 13, weight: FontWeight.w600),
    disabledBg: p.disabledBg,
    disabledText: p.disabledText,
  );

  static ButtonStyle ghostFor(BbPalette p) => _style(
    background: Colors.transparent,
    pressed: Colors.transparent,
    foreground: p.link,
    disabledBg: p.disabledBg,
    disabledText: p.disabledText,
  );

  static ButtonStyle dangerFor(BbPalette p) => _style(
    background: p.danger,
    pressed: p.danger,
    foreground: p.card,
    disabledBg: p.disabledBg,
    disabledText: p.disabledText,
  );

  static ButtonStyle _style({
    required Color background,
    required Color pressed,
    required Color foreground,
    BorderSide? side,
    TextStyle? textStyle,
    Color disabledBg = OnboardingColors.disabledBg,
    Color disabledText = OnboardingColors.disabledText,
  }) {
    return ButtonStyle(
      elevation: const WidgetStatePropertyAll<double>(0),
      shadowColor: const WidgetStatePropertyAll<Color>(Colors.transparent),
      surfaceTintColor: const WidgetStatePropertyAll<Color>(Colors.transparent),
      backgroundColor: WidgetStateProperty.resolveWith<Color>((
        Set<WidgetState> states,
      ) {
        if (states.contains(WidgetState.disabled)) {
          // A transparent-fill button (ghost) must stay transparent when
          // disabled — a grey slab where there was no button reads as a bug.
          return background == Colors.transparent
              ? Colors.transparent
              : disabledBg;
        }
        if (states.contains(WidgetState.pressed)) return pressed;
        return background;
      }),
      foregroundColor: WidgetStateProperty.resolveWith<Color>(
        (Set<WidgetState> states) =>
            states.contains(WidgetState.disabled) ? disabledText : foreground,
      ),
      side: side == null
          ? null
          : WidgetStateProperty.resolveWith<BorderSide>(
              (Set<WidgetState> states) => states.contains(WidgetState.disabled)
                  ? BorderSide(color: disabledBg, width: side.width)
                  : side,
            ),
      // The pressed colour IS the feedback; a translucent ripple on top of the
      // flat yellow would only muddy it.
      overlayColor: const WidgetStatePropertyAll<Color>(Colors.transparent),
      minimumSize: const WidgetStatePropertyAll<Size>(Size(48, 48)),
      tapTargetSize: MaterialTapTargetSize.padded,
      padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(
        EdgeInsets.symmetric(horizontal: 16),
      ),
      textStyle: WidgetStatePropertyAll<TextStyle>(
        textStyle ?? OnboardingTypography.buttonLabel(),
      ),
      shape: const WidgetStatePropertyAll<OutlinedBorder>(
        RoundedRectangleBorder(
          borderRadius: BorderRadius.all(
            Radius.circular(OnboardingRadii.docked),
          ),
        ),
      ),
    );
  }
}
