import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show HapticFeedback;

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_theme.dart';
import '../theme/app_typography.dart';

/// Visual style of a [BbButton]. Mirrors the JUL31 kit's `BBButtonKind`
/// (primary · navy · success · outline) plus the payer-app's own quiet
/// variants. Label voice is ALWAYS Anek (display) and a light haptic fires on
/// press — the kit's two button laws.
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
    this.loading = false,
    this.buttonKey,
  });

  final String label;
  final VoidCallback? onPressed;
  final BbButtonVariant variant;
  final BbButtonSize size;
  final bool block;
  final IconData? iconLeft;
  final IconData? iconRight;
  final bool loading;

  /// Key applied to the underlying Material button (handy for widget tests).
  final Key? buttonKey;

  double get _height => switch (size) {
        BbButtonSize.sm => AppSpacing.controlSm,
        BbButtonSize.md => AppSpacing.controlMd,
        BbButtonSize.lg => AppSpacing.controlLg,
      };

  @override
  Widget build(BuildContext context) {
    // Kit rule: a light haptic on every press. Suppressed while loading or when
    // there is no handler.
    final VoidCallback? effectiveOnPressed = (loading || onPressed == null)
        ? null
        : () {
            HapticFeedback.lightImpact();
            onPressed!();
          };

    // The spinner must sit on each variant's own foreground — a white spinner
    // is invisible on the haldi primary/brand/tonal faces.
    final Color spinnerColor = switch (variant) {
      BbButtonVariant.primary || BbButtonVariant.brand => AppColors.onHaldi,
      BbButtonVariant.navy || BbButtonVariant.success => AppColors.textInverse,
      BbButtonVariant.tonal => AppColors.brandPress,
      BbButtonVariant.secondary || BbButtonVariant.ghost => AppColors.textPrimary,
      BbButtonVariant.danger => AppColors.textInverse,
    };

    final Widget child = _Content(
      label: label,
      iconLeft: iconLeft,
      iconRight: iconRight,
      loading: loading,
      size: size,
      spinnerColor: spinnerColor,
    );

    final Size minSize = Size(block ? double.infinity : 64, _height);
    // Kit law: buttons speak in Anek (display), never Roboto. The button's own
    // foregroundColor still resolves the label colour (Material copies it over
    // this style), so each variant keeps its correct on-face colour.
    final TextStyle labelStyle = AppTypography.display(
      size: size == BbButtonSize.sm ? AppTypography.sizeSm : AppTypography.sizeBase,
      weight: FontWeight.w700,
    );

    final Widget button = switch (variant) {
      BbButtonVariant.secondary => OutlinedButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: OutlinedButton.styleFrom(
            minimumSize: minSize,
            textStyle: labelStyle,
          ),
          child: child,
        ),
      BbButtonVariant.ghost => TextButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: TextButton.styleFrom(
            foregroundColor: AppColors.textPrimary,
            minimumSize: minSize,
            textStyle: labelStyle,
          ),
          child: child,
        ),
      BbButtonVariant.tonal => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(
            backgroundColor: AppColors.brandTint2,
            foregroundColor: AppColors.brandPress,
            minimumSize: minSize,
            textStyle: labelStyle,
            elevation: 0,
          ),
          child: child,
        ),
      // Kit "navy" — deep-blue strong commitment (download / continue).
      BbButtonVariant.navy => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(
            backgroundColor: AppColors.blue,
            foregroundColor: AppColors.onBlue,
            disabledBackgroundColor: AppColors.disabled,
            disabledForegroundColor: AppColors.textSecondary,
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
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(
            backgroundColor: AppColors.success,
            foregroundColor: AppColors.textInverse,
            disabledBackgroundColor: AppColors.disabled,
            disabledForegroundColor: AppColors.textSecondary,
            minimumSize: minSize,
            textStyle: labelStyle,
            elevation: 0,
            shadowColor: Colors.transparent,
          ),
          child: child,
        ),
      BbButtonVariant.brand => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: AppButtonStyles.brand.copyWith(
            minimumSize: WidgetStatePropertyAll<Size>(minSize),
            textStyle: WidgetStatePropertyAll<TextStyle>(labelStyle),
          ),
          child: child,
        ),
      BbButtonVariant.danger => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: AppButtonStyles.danger.copyWith(
            minimumSize: WidgetStatePropertyAll<Size>(minSize),
            textStyle: WidgetStatePropertyAll<TextStyle>(labelStyle),
          ),
          child: child,
        ),
      BbButtonVariant.primary => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(minimumSize: minSize, textStyle: labelStyle),
          child: child,
        ),
    };

    return block ? SizedBox(width: double.infinity, child: button) : button;
  }
}

class _Content extends StatelessWidget {
  const _Content({
    required this.label,
    required this.iconLeft,
    required this.iconRight,
    required this.loading,
    required this.size,
    required this.spinnerColor,
  });

  final String label;
  final IconData? iconLeft;
  final IconData? iconRight;
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
