import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import 'bb_pressable.dart';

/// The BadaBhai card surface — `.bb-card`. JUL31: white on canvas, **no
/// shadow** — separated by a single 1px hairline, 10px corners. Variants cover
/// the design system's modifiers used across the payer app:
///
///  - default      — plain white card, 1px hairline border.
///  - [ink]        — dark deep-blue surface (balance / earn summary blocks).
///  - [festive]    — 3px double-haldi border (hero stat, revealed profile).
///  - [featured]   — 4px haldi LEFT RAIL (the kit's mark for a HOT / featured
///    card — earned, never uniform).
///  - [interactive]— adds a tap ripple + min 48px target for row-style cards.
///
/// Pass [border] to override the outline (e.g. a "Best value" pack), or
/// [gradient] for the saffron Agency Earn surface.
class BbCard extends StatelessWidget {
  const BbCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.s4),
    this.ink = false,
    this.festive = false,
    this.featured = false,
    this.border,
    this.gradient,
    this.onTap,
    this.opacity = 1,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool ink;
  final bool festive;

  /// Draws the 4px haldi left rail — the JUL31 mark for a featured / HOT card.
  /// Earned, never uniform: reserve it for the single hero card in a list.
  final bool featured;
  final BoxBorder? border;
  final Gradient? gradient;
  final VoidCallback? onTap;

  /// Dim a filled / expired row (the design system dims at ~0.6).
  final double opacity;

  @override
  Widget build(BuildContext context) {
    // #2596 — a host may repaint a default card's surface ([BbCardSurfaceTint]);
    // ink and gradient surfaces keep their own, and nothing ON the card changes.
    final BbCardSurfaceTint? tint = BbCardSurfaceTint._maybeOf(context);
    final Color background =
        ink ? AppColors.surfaceInk : (tint?.color ?? AppColors.surfaceCard);
    // A card nested on a tinted one stays on its own surface.
    final Widget body =
        tint == null ? child : BbCardSurfaceTint(color: null, child: child);

    // JUL31: separation is a 1px hairline, never a shadow. Festive keeps its
    // 3px double-haldi hero border; ink / gradient surfaces carry their own edge.
    final BoxBorder? effectiveBorder = border ??
        (festive
            ? Border.all(color: AppColors.brandBorder, width: 3)
            : (ink || gradient != null
                ? null
                : Border.all(color: AppColors.border)));

    final BorderRadius radius = BorderRadius.circular(AppRadii.lg);

    final bool tappable = onTap != null;
    final BoxDecoration surface = BoxDecoration(
      color: gradient == null ? background : null,
      gradient: gradient,
      borderRadius: radius,
      border: effectiveBorder,
    );

    // #2591 — a tappable card paints its surface with [Ink], on the same
    // Material layer as the ripple, so the splash shows ON the card. A plain
    // Container decoration paints above the ink layer and hid every ripple.
    Widget paint({required Widget child, EdgeInsetsGeometry? pad}) {
      final Widget padded =
          pad == null ? child : Padding(padding: pad, child: child);
      return tappable
          ? Ink(decoration: surface, child: padded)
          : Container(
              padding: pad,
              // Clip content to the rounded outline so long/overflowing
              // children never paint past the hairline corners.
              clipBehavior: Clip.antiAlias,
              decoration: surface,
              child: child,
            );
    }

    Widget content;
    if (featured) {
      // The haldi rail is a single-side border, so it can't share the rounded
      // outline directly (Flutter forbids a non-uniform border with a radius).
      // Draw the surface + hairline on an outer layer, clip to the radius, then
      // lay the 4px rail on the padded inner layer — mirroring the kit's card.
      content = paint(
        child: ClipRRect(
          borderRadius: radius,
          child: Container(
            padding: padding,
            decoration: const BoxDecoration(
              border: Border(
                left: BorderSide(color: AppColors.haldi, width: AppSpacing.s1),
              ),
            ),
            child: body,
          ),
        ),
      );
    } else {
      content = paint(pad: padding, child: body);
    }

    if (tappable) {
      // Clip the ink (surface + ripple) to the card's rounded outline.
      content = ClipRRect(
        borderRadius: radius,
        child: BbPressable(
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: AppSpacing.tap),
            child: content,
          ),
        ),
      );
    }

    if (opacity < 1) {
      content = Opacity(opacity: opacity, child: content);
    }
    return content;
  }
}

/// Repaints the surface of the [BbCard] directly below it — only the surface:
/// text, icons, buttons, badges and the hairline on the card keep their exact
/// tokens. The one way a list marks a single row without recolouring what is
/// on it (#2596: the just-posted job, [AppColors.haldiTint] easing back to
/// [AppColors.surfaceCard]).
///
/// Only a default (white) card reads it; an ink or gradient card keeps its
/// surface. Keep the scope in the tree for the row's life and pass a null
/// [color] when done, so the card's subtree is never re-parented.
class BbCardSurfaceTint extends InheritedWidget {
  const BbCardSurfaceTint({
    super.key,
    required this.color,
    required super.child,
  });

  /// The card's surface colour; null leaves it on [AppColors.surfaceCard].
  final Color? color;

  static BbCardSurfaceTint? _maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<BbCardSurfaceTint>();

  @override
  bool updateShouldNotify(BbCardSurfaceTint oldWidget) =>
      color != oldWidget.color;
}
