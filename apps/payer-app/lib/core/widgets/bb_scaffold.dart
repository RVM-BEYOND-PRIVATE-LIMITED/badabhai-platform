import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';

/// Standard BadaBhai page shell: cream background (from the theme), a safe area,
/// and the shared gutter padding. Keeps a real [Scaffold] underneath so
/// `ScaffoldMessenger` (snackbars) keeps working.
class BbScaffold extends StatelessWidget {
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
  Widget build(BuildContext context) {
    Widget content = body;
    if (padded) {
      content = Padding(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.gutter),
        child: content,
      );
    }
    if (safeArea) {
      content = SafeArea(
        bottom: bottomBar == null,
        child: content,
      );
    }

    Widget? bottom = bottomBar;
    if (bottom != null) {
      bottom = SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.fromLTRB(
            padded ? AppSpacing.gutter : 0,
            AppSpacing.s2,
            padded ? AppSpacing.gutter : 0,
            AppSpacing.s4,
          ),
          child: bottom,
        ),
      );
    }

    return Scaffold(
      appBar: appBar,
      body: content,
      bottomNavigationBar: bottom,
    );
  }
}
