import 'package:flutter/material.dart';

import '../error/payer_failure.dart';
import '../theme/app_colors.dart';
import '../theme/app_haptics.dart';
import '../theme/app_motion.dart';
import 'bb_skeleton.dart';
import 'bb_toast.dart';

/// #2592 (M4) — refreshing without losing the page: pull-to-refresh, stale rows
/// dimmed under a thin progress bar while their replacement loads, a quiet
/// refresh that says why when it fails, and automatic load-more.

/// Pull-to-refresh in the app's voice: the stock Material gesture drawn in the
/// deep-blue structure colour on a paper disc, with a light tap when it fires.
/// The scrollable under it must be able to over-scroll even when short
/// (`AlwaysScrollableScrollPhysics`).
class BbRefreshIndicator extends StatelessWidget {
  const BbRefreshIndicator({
    super.key,
    required this.onRefresh,
    required this.child,
  });

  final Future<void> Function() onRefresh;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      color: AppColors.blue,
      backgroundColor: AppColors.paper,
      onRefresh: () {
        AppHaptics.tap();
        return onRefresh();
      },
      child: child,
    );
  }
}

/// A state that is not a list — an empty state — that still pulls to refresh:
/// [child] fills the viewport (centred content stays centred) over a
/// scrollable that can always over-scroll, and grows past it when taller.
class BbPullableFill extends StatelessWidget {
  const BbPullableFill({
    super.key,
    required this.onRefresh,
    required this.child,
  });

  final Future<void> Function() onRefresh;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return BbRefreshIndicator(
      onRefresh: onRefresh,
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) =>
            SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: child,
          ),
        ),
      ),
    );
  }
}

/// Runs a quiet refresh. The rows stay on screen whatever happens; when the
/// read fails, a toast names the real reason ([PayerFailure.message], or
/// [describe]'s wording) instead of the page silently going stale.
Future<void> refreshWithToast(
  BuildContext context,
  Future<PayerFailure?> Function() refresh, {
  String Function(PayerFailure failure)? describe,
}) async {
  final PayerFailure? failure = await refresh();
  if (failure == null || !context.mounted) return;
  showBbToast(
    context,
    title: "Couldn't refresh",
    message: describe?.call(failure) ?? failure.message,
    icon: failure.icon,
  );
}

/// A row that is about to be replaced (a job or filter change in flight):
/// dimmed to [AppMotion.staleOpacity], easing back to full when the fresh row
/// lands. Opacity only; input is never blocked.
class BbDim extends StatelessWidget {
  const BbDim({super.key, required this.dimmed, required this.child});

  final bool dimmed;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedOpacity(
      opacity: dimmed ? AppMotion.staleOpacity : 1,
      duration: AppMotion.resolve(context, AppMotion.fast),
      curve: dimmed ? AppMotion.easeIn : AppMotion.easeOut,
      child: child,
    );
  }
}

/// [child] with a thin progress bar across its top edge while [busy] — the
/// signal that the dimmed rows below are being replaced. The bar is an
/// indeterminate progress indicator (allowed to loop); under reduced motion it
/// is a static line.
class BbStaleFrame extends StatelessWidget {
  const BbStaleFrame({super.key, required this.busy, required this.child});

  final bool busy;
  final Widget child;

  /// Height of the progress bar.
  static const double barHeight = 3;

  /// Key of the progress bar (for widget tests).
  @visibleForTesting
  static const Key barKey = Key('bb_stale_progress');

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: <Widget>[
        child,
        if (busy)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: barHeight,
            child: AppMotion.reduced(context)
                ? const ColoredBox(key: barKey, color: AppColors.blue)
                : const LinearProgressIndicator(
                    key: barKey,
                    minHeight: barHeight,
                    color: AppColors.blue,
                    backgroundColor: AppColors.borderLight,
                    semanticsLabel: 'Updating',
                  ),
          ),
      ],
    );
  }
}

/// The row at the end of a paged list while its next page loads: one skeleton
/// candidate card, fading in over [AppMotion.loadMoreFade].
class BbLoadMoreRow extends StatelessWidget {
  const BbLoadMoreRow({super.key});

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: AppMotion.resolve(context, AppMotion.loadMoreFade),
      curve: AppMotion.easeOut,
      builder: (BuildContext context, double opacity, Widget? row) =>
          Opacity(opacity: opacity, child: row),
      child: Semantics(
        label: 'Loading more',
        container: true,
        child: const ExcludeSemantics(
          child: BbShimmer(child: BbSkeletonCandidateRow()),
        ),
      ),
    );
  }
}

/// Calls [onLoadMore] once it is built while [enabled] — a lazy list only
/// builds its last item when the end scrolls within the viewport's cache
/// extent, which is exactly "near the end". Fires after the frame (never
/// during build) and again whenever [enabled] turns back on.
class BbLoadMoreTrigger extends StatefulWidget {
  const BbLoadMoreTrigger({
    super.key,
    required this.enabled,
    required this.onLoadMore,
    required this.child,
  });

  final bool enabled;
  final VoidCallback onLoadMore;
  final Widget child;

  @override
  State<BbLoadMoreTrigger> createState() => _BbLoadMoreTriggerState();
}

class _BbLoadMoreTriggerState extends State<BbLoadMoreTrigger> {
  @override
  void initState() {
    super.initState();
    if (widget.enabled) _fireAfterFrame();
  }

  @override
  void didUpdateWidget(BbLoadMoreTrigger oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.enabled && !oldWidget.enabled) _fireAfterFrame();
  }

  void _fireAfterFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.enabled) widget.onLoadMore();
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
