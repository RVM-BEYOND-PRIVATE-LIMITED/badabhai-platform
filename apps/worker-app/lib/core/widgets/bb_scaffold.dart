import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import 'bottom_bar_inset.dart';

/// Standard BadaBhai page shell: cream background (from the theme), a safe area,
/// and the shared gutter padding. Keeps a real [Scaffold] underneath so
/// `ScaffoldMessenger` (snackbars) keeps working.
///
/// #1071 — when it carries a [bottomBar] it also publishes that bar's measured
/// height to [bottomBarInset], so the app-wide Feedback FAB (which lives above
/// the Navigator and cannot see this page's bottom bar) floats clear of it.
class BbScaffold extends StatefulWidget {
  const BbScaffold({
    super.key,
    this.appBar,
    required this.body,
    this.bottomBar,
    this.padded = true,
    this.safeArea = true,
  });

  final PreferredSizeWidget? appBar;
  final Widget body;

  /// Pinned to the bottom of the screen, outside the scroll area (e.g. a sticky
  /// primary CTA). Already inset by the gutter when [padded].
  final Widget? bottomBar;

  /// Wrap [body] (and [bottomBar]) in the shared [AppSpacing.gutter] padding.
  final bool padded;
  final bool safeArea;

  @override
  State<BbScaffold> createState() => _BbScaffoldState();
}

class _BbScaffoldState extends State<BbScaffold> {
  /// Anchors the PADDED bottom-bar box so its rendered height can be measured
  /// and published to [bottomBarInset]. The measured box excludes the outer
  /// SafeArea's system inset (the FAB adds `MediaQuery.padding.bottom` itself).
  final GlobalKey _bottomBarKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    _publishInset();
  }

  @override
  void didUpdateWidget(BbScaffold oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Re-measure when a bar appears / changes size; when it is REMOVED, drop the
    // inset back to 0. A no-bar → no-bar rebuild deliberately writes NOTHING, so
    // a backgrounded shell scaffold (IndexedStack keeps tabs mounted) cannot
    // clobber the inset a pushed CTA route on top of it published.
    if (widget.bottomBar != null) {
      _publishInset();
    } else if (oldWidget.bottomBar != null) {
      _publishInset();
    }
  }

  @override
  void dispose() {
    // This page is leaving; stop claiming its bottom-bar height. DEFERRED to
    // after the frame: dispose runs during the build / tree-finalize phase, and
    // writing the (listened) notifier synchronously here would markNeedsBuild the
    // FAB overlay mid-build. The closure touches only the global notifier, so it
    // is safe once this State is defunct. An overlay that outlives us falls back
    // to its own default inset (never an overlap).
    WidgetsBinding.instance.addPostFrameCallback((_) => bottomBarInset.value = 0);
    super.dispose();
  }

  /// Publishes this page's bottom-bar height (0 when it has none). Deferred to a
  /// post-frame callback: the render box is only sized after layout, and this
  /// keeps the notifier write out of the build phase.
  void _publishInset() {
    final bool hasBar = widget.bottomBar != null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      bottomBarInset.value =
          hasBar ? (_bottomBarKey.currentContext?.size?.height ?? 0) : 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    Widget content = widget.body;
    if (widget.padded) {
      content = Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
        child: content,
      );
    }
    if (widget.safeArea) {
      content = SafeArea(
        bottom: widget.bottomBar == null,
        child: content,
      );
    }

    Widget? bottom = widget.bottomBar;
    if (bottom != null) {
      bottom = SafeArea(
        top: false,
        child: Padding(
          key: _bottomBarKey,
          padding: EdgeInsets.fromLTRB(
            widget.padded ? AppSpacing.gutter : 0,
            AppSpacing.s2,
            widget.padded ? AppSpacing.gutter : 0,
            AppSpacing.s4,
          ),
          child: bottom,
        ),
      );
    }

    return Scaffold(
      appBar: widget.appBar,
      body: content,
      bottomNavigationBar: bottom,
    );
  }
}
