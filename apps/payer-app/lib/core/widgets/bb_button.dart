import 'package:flutter/material.dart';

import '../theme/app_haptics.dart';
import '../theme/app_spacing.dart';
import '../theme/app_theme.dart';
import '../theme/app_typography.dart';
import 'bb_pressable.dart';
import '../theme/bb_palette.dart';

/// Visual style of a [BbButton]. Mirrors the JUL31 kit's `BBButtonKind`
/// (primary · navy · success · outline) plus the payer-app's own quiet
/// variants. Label voice is the normal UI face (Inter) and a light haptic
/// fires on press — the kit's two button laws.
///
///  - [primary]  — haldi action CTA, deep-blue label (the ONE main action).
///  - [brand]    — haldi brand CTA (logo moments / brand highlights).
///  - [navy]     — deep-blue commitment (kit "navy": download / continue).
///  - [secondary]— outlined, ink on white (the quiet alternative / kit "outline").
///  - [tonal]    — soft haldi tint.
///  - [success]  — green: money / WhatsApp / done ONLY (kit "success").
///  - [ghost]    — text only, reads as a blue link.
///  - [danger]   — crimson destructive action.
enum BbButtonVariant { primary, brand, navy, secondary, tonal, success, ghost, danger }

/// Control height: [sm] 36 · [md] 44 · [lg] 52 (the worker-app primary CTA).
enum BbButtonSize { sm, md, lg }

/// The one reusable BadaBhai button. Built on Material's button family so it
/// inherits [AppTheme] and keeps native ink/press; never hand-roll a button.
///
/// `primary` is the single haldi CTA per screen — quieten everything else with
/// `secondary`, `tonal`, or `ghost`.
class BbButton extends StatelessWidget {
  const BbButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = BbButtonVariant.primary,
    this.size = BbButtonSize.lg,
    this.block = false,
    this.iconLeft,
    this.iconRight,
    this.leading,
    this.loading = false,
    this.buttonKey,
    this.autofocus = false,
  }) : assert(
          size != BbButtonSize.sm ||
              (variant != BbButtonVariant.primary &&
                  variant != BbButtonVariant.brand &&
                  variant != BbButtonVariant.navy &&
                  variant != BbButtonVariant.success &&
                  variant != BbButtonVariant.danger),
          'BbButtonSize.sm (36px, AppSpacing.controlSm) drops a loud action '
          'below the sacred 48px tap floor (AppSpacing.tap). Use md/lg for the '
          'primary/brand/navy/success/danger CTAs; sm is reserved for the quiet '
          'secondary/tonal/ghost variants only (#1082).',
        );

  final String label;
  final VoidCallback? onPressed;
  final BbButtonVariant variant;
  final BbButtonSize size;
  final bool block;
  final IconData? iconLeft;
  final IconData? iconRight;

  /// A widget in the leading icon slot, in place of [iconLeft] — for an icon
  /// that animates (e.g. copy → check, #2596). Sized like [iconLeft] through
  /// the ambient [IconTheme], and replaced by the spinner while [loading].
  final Widget? leading;
  final bool loading;

  /// Key applied to the underlying Material button (handy for widget tests).
  final Key? buttonKey;

  /// Focus the underlying Material button as it appears — used by a
  /// destructive confirm so the safe choice (Cancel) starts focused (#2690).
  final bool autofocus;

  double get _height => switch (size) {
        BbButtonSize.sm => AppSpacing.controlSm,
        BbButtonSize.md => AppSpacing.controlMd,
        BbButtonSize.lg => AppSpacing.controlLg,
      };

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    // Kit rule: a light haptic on every press. Suppressed while loading or when
    // there is no handler.
    final VoidCallback? effectiveOnPressed = (loading || onPressed == null)
        ? null
        : () {
            AppHaptics.tap();
            onPressed!();
          };

    // The spinner must sit on each variant's own foreground — a white spinner
    // is invisible on the haldi primary/brand/tonal faces.
    final Color spinnerColor = switch (variant) {
      BbButtonVariant.primary || BbButtonVariant.brand => p.onAction,
      BbButtonVariant.navy => p.onBrandSurface,
      BbButtonVariant.success => p.isDark ? p.card : p.onBrandSurface,
      BbButtonVariant.tonal => p.isDark ? p.action : p.actionPressed,
      BbButtonVariant.secondary || BbButtonVariant.ghost => p.textPrimary,
      BbButtonVariant.danger => p.isDark ? p.card : p.onBrandSurface,
    };

    final Widget child = _Content(
      label: label,
      iconLeft: iconLeft,
      iconRight: iconRight,
      leading: leading,
      loading: loading,
      size: size,
      spinnerColor: spinnerColor,
    );

    final Size minSize = Size(block ? double.infinity : 64, _height);
    // Buttons live below the header, so they speak in the normal UI face
    // (Inter). The button's own foregroundColor still resolves the label colour
    // (Material copies it over this style), so each variant keeps its correct
    // on-face colour.
    final TextStyle labelStyle = AppTypography.heading(
      size: size == BbButtonSize.sm ? AppTypography.sizeSm : AppTypography.sizeBase,
      weight: FontWeight.w700,
    );

    final Widget button = switch (variant) {
      BbButtonVariant.secondary => OutlinedButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: OutlinedButton.styleFrom(
            minimumSize: minSize,
            textStyle: labelStyle,
          ),
          child: child,
        ),
      BbButtonVariant.ghost => TextButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: TextButton.styleFrom(
            foregroundColor: p.textPrimary,
            minimumSize: minSize,
            textStyle: labelStyle,
          ),
          child: child,
        ),
      BbButtonVariant.tonal => FilledButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(
            backgroundColor: p.actionTint,
            foregroundColor: p.isDark ? p.action : p.actionPressed,
            minimumSize: minSize,
            textStyle: labelStyle,
            elevation: 0,
          ),
          child: child,
        ),
      // Kit "navy" — deep-blue strong commitment (download / continue).
      BbButtonVariant.navy => FilledButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(
            backgroundColor: p.brandSurface,
            foregroundColor: p.onBrandSurface,
            disabledBackgroundColor: p.disabledBg,
            disabledForegroundColor: p.disabledText,
            minimumSize: minSize,
            textStyle: labelStyle,
            elevation: 0,
            shadowColor: Colors.transparent,
          ),
          child: child,
        ),
      // Kit "success" — green: money / WhatsApp / done ONLY.
      BbButtonVariant.success => FilledButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(
            backgroundColor: p.success,
            foregroundColor: p.isDark ? p.card : p.onBrandSurface,
            disabledBackgroundColor: p.disabledBg,
            disabledForegroundColor: p.disabledText,
            minimumSize: minSize,
            textStyle: labelStyle,
            elevation: 0,
            shadowColor: Colors.transparent,
          ),
          child: child,
        ),
      BbButtonVariant.brand => FilledButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: AppButtonStyles.brand.copyWith(
            minimumSize: WidgetStatePropertyAll<Size>(minSize),
            textStyle: WidgetStatePropertyAll<TextStyle>(labelStyle),
          ),
          child: child,
        ),
      BbButtonVariant.danger => FilledButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: AppButtonStyles.danger.copyWith(
            backgroundColor: WidgetStatePropertyAll<Color>(p.danger),
            foregroundColor: WidgetStatePropertyAll<Color>(
              p.isDark ? p.card : p.onBrandSurface,
            ),
            minimumSize: WidgetStatePropertyAll<Size>(minSize),
            textStyle: WidgetStatePropertyAll<TextStyle>(labelStyle),
          ),
          child: child,
        ),
      BbButtonVariant.primary => FilledButton(
          key: buttonKey,
          autofocus: autofocus,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(minimumSize: minSize, textStyle: labelStyle),
          child: child,
        ),
    };

    // #2591 — every button presses down to 0.97; the ONE primary CTA also
    // carries the 3px navy edge that collapses on press. The Material button
    // keeps its own tap + haptic, so the press is read passively.
    final Widget pressable = BbPressable.passive(
      enabled: effectiveOnPressed != null,
      edge: variant == BbButtonVariant.primary,
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: button,
    );

    return block
        ? SizedBox(width: double.infinity, child: pressable)
        : pressable;
  }
}

class _Content extends StatelessWidget {
  const _Content({
    required this.label,
    required this.iconLeft,
    required this.iconRight,
    required this.leading,
    required this.loading,
    required this.size,
    required this.spinnerColor,
  });

  final String label;
  final IconData? iconLeft;
  final IconData? iconRight;
  final Widget? leading;
  final bool loading;
  final BbButtonSize size;
  final Color spinnerColor;

  @override
  Widget build(BuildContext context) {
    final double iconSize = size == BbButtonSize.sm ? 18 : 20;
    return Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        if (loading) ...<Widget>[
          SizedBox(
            width: iconSize,
            height: iconSize,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation<Color>(spinnerColor),
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
        ] else if (leading != null) ...<Widget>[
          IconTheme.merge(
            data: IconThemeData(size: iconSize),
            child: leading!,
          ),
          const SizedBox(width: AppSpacing.s2),
        ] else if (iconLeft != null) ...<Widget>[
          Icon(iconLeft, size: iconSize),
          const SizedBox(width: AppSpacing.s2),
        ],
        Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
        if (iconRight != null) ...<Widget>[
          const SizedBox(width: AppSpacing.s2),
          Icon(iconRight, size: iconSize),
        ],
      ],
    );
  }
}
