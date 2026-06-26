import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import 'bb_logo.dart';

/// The BadaBhai header. A thin wrapper over [AppBar] so every screen gets the
/// themed cream chrome and Baloo 2 title for free; pass [showLogo] on top-level
/// screens to lead with the brand mark.
class BbAppBar extends StatelessWidget implements PreferredSizeWidget {
  const BbAppBar({
    super.key,
    required this.title,
    this.actions,
    this.showLogo = false,
    this.automaticallyImplyLeading = true,
  });

  final String title;
  final List<Widget>? actions;
  final bool showLogo;
  final bool automaticallyImplyLeading;

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
      title: Text(title),
      actions: actions,
    );
  }
}
