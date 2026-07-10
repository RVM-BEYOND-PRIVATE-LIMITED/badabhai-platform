import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Centered icon + title + (optional) subtitle + (optional) action — the shared
/// empty / error / consent layout, plus a [BbStatusView.loading] spinner mode.
///
/// Extracted from the swipe feed's private `_StatusView` so every screen reuses
/// one calm, token-driven status surface (see "Desi Vernacular Pop").
class BbStatusView extends StatelessWidget {
  const BbStatusView({
    super.key,
    required IconData this.icon,
    required String this.title,
    this.iconColor = AppColors.textMuted,
    this.subtitle,
    this.action,
  })  : caption = null,
        _loading = false;

  /// Spinner mode: a centered [CircularProgressIndicator] with an optional
  /// [caption] beneath it.
  const BbStatusView.loading({super.key, this.caption})
      : icon = null,
        title = null,
        iconColor = AppColors.textMuted,
        subtitle = null,
        action = null,
        _loading = true;

  final IconData? icon;
  final String? title;
  final Color iconColor;
  final String? subtitle;
  final Widget? action;

  /// Optional text shown under the spinner in loading mode.
  final String? caption;

  final bool _loading;

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const CircularProgressIndicator(),
            if (caption != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s4),
              Text(
                caption!,
                textAlign: TextAlign.center,
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
            ],
          ],
        ),
      );
    }

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.s6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(icon, size: 48, color: iconColor),
            const SizedBox(height: AppSpacing.s4),
            Text(
              title!,
              textAlign: TextAlign.center,
              style: AppTypography.display(size: AppTypography.sizeMd),
            ),
            if (subtitle != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s2),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: AppTypography.body(color: AppColors.textSecondary),
              ),
            ],
            if (action != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s6),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}
