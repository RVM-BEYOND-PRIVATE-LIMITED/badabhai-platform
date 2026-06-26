import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_theme.dart';
import '../theme/app_typography.dart';

/// Visual style of a [BbButton].
///
///  - [primary]  — green action CTA (the everyday worker action: Apply, Continue).
///  - [brand]    — vermilion brand CTA (logo moments / brand highlights).
///  - [secondary]— outlined, ink on white (the quiet alternative).
///  - [tonal]    — soft vermilion tint.
///  - [ghost]    — text only.
///  - [danger]   — crimson destructive action.
enum BbButtonVariant { primary, brand, secondary, tonal, ghost, danger }

/// Control height: [sm] 36 · [md] 44 · [lg] 52 (the worker-app primary CTA).
enum BbButtonSize { sm, md, lg }

/// The one reusable BadaBhai button. Built on Material's button family so it
/// inherits [AppTheme] and keeps native ink/press; never hand-roll a button.
///
/// `primary` is the single green CTA per screen — quieten everything else with
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
    final VoidCallback? effectiveOnPressed = loading ? null : onPressed;

    final Widget child = _Content(
      label: label,
      iconLeft: iconLeft,
      iconRight: iconRight,
      loading: loading,
      size: size,
    );

    final Size minSize = Size(block ? double.infinity : 64, _height);
    final TextStyle? textStyle = switch (size) {
      BbButtonSize.sm => AppTypography.body(
          size: AppTypography.sizeSm, weight: FontWeight.w700),
      _ => null, // inherit labelLarge from the theme
    };

    final Widget button = switch (variant) {
      BbButtonVariant.secondary => OutlinedButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: OutlinedButton.styleFrom(
            minimumSize: minSize,
            textStyle: textStyle,
          ),
          child: child,
        ),
      BbButtonVariant.ghost => TextButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: TextButton.styleFrom(
            foregroundColor: AppColors.textPrimary,
            minimumSize: minSize,
            textStyle: textStyle,
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
            textStyle: textStyle,
            elevation: 0,
          ),
          child: child,
        ),
      BbButtonVariant.brand => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: AppButtonStyles.brand.copyWith(
            minimumSize: WidgetStatePropertyAll<Size>(minSize),
          ),
          child: child,
        ),
      BbButtonVariant.danger => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: AppButtonStyles.danger.copyWith(
            minimumSize: WidgetStatePropertyAll<Size>(minSize),
          ),
          child: child,
        ),
      BbButtonVariant.primary => FilledButton(
          key: buttonKey,
          onPressed: effectiveOnPressed,
          style: FilledButton.styleFrom(minimumSize: minSize, textStyle: textStyle),
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
  });

  final String label;
  final IconData? iconLeft;
  final IconData? iconRight;
  final bool loading;
  final BbButtonSize size;

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
            child: const CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
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
