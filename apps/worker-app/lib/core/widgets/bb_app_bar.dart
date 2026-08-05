import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_logo.dart';

/// The BadaBhai header — a thin wrapper over [AppBar] (Josh system). By default
/// it inherits the themed light chrome (cool canvas surface, ink title); pass
/// [dark] on a top-level worker screen for the kit's DEEP-BLUE header (blue
/// surface, white title + icons, light status bar) used on the phone/OTP,
/// resume, and feed screens.
///
/// Pass [showLogo] to lead with the brand mark, and [actions] for trailing
/// controls — e.g. a notifications bell (`IconButton(icon: Icon(Icons.notifications_outlined))`).
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

  /// Render the kit's deep-blue header: blue surface, white title + back/action
  /// icons, and a light status bar. Default `false` keeps the themed light bar so
  /// every existing screen is unchanged.
  final bool dark;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context) {
    return AppBar(
      automaticallyImplyLeading: automaticallyImplyLeading,
      // Deep-blue kit chrome, or `null` to inherit the themed light bar.
      backgroundColor: dark ? AppColors.surfaceInk : null,
      foregroundColor: dark ? AppColors.onBlue : null,
      iconTheme: dark
          ? const IconThemeData(color: AppColors.onBlue)
          : null,
      systemOverlayStyle: dark ? SystemUiOverlayStyle.light : null,
      titleTextStyle: dark
          ? AppTypography.display(
              size: AppTypography.sizeLg,
              weight: FontWeight.w600,
              color: AppColors.onBlue,
            )
          : null,
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
