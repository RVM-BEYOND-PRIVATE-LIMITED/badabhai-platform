import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_spacing.dart';
import '../theme/app_theme.dart';
import '../theme/onboarding_theme.dart';

/// Visual style of a [BbButton]. The four kit kinds come first; the rest are
/// retained aliases so existing call sites keep compiling.
///
///  - [primary]  — safety-yellow hero CTA, shift-blue label. ONE per screen.
///  - [navy]     — shift-blue button, white label. Strong secondary commitment
///                 (download / continue / "aur jobs dekho").
///  - [success]  — GREEN button, white label. Money / WhatsApp / done ONLY.
///  - [outline]  — white fill, navy label, navy border. Everything else.
///  - [brand]    — alias of [primary].
///  - [secondary]— quiet outlined button, ink label, grey hairline border.
///  - [tonal]    — soft yellow wash behind a navy label.
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

/// Control height: [sm] 36 · [md] 48 · [lg] 52 (the worker-app primary CTA).
enum BbButtonSize { sm, md, lg }

/// The one reusable BadaBhai button (UI kit v3). Elevation is ALWAYS 0 —
/// separation is fill + hairline, never a shadow. The label is **Anek Latin**
/// (the display voice; Inter never rides a button), the corner is
/// [OnboardingRadii.docked] (12), and every press darkens the fill and fires a
/// light haptic.
///
/// Every paint comes from [KitButtonStyles], so a button here and a docked CTA
/// on a questionnaire cannot drift apart.
///
/// Discipline: exactly one [primary]/[brand] per screen; reserve [success] for
/// money / WhatsApp.
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
    // 48, not the generic dense 44: a real button owes the touch floor.
    BbButtonSize.md => OnboardingLayout.dockedButtonHeight,
    BbButtonSize.lg => AppSpacing.controlLg,
  };

  /// The label's ink, so the loading spinner can match it instead of always
  /// being white on a yellow button.
  Color get _foreground => switch (variant) {
    BbButtonVariant.primary ||
    BbButtonVariant.brand ||
    BbButtonVariant.tonal => OnboardingColors.shiftBlue,
    BbButtonVariant.navy ||
    BbButtonVariant.success ||
    BbButtonVariant.danger => OnboardingColors.textOnBlue,
    BbButtonVariant.outline ||
    BbButtonVariant.ghost => OnboardingColors.shiftBlue,
    BbButtonVariant.secondary => OnboardingColors.ink900,
  };

  ButtonStyle get _base => switch (variant) {
    BbButtonVariant.primary || BbButtonVariant.brand => KitButtonStyles.primary,
    BbButtonVariant.navy => KitButtonStyles.navy,
    BbButtonVariant.success => KitButtonStyles.success,
    BbButtonVariant.danger => KitButtonStyles.danger,
    BbButtonVariant.tonal => KitButtonStyles.tonal,
    BbButtonVariant.outline => KitButtonStyles.outline,
    BbButtonVariant.secondary => KitButtonStyles.secondary,
    BbButtonVariant.ghost => KitButtonStyles.ghost,
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
      spinnerColor: _foreground,
      allowMultilineLabel: allowMultilineLabel,
    );

    // Anek label — the display voice on every button.
    final double labelSize = switch (size) {
      BbButtonSize.sm => 13,
      BbButtonSize.md => 14,
      BbButtonSize.lg => 16,
    };
    final ButtonStyle style = _base.copyWith(
      minimumSize: WidgetStatePropertyAll<Size>(
        Size(block ? double.infinity : 64, _height),
      ),
      // Vertical padding matters: `minimumSize` is a FLOOR, so a label that
      // wraps to two lines has to be able to push the button taller than it
      // (#1364). With horizontal-only padding a wrapped label just sat inside
      // the 52dp minimum and clipped.
      padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(
        EdgeInsets.symmetric(horizontal: 24, vertical: 12),
      ),
      textStyle: WidgetStatePropertyAll<TextStyle>(
        OnboardingTypography.anek(
          size: labelSize,
          weight: FontWeight.w800,
          letterSpacing: 0.3,
        ),
      ),
    );

    final Widget button = switch (variant) {
      // The quiet variants keep their Material TYPES: widget tests find them
      // by type, and an OutlinedButton/TextButton also carries the right
      // default semantics for a non-filled control.
      BbButtonVariant.secondary => OutlinedButton(
        key: buttonKey,
        onPressed: effective,
        style: style,
        child: child,
      ),
      BbButtonVariant.ghost => TextButton(
        key: buttonKey,
        onPressed: effective,
        style: style,
        child: child,
      ),
      _ => FilledButton(
        key: buttonKey,
        onPressed: effective,
        style: style,
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
    required this.allowMultilineLabel,
  });

  final String label;
  final IconData? iconLeft;
  final IconData? iconRight;
  final bool loading;
  final BbButtonSize size;
  final Color spinnerColor;
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
            child: CircularProgressIndicator(
              strokeWidth: 2,
              // The spinner reads as the label does. A hardcoded white one was
              // invisible on the yellow and white variants.
              valueColor: AlwaysStoppedAnimation<Color>(spinnerColor),
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
