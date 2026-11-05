import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import 'bb_card.dart';

/// #2592 (M4) — skeleton loading.
///
/// A screen- or list-level wait draws placeholder blocks SHAPED LIKE what it
/// is waiting for — a candidate card, a job card, a ledger line — instead of a
/// centred spinner, so the page keeps its structure and the real rows
/// cross-fade in over it ([BbLoadSwitcher]).
///
/// Existing colour tokens only: the blocks are [AppColors.border] on paper
/// cards, and the shimmer sweeps an [AppColors.borderLight] band across them
/// once every [AppMotion.shimmer]. The shimmer is a progress indicator — the
/// one loop the motion rules allow — and it stops (static blocks) when the OS
/// asks for animations to be removed.

/// Padding of the app's tab lists — a skeleton sits exactly where the rows will.
const EdgeInsets kBbListPadding = EdgeInsets.fromLTRB(
  AppSpacing.gutter,
  AppSpacing.s2,
  AppSpacing.gutter,
  AppSpacing.s6,
);

/// Owns the shimmer clock for every [BbSkeletonMask] below it, so one list of
/// skeleton cards sweeps in step off a single ticker. Under reduced motion the
/// ticker never starts and the masks paint their blocks flat.
class BbShimmer extends StatefulWidget {
  const BbShimmer({super.key, required this.child});

  final Widget child;

  @override
  State<BbShimmer> createState() => _BbShimmerState();
}

class _BbShimmerState extends State<BbShimmer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller =
      AnimationController(vsync: this, duration: AppMotion.shimmer);

  bool _reduced = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = AppMotion.reduced(context);
    if (_reduced) {
      _controller.stop();
    } else if (!_controller.isAnimating) {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _ShimmerScope(
      animation: _reduced ? null : _controller,
      child: widget.child,
    );
  }
}

class _ShimmerScope extends InheritedWidget {
  const _ShimmerScope({required this.animation, required super.child});

  /// Null when animations are disabled — the blocks paint flat.
  final Animation<double>? animation;

  static Animation<double>? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<_ShimmerScope>()?.animation;

  @override
  bool updateShouldNotify(_ShimmerScope oldWidget) =>
      animation != oldWidget.animation;
}

/// Sweeps the shimmer band across the [BbSkeletonBox]es in [child]. Only the
/// blocks are painted over (`srcATop`): the card under them keeps its paper
/// surface and hairline. Without a [BbShimmer] above it — or under reduced
/// motion — the blocks are drawn flat.
class BbSkeletonMask extends StatelessWidget {
  const BbSkeletonMask({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final Animation<double>? sweep = _ShimmerScope.of(context);
    if (sweep == null) return child;
    return AnimatedBuilder(
      animation: sweep,
      child: child,
      builder: (BuildContext context, Widget? blocks) => ShaderMask(
        blendMode: BlendMode.srcATop,
        shaderCallback: (Rect bounds) => LinearGradient(
          colors: const <Color>[
            AppColors.border,
            AppColors.borderLight,
            AppColors.border,
          ],
          stops: const <double>[0.35, 0.5, 0.65],
          transform: _SweepTransform(sweep.value),
        ).createShader(bounds),
        child: blocks,
      ),
    );
  }
}

/// Slides the gradient from one bounds-width left of the box to one right of
/// it over a cycle, so the band enters and leaves fully.
class _SweepTransform extends GradientTransform {
  const _SweepTransform(this.t);

  final double t;

  @override
  Matrix4 transform(Rect bounds, {TextDirection? textDirection}) =>
      Matrix4.translationValues(bounds.width * (t * 2 - 1), 0, 0);
}

/// One placeholder block. Give it a fixed [width], or a [widthFactor] of the
/// space it sits in (a text line), or neither to fill the row.
class BbSkeletonBox extends StatelessWidget {
  const BbSkeletonBox({
    super.key,
    this.width,
    this.widthFactor,
    this.height = 12,
    this.radius = AppRadii.xs,
  });

  /// A round block — an avatar.
  const BbSkeletonBox.circle({super.key, required double size})
      : width = size,
        widthFactor = null,
        height = size,
        radius = AppRadii.pill;

  final double? width;
  final double? widthFactor;
  final double height;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final Widget block = Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: AppColors.border,
        borderRadius: BorderRadius.circular(radius),
      ),
    );
    if (widthFactor == null) return block;
    return FractionallySizedBox(
      widthFactor: widthFactor,
      alignment: AlignmentDirectional.centerStart,
      child: block,
    );
  }
}

/// A list header — the eyebrow and the title line.
class BbSkeletonHeader extends StatelessWidget {
  const BbSkeletonHeader({super.key});

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.only(bottom: AppSpacing.s4),
      child: BbSkeletonMask(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            BbSkeletonBox(width: 120, height: 10),
            SizedBox(height: AppSpacing.s2),
            BbSkeletonBox(width: 180, height: 22),
          ],
        ),
      ),
    );
  }
}

/// A candidate / applicant card: the masked avatar, the label and facet
/// lines, a badge, and the unlock button on the right.
class BbSkeletonCandidateRow extends StatelessWidget {
  const BbSkeletonCandidateRow({super.key});

  @override
  Widget build(BuildContext context) {
    return const BbCard(
      child: BbSkeletonMask(
        child: Row(
          children: <Widget>[
            BbSkeletonBox.circle(size: 50),
            SizedBox(width: AppSpacing.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  BbSkeletonBox(widthFactor: 0.55, height: 14),
                  SizedBox(height: AppSpacing.s2),
                  BbSkeletonBox(widthFactor: 0.8, height: 10),
                  SizedBox(height: AppSpacing.s2),
                  BbSkeletonBox(width: 72, height: 18, radius: AppRadii.pill),
                ],
              ),
            ),
            SizedBox(width: AppSpacing.s2),
            BbSkeletonBox(
              width: 76,
              height: AppSpacing.controlMd,
              radius: AppRadii.md,
            ),
          ],
        ),
      ),
    );
  }
}

/// A job posting card: the title and status pill, the meta line, the quota
/// meter, and the action buttons.
class BbSkeletonJobRow extends StatelessWidget {
  const BbSkeletonJobRow({super.key});

  @override
  Widget build(BuildContext context) {
    return const BbCard(
      child: BbSkeletonMask(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Row(
              children: <Widget>[
                Expanded(child: BbSkeletonBox(widthFactor: 0.6, height: 16)),
                SizedBox(width: AppSpacing.s3),
                BbSkeletonBox(width: 56, height: 20, radius: AppRadii.pill),
              ],
            ),
            SizedBox(height: AppSpacing.s2),
            BbSkeletonBox(widthFactor: 0.75, height: 10),
            SizedBox(height: AppSpacing.s3),
            BbSkeletonBox(height: 10, radius: AppRadii.pill),
            SizedBox(height: AppSpacing.s3),
            Row(
              children: <Widget>[
                BbSkeletonBox(
                  width: 96,
                  height: AppSpacing.controlSm,
                  radius: AppRadii.md,
                ),
                SizedBox(width: AppSpacing.s2),
                BbSkeletonBox(
                  width: 96,
                  height: AppSpacing.controlSm,
                  radius: AppRadii.md,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// One ledger line — a label and an amount — inside a ledger card.
class BbSkeletonLedgerRow extends StatelessWidget {
  const BbSkeletonLedgerRow({super.key, this.showBorder = true});

  final bool showBorder;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        border: showBorder
            ? const Border(bottom: BorderSide(color: AppColors.divider))
            : null,
      ),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s3),
      child: const BbSkeletonMask(
        child: Row(
          children: <Widget>[
            Expanded(child: BbSkeletonBox(widthFactor: 0.55)),
            SizedBox(width: AppSpacing.s4),
            BbSkeletonBox(width: 44),
          ],
        ),
      ),
    );
  }
}

/// A card of [count] ledger lines (the Credits ledger, the unlock history).
class BbSkeletonLedgerCard extends StatelessWidget {
  const BbSkeletonLedgerCard({super.key, this.count = 4});

  final int count;

  @override
  Widget build(BuildContext context) {
    return BbCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s4),
      child: Column(
        children: <Widget>[
          for (int i = 0; i < count; i++)
            BbSkeletonLedgerRow(showBorder: i < count - 1),
        ],
      ),
    );
  }
}

/// A plain list row card — an icon or avatar and two lines (a team member, a
/// referred worker, a disclosure).
class BbSkeletonListRow extends StatelessWidget {
  const BbSkeletonListRow({super.key});

  @override
  Widget build(BuildContext context) {
    return const BbCard(
      child: BbSkeletonMask(
        child: Row(
          children: <Widget>[
            BbSkeletonBox.circle(size: 40),
            SizedBox(width: AppSpacing.s3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  BbSkeletonBox(widthFactor: 0.5, height: 14),
                  SizedBox(height: AppSpacing.s2),
                  BbSkeletonBox(widthFactor: 0.7, height: 10),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A summary card — a label, a big figure, and a supporting line (a balance,
/// an account, a capacity meter, a relay handle).
class BbSkeletonPanel extends StatelessWidget {
  const BbSkeletonPanel({super.key, this.card = true});

  /// False when the caller already supplies the card around it.
  final bool card;

  @override
  Widget build(BuildContext context) {
    const Widget blocks = BbSkeletonMask(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          BbSkeletonBox(widthFactor: 0.4, height: 10),
          SizedBox(height: AppSpacing.s3),
          BbSkeletonBox(widthFactor: 0.6, height: 22),
          SizedBox(height: AppSpacing.s3),
          BbSkeletonBox(widthFactor: 0.85, height: 10),
        ],
      ),
    );
    return card ? const BbCard(child: blocks) : blocks;
  }
}

/// A chat transcript's first bubbles — alternating sides.
class BbSkeletonChat extends StatelessWidget {
  const BbSkeletonChat({super.key});

  @override
  Widget build(BuildContext context) {
    Widget bubble(double widthFactor, double height, {required bool mine}) =>
        Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.s3),
          child: Align(
            alignment: mine
                ? AlignmentDirectional.centerEnd
                : AlignmentDirectional.centerStart,
            child: FractionallySizedBox(
              widthFactor: widthFactor,
              child: BbSkeletonBox(height: height, radius: AppRadii.bubble),
            ),
          ),
        );
    return BbSkeletonMask(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          bubble(0.72, 56, mine: false),
          bubble(0.5, 40, mine: true),
          bubble(0.64, 72, mine: false),
        ],
      ),
    );
  }
}

/// [count] copies of [row] (or the given [items]) under an optional
/// [header], padded like the list it stands in for, shimmering off one clock.
/// It never scrolls (it is only on screen until the content lands) and never
/// claims the tab's primary scroll controller. Screen readers hear
/// [semanticLabel] once, not the blocks.
class BbSkeletonList extends StatelessWidget {
  const BbSkeletonList({
    super.key,
    this.row,
    this.count = 4,
    this.items,
    this.header,
    this.padding = kBbListPadding,
    this.semanticLabel = 'Loading',
  }) : assert(row != null || items != null, 'give a row or items');

  final Widget? row;
  final int count;

  /// A mixed skeleton (a balance panel over a ledger card) instead of
  /// [count] × [row].
  final List<Widget>? items;
  final Widget? header;
  final EdgeInsetsGeometry padding;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final List<Widget> blocks =
        items ?? <Widget>[for (int i = 0; i < count; i++) row!];
    return Semantics(
      label: semanticLabel,
      container: true,
      child: ExcludeSemantics(
        child: BbShimmer(
          child: SingleChildScrollView(
            primary: false,
            physics: const NeverScrollableScrollPhysics(),
            padding: padding,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                if (header != null) header!,
                for (final Widget block in blocks)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpacing.s3),
                    child: block,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Cross-fades [skeleton] out and the real [child] in over
/// [AppMotion.contentFade] (ease-out in, ease-in out) when [loading] turns
/// false — and back the other way when a load starts over. Changes INSIDE the
/// content (a refresh, a new page) are not a swap and never re-fade. Instant
/// under reduced motion.
class BbLoadSwitcher extends StatelessWidget {
  const BbLoadSwitcher({
    super.key,
    required this.loading,
    required this.skeleton,
    this.child,
  });

  final bool loading;
  final Widget skeleton;

  /// The content. Unused (may be null) while [loading].
  final Widget? child;

  static const Key _skeletonKey = ValueKey<String>('bb_load_skeleton');
  static const Key _contentKey = ValueKey<String>('bb_load_content');

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: AppMotion.resolve(context, AppMotion.contentFade),
      switchInCurve: AppMotion.easeOut,
      switchOutCurve: AppMotion.easeIn,
      layoutBuilder: (Widget? current, List<Widget> previous) => Stack(
        alignment: Alignment.topCenter,
        fit: StackFit.passthrough,
        children: <Widget>[...previous, if (current != null) current],
      ),
      transitionBuilder: (Widget child, Animation<double> animation) =>
          FadeTransition(opacity: animation, child: child),
      child: loading || child == null
          ? KeyedSubtree(key: _skeletonKey, child: skeleton)
          : KeyedSubtree(key: _contentKey, child: child!),
    );
  }
}

/// A [BlocBuilder] whose loading states draw [skeleton] and cross-fade into
/// whatever [builder] returns once [isLoading] is false ([BbLoadSwitcher]).
/// [builder] is only called for a state that has content to show.
class BbLoadingBuilder<B extends StateStreamable<S>, S>
    extends StatelessWidget {
  const BbLoadingBuilder({
    super.key,
    required this.isLoading,
    required this.skeleton,
    required this.builder,
    this.bloc,
  });

  final bool Function(S state) isLoading;
  final Widget skeleton;
  final BlocWidgetBuilder<S> builder;
  final B? bloc;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<B, S>(
      bloc: bloc,
      builder: (BuildContext context, S state) {
        final bool loading = isLoading(state);
        return BbLoadSwitcher(
          loading: loading,
          skeleton: skeleton,
          child: loading ? null : builder(context, state),
        );
      },
    );
  }
}

/// For a list whose HEADER stays put while its rows load (Find's All
/// candidates): rows wrapped in [BbRevealFade] fade in over
/// [AppMotion.contentFade] when [loading] turns false. A row built later — one
/// scrolled into view, the next page — is simply there; nothing re-fades.
class BbRowsReveal extends StatefulWidget {
  const BbRowsReveal({super.key, required this.loading, required this.child});

  final bool loading;
  final Widget child;

  @override
  State<BbRowsReveal> createState() => _BbRowsRevealState();
}

class _BbRowsRevealState extends State<BbRowsReveal>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller =
      AnimationController(vsync: this, value: widget.loading ? 0 : 1);
  late final CurvedAnimation _opacity =
      CurvedAnimation(parent: _controller, curve: AppMotion.easeOut);

  @override
  void didUpdateWidget(BbRowsReveal oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.loading && !widget.loading) {
      _controller.duration = AppMotion.resolve(context, AppMotion.contentFade);
      _controller.forward(from: 0);
    } else if (!oldWidget.loading && widget.loading) {
      _controller.value = 0;
    }
  }

  @override
  void dispose() {
    _opacity.dispose();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return _RevealScope(opacity: _opacity, child: widget.child);
  }
}

class _RevealScope extends InheritedWidget {
  const _RevealScope({required this.opacity, required super.child});

  final Animation<double> opacity;

  @override
  bool updateShouldNotify(_RevealScope oldWidget) =>
      opacity != oldWidget.opacity;
}

/// One row of a [BbRowsReveal] list. Fully opaque outside one.
class BbRevealFade extends StatelessWidget {
  const BbRevealFade({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final Animation<double>? opacity =
        context.dependOnInheritedWidgetOfExactType<_RevealScope>()?.opacity;
    if (opacity == null) return child;
    return FadeTransition(opacity: opacity, child: child);
  }
}
