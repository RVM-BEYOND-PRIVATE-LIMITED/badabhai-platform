import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import 'bb_logo.dart';

/// A thin wrapper over [AppBar] for any screen still built on one.
///
/// It now takes its whole paint from `appBarTheme` (navy surface, white title +
/// icons, a light status bar, elevation 0), so there is exactly one place that
/// decides what a BadaBhai app bar looks like.
///
/// **Migrated screens do not use this.** A pushed route uses
/// `ShiftBlueHeader`; a tab root uses `KitTabHeader`. This stays for the
/// leftover and dormant callers.
///
/// Pass [showLogo] to lead with the brand mark, and [actions] for trailing
/// controls — e.g. a notifications bell.
class BbAppBar extends StatelessWidget implements PreferredSizeWidget {
  const BbAppBar({
    super.key,
    required this.title,
    this.actions,
    this.showLogo = false,
    this.automaticallyImplyLeading = true,
    this.dark = false,
  });

  final String title;

  /// Trailing action slot — icons sit at the end of the bar (e.g. a bell).
  final List<Widget>? actions;
  final bool showLogo;
  final bool automaticallyImplyLeading;

  /// **No-op, retained for compatibility.** It used to opt in to the deep-blue
  /// header while the default was a light bar. In v3 the navy chrome is the
  /// only app-bar drawing, so every bar is already "dark" and passing this
  /// changes nothing. Kept so existing call sites compile unchanged.
  final bool dark;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    return AppBar(
      automaticallyImplyLeading: automaticallyImplyLeading,
      leading: showLogo
          ? const Padding(
              padding: EdgeInsets.only(left: AppSpacing.s4),
              child: Center(child: BbLogo(size: 30)),
            )
          : null,
      leadingWidth: showLogo ? 52 : null,
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      actions: actions,
    );
  }
}
