import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_page_transitions.dart';

/// Hosts an in-shell overlay (Post, Credits, Reveal, AI chat) above a [base]
/// subtree and animates it in AND out with the page transition (#2591, M3) —
/// these overlays are setState state, not routes, so they used to hard-cut.
///
/// While an overlay is fully shown the [base] is kept MOUNTED but offstage
/// (same contract as the old IndexedStack slot: tab state survives, nothing
/// hidden is hit-testable or found by default finders). During the transition
/// both are onstage so the overlay can fade over the tab. The leaving overlay
/// stops taking input at once — motion never delays input. With animations
/// disabled the swap is instant.
class BbOverlayHost extends StatefulWidget {
  const BbOverlayHost({super.key, required this.base, this.overlay});

  /// The always-mounted content under the overlay (the tab stack).
  final Widget base;

  /// The overlay to show, or null for none. Rebuilt in place while shown.
  final Widget? overlay;

  @override
  State<BbOverlayHost> createState() => _BbOverlayHostState();
}

class _BbOverlayHostState extends State<BbOverlayHost>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.page,
    value: widget.overlay == null ? 0 : 1,
  )..addStatusListener(_onStatus);

  /// The overlay currently painted — kept after [BbOverlayHost.overlay] goes
  /// null so it can animate out.
  Widget? _shown;

  @override
  void initState() {
    super.initState();
    _shown = widget.overlay;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _controller.duration = AppMotion.resolve(context, AppMotion.page);
  }

  @override
  void didUpdateWidget(BbOverlayHost oldWidget) {
    super.didUpdateWidget(oldWidget);
    final Widget? next = widget.overlay;
    if (next != null) {
      _shown = next;
      if (_controller.status != AnimationStatus.completed &&
          _controller.status != AnimationStatus.forward) {
        _controller.forward();
      }
    } else if (_shown != null &&
        _controller.status != AnimationStatus.dismissed &&
        _controller.status != AnimationStatus.reverse) {
      _controller.reverse();
    }
  }

  void _onStatus(AnimationStatus status) {
    if (!mounted) return;
    // Rebuild on every edge: completed hides the base, dismissed drops the
    // overlay, forward/reverse put the base back on stage.
    if (status == AnimationStatus.dismissed && widget.overlay == null) {
      _shown = null;
    }
    // A zero-duration (reduced-motion) run completes synchronously inside
    // didUpdateWidget, i.e. mid-build, where this state builds next anyway.
    if (SchedulerBinding.instance.schedulerPhase !=
        SchedulerPhase.persistentCallbacks) {
      setState(() {});
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Widget? shown = _shown;
    final bool covered =
        shown != null && _controller.status == AnimationStatus.completed;
    final bool leaving = widget.overlay == null;
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        // Always the first child, always the same widget type: switching the
        // overlay never reparents (so never remounts) the base.
        Offstage(
          offstage: covered,
          child: TickerMode(enabled: !covered, child: widget.base),
        ),
        if (shown != null)
          IgnorePointer(
            ignoring: leaving,
            child: BbFadeSlideTransition(
              animation: _controller,
              // Opaque canvas so the tab under a half-faded overlay never
              // shows through its text.
              child: ColoredBox(color: AppColors.surfacePage, child: shown),
            ),
          ),
      ],
    );
  }
}
