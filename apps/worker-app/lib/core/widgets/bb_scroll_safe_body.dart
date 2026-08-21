import 'package:flutter/material.dart';

/// Scroll-safe body wrapper — the proven idiom extracted from `set_pin_screen`.
///
/// Wraps [child] in `LayoutBuilder → SingleChildScrollView → ConstrainedBox
/// (minHeight = viewport height) → IntrinsicHeight`. This lets a fixed-height
/// [Column] body sit centred / space-between when there is room on a tall screen
/// AND scroll — instead of throwing a `RenderFlex` overflow — on a short/cheap
/// handset or at a large accessibility text scale.
///
/// Why each layer matters:
///  - [LayoutBuilder] hands us the exact viewport height available to the body.
///  - [SingleChildScrollView] makes the body scrollable, so it can never overflow.
///  - [ConstrainedBox] with `minHeight: constraints.maxHeight` forces the content
///    to be AT LEAST as tall as the viewport, so a [Column] with a [Spacer] or
///    `mainAxisAlignment.spaceBetween`/`.center` fills the screen on tall devices.
///  - [IntrinsicHeight] lets that same content grow PAST the viewport on short
///    screens (its intrinsic height wins over the minHeight), which is what the
///    scroll view then scrolls.
///
/// A [Column] with `mainAxisAlignment.spaceBetween` inside this widget keeps its
/// bottom-pinned element at the bottom on tall screens and scrolls on short ones
/// — that is the whole point of the pattern.
///
/// [padding] is applied on the [SingleChildScrollView]. Prefer horizontal-only
/// padding here (as `set_pin_screen` does); when the body needs vertical padding
/// too, keep that padding INSIDE [child] so the minHeight/IntrinsicHeight maths
/// stays exact and tall screens do not gain a spurious scroll.
class BbScrollSafeBody extends StatelessWidget {
  const BbScrollSafeBody({super.key, required this.child, this.padding});

  final Widget child;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        return SingleChildScrollView(
          padding: padding,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: IntrinsicHeight(child: child),
          ),
        );
      },
    );
  }
}
