import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The kit's **blue header block** (kit screens 02 · 06 · 07): a full-bleed
/// deep-blue band that carries the status bar, a haldi display headline, and an
/// optional muted subtitle. It is the auth/onboarding chrome — separation is the
/// colour edge, never a shadow (elevation 0, design law §4).
///
/// Full-bleed by design: it is meant to sit at the TOP of a raw [Scaffold]
/// `Column` (NOT inside [BbScaffold]'s gutter), so it draws its own status-bar
/// inset and its own gutter padding. Pass [onBack] on pushed routes to surface a
/// white back affordance in the band.
class BbBlueHeader extends StatelessWidget {
  const BbBlueHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.onBack,
  });

  final String title;
  final String? subtitle;

  /// When non-null, a white back arrow is drawn above the headline (pushed
  /// routes). Omit on gate/root screens (splash → login, consent, unlock).
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: AppColors.blue,
      padding: EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        MediaQuery.of(context).padding.top + AppSpacing.s4,
        AppSpacing.gutter,
        AppSpacing.s5,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (onBack != null) ...<Widget>[
            Align(
              alignment: Alignment.centerLeft,
              // Pull the button left so its glyph lines up with the gutter, while
              // its tap target stays a full 48px (worker-app touch-target floor).
              child: Transform.translate(
                offset: const Offset(-AppSpacing.s3, 0),
                child: IconButton(
                  onPressed: onBack,
                  color: AppColors.onBlue,
                  icon: const Icon(Icons.arrow_back),
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.s1),
          ],
          Text(
            title,
            style: AppTypography.display(
              size: AppTypography.sizeXl,
              color: AppColors.haldi,
            ),
          ),
          if (subtitle != null) ...<Widget>[
            const SizedBox(height: AppSpacing.s1),
            Text(
              subtitle!,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.onBlueMuted,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
