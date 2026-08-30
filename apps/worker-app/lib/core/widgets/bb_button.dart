import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Visual style of a [BbButton]. The four kit kinds come first; the rest are
/// retained aliases so existing call sites keep compiling.
///
///  - [primary]  — HALDI hero CTA, deep-blue label. The ONE main action per screen.
///  - [navy]     — deep-blue button, white label. Strong secondary commitment
///                 (download / continue / "aur jobs dekho").
///  - [success]  — GREEN button, white label. Money / WhatsApp / done ONLY.
///  - [outline]  — white fill, deep-blue label, 1.5px blue border. Everything else.
///  - [brand]    — alias of [primary] (haldi hero).
///  - [secondary]— quiet outlined button, ink label, grey hairline border.
///  - [tonal]    — soft haldi tint.
///  - [ghost]    — text only.
///  - [danger]   — crimson destructive action, white label.
enum BbButtonVariant {
  primary,
  brand,
  secondary,
  tonal,
  ghost,
  danger,
  navy,
  success,
  outline,
}

/// Control height: [sm] 36 · [md] 44 · [lg] 52 (the worker-app primary CTA).
enum BbButtonSize { sm, md, lg }

/// The one reusable BadaBhai button (JUL31 "Josh" system). Elevation is ALWAYS
/// 0 — separation is fill + hairline, never shadow. The label is **Anek**
/// (display voice; Roboto never rides a button), the corner is [AppRadii.sm]
/// (10), and every press darkens the fill and fires a light haptic.
///
/// Discipline: exactly one HALDI [primary]/[brand] per screen; reserve [success]
/// for money / WhatsApp.
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
    this.allowMultilineLabel = false,
  }) : assert(
          !(size == BbButtonSize.sm &&
              (variant == BbButtonVariant.primary ||
                  variant == BbButtonVariant.brand ||
                  variant == BbButtonVariant.navy ||
                  variant == BbButtonVariant.success ||
                  variant == BbButtonVariant.danger)),
          // #1064 — the 36px `sm` control is below the 48px worker tap floor, so
          // it is banned on the high-emphasis ACTION variants (the hero CTA, its
          // navy/green commitments and the destructive button). It stays allowed
          // on the quiet variants (secondary/ghost/tonal/outline) for dense or
          // decorative use. The check is const-evaluable so `const BbButton(...)`
          // still compiles.
          'primary/CTA buttons must be md/lg — sm is below the 48px tap floor',
        );

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

  /// Opt-in: let [label] wrap onto a second line instead of single-line
  /// ellipsis truncation. DEFAULT FALSE, unchanged everywhere else — every
  /// existing call site keeps today's single-line-ellipsis behaviour.
  /// [Text.overflow] with no `maxLines` set already behaves as `maxLines: 1`
  /// (Flutter's own documented rule), which is exactly what truncated
  /// server-supplied copy that can run long (e.g. the trade-form handover
  /// card's CTA, #1364) — this only widens the ceiling to two lines for the
  /// caller that opts in, with ellipsis kept as the safety net if it still
  /// does not fit.
  final bool allowMultilineLabel;

  double get _height => switch (size) {
        BbButtonSize.sm => AppSpacing.controlSm,
        BbButtonSize.md => AppSpacing.controlMd,
        BbButtonSize.lg => AppSpacing.controlLg,
      };

  @override
  Widget build(BuildContext context) {
    // Light haptic on every press (design system motion §8) — wraps the caller's
    // callback so it fires for every variant. `loading` suppresses the action.
    final VoidCallback? base = loading ? null : onPressed;
    final VoidCallback? effective = base == null
        ? null
        : () {
            HapticFeedback.lightImpact();
            base();
          };

    final Widget child = _Content(
      label: label,
      iconLeft: iconLeft,
      iconRight: iconRight,
      loading: loading,
      size: size,
      allowMultilineLabel: allowMultilineLabel,
    );

    final Size minSize = Size(block ? double.infinity : 64, _height);

    // Anek label — display voice on every button. Never Roboto on a button.
    final double labelSize = size == BbButtonSize.sm ? 13 : 15;
    final TextStyle labelStyle = AppTypography.display(
      size: labelSize,
      weight: FontWeight.w800,
      letterSpacing: -0.2,
    );

    final Widget button = switch (variant) {
      BbButtonVariant.primary || BbButtonVariant.brand => _filled(
          onPressed: effective,
          child: child,
          minSize: minSize,
          labelStyle: labelStyle,
          bg: AppColors.haldi,
          fg: AppColors.onHaldi,
          pressed: AppColors.haldiPressed,
        ),
      BbButtonVariant.navy => _filled(
          onPressed: effective,
          child: child,
          minSize: minSize,
          labelStyle: labelStyle,
          bg: AppColors.blue,
          fg: AppColors.onBlue,
          pressed: AppColors.bluePressed,
        ),
      BbButtonVariant.success => _filled(
          onPressed: effective,
          child: child,
          minSize: minSize,
          labelStyle: labelStyle,
          bg: AppColors.success,
          fg: AppColors.onBlue,
          pressed: AppColors.successPress,
        ),
      BbButtonVariant.danger => _filled(
          onPressed: effective,
          child: child,
          minSize: minSize,
          labelStyle: labelStyle,
          bg: AppColors.danger,
          fg: AppColors.onBlue,
          pressed: AppColors.dangerPress,
        ),
      BbButtonVariant.tonal => _filled(
          onPressed: effective,
          child: child,
          minSize: minSize,
          labelStyle: labelStyle,
          bg: AppColors.brandTint2,
          fg: AppColors.brandPress,
          pressed: AppColors.brandTint,
        ),
      BbButtonVariant.outline => _filled(
          onPressed: effective,
          child: child,
          minSize: minSize,
          labelStyle: labelStyle,
          bg: AppColors.surfaceCard,
          fg: AppColors.blue,
          pressed: AppColors.canvas,
          side: const BorderSide(color: AppColors.blue, width: 1.5),
        ),
      BbButtonVariant.secondary => OutlinedButton(
          key: buttonKey,
          onPressed: effective,
          style: OutlinedButton.styleFrom(
            backgroundColor: AppColors.surfaceCard,
            foregroundColor: AppColors.textPrimary,
            minimumSize: minSize,
            textStyle: labelStyle,
            side: const BorderSide(color: AppColors.borderStrong, width: 1.5),
            shape: _shape,
          ),
          child: child,
        ),
      BbButtonVariant.ghost => TextButton(
          key: buttonKey,
          onPressed: effective,
          style: TextButton.styleFrom(
            foregroundColor: AppColors.textPrimary,
            minimumSize: minSize,
            textStyle: labelStyle,
            shape: _shape,
          ),
          child: child,
        ),
    };

    return block ? SizedBox(width: double.infinity, child: button) : button;
  }

  static const RoundedRectangleBorder _shape = RoundedRectangleBorder(
    borderRadius: BorderRadius.all(Radius.circular(AppRadii.sm)),
  );

  /// A flat [FilledButton] whose fill darkens on press (never a shadow, never a
  /// scale-bounce) and dims to [AppColors.disabled] when disabled.
  Widget _filled({
    required VoidCallback? onPressed,
    required Widget child,
    required Size minSize,
    required TextStyle labelStyle,
    required Color bg,
    required Color fg,
    required Color pressed,
    BorderSide? side,
  }) {
    return FilledButton(
      key: buttonKey,
      onPressed: onPressed,
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith<Color>((states) {
          if (states.contains(WidgetState.disabled)) return AppColors.disabled;
          if (states.contains(WidgetState.pressed)) return pressed;
          return bg;
        }),
        foregroundColor: WidgetStateProperty.resolveWith<Color>((states) =>
            states.contains(WidgetState.disabled) ? AppColors.textMuted : fg),
        side: side == null ? null : WidgetStatePropertyAll<BorderSide>(side),
        elevation: const WidgetStatePropertyAll<double>(0),
        minimumSize: WidgetStatePropertyAll<Size>(minSize),
        padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(
          EdgeInsets.symmetric(horizontal: AppSpacing.s6, vertical: 12),
        ),
        textStyle: WidgetStatePropertyAll<TextStyle>(labelStyle),
        shape: const WidgetStatePropertyAll<OutlinedBorder>(_shape),
      ),
      child: child,
    );
  }
}

class _Content extends StatelessWidget {
  const _Content({
    required this.label,
    required this.iconLeft,
    required this.iconRight,
    required this.loading,
    required this.size,
    required this.allowMultilineLabel,
  });

  final String label;
  final IconData? iconLeft;
  final IconData? iconRight;
  final bool loading;
  final BbButtonSize size;
  final bool allowMultilineLabel;

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
        Flexible(
          child: Text(
            label,
            overflow: TextOverflow.ellipsis,
            // `overflow: ellipsis` with no `maxLines` already behaves as
            // `maxLines: 1` (Flutter's documented rule) — the default here,
            // unchanged. Opting in raises the ceiling to 2 lines with
            // ellipsis kept as the safety net (#1364).
            maxLines: allowMultilineLabel ? 2 : null,
            softWrap: allowMultilineLabel ? true : null,
          ),
        ),
        if (iconRight != null) ...<Widget>[
          const SizedBox(width: AppSpacing.s2),
          Icon(iconRight, size: iconSize),
        ],
      ],
    );
  }
}
