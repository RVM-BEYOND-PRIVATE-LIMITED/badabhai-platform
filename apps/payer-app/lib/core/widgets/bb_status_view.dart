import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import '../theme/bb_palette.dart';

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
    this.iconColor,
    this.subtitle,
    this.action,
  })  : caption = null,
        progress = null,
        _loading = false;

  /// Loading mode: a BRANDED (deep-blue) loader with an optional [caption]. Pass
  /// [progress] (0..1) when the step count is known to get a determinate bar —
  /// the kit prefers that over a spinner and bans bare Material spinners outright.
  const BbStatusView.loading({super.key, this.caption, this.progress})
      : icon = null,
        title = null,
        iconColor = null,
        subtitle = null,
        action = null,
        _loading = true;

  final IconData? icon;
  final String? title;
  final Color? iconColor;
  final String? subtitle;
  final Widget? action;

  /// Optional text shown under the loader in loading mode.
  final String? caption;

  /// Optional 0..1 completion for a DETERMINATE bar in loading mode. Null → an
  /// indeterminate branded (deep-blue) spinner.
  final double? progress;

  final bool _loading;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final Color effectiveIconColor = iconColor ?? p.textMuted;
    if (_loading) {
      final double? fraction = progress?.clamp(0.0, 1.0).toDouble();
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (fraction != null)
              // Determinate bar — preferred when the step count is known.
              SizedBox(
                width: 160,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(AppRadii.pill),
                  child: LinearProgressIndicator(
                    value: fraction,
                    minHeight: 6,
                    backgroundColor: p.inset,
                    color: p.textBrand,
                  ),
                ),
              )
            else
              // Branded deep-blue spinner — never the bare default Material one.
              SizedBox(
                width: 34,
                height: 34,
                child: CircularProgressIndicator(
                  strokeWidth: 3,
                  color: p.textBrand,
                ),
              ),
            if (caption != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s4),
              Text(
                caption!,
                textAlign: TextAlign.center,
                style: AppTypography.body(color: p.textSecondary),
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
            Icon(icon, size: 48, color: effectiveIconColor),
            const SizedBox(height: AppSpacing.s4),
            Text(
              title!,
              textAlign: TextAlign.center,
              style: AppTypography.heading(size: AppTypography.sizeMd),
            ),
            if (subtitle != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s2),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: AppTypography.body(color: p.textSecondary),
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
