import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_typography.dart';

/// Visual mode of a [BbAvatar] — `.bb-avatar--*`.
///
///  - [brand]  — vermilion-tinted, brand-bordered: an identified account or a
///    revealed candidate.
///  - [masked] — sunken grey, "••" initials: a faceless candidate in the feed.
enum BbAvatarMode { brand, masked }

/// A circular initials avatar — `.bb-avatar`. Optional green [sealed] check in
/// the corner (a verified worker). In [BbAvatarMode.masked] it shows the blurred
/// "••" placeholder used before a paid unlock; the avatar carries NO photo and
/// NO demographic signal.
class BbAvatar extends StatelessWidget {
  const BbAvatar({
    super.key,
    required this.initials,
    this.size = 50,
    this.mode = BbAvatarMode.brand,
    this.sealed = false,
  });

  final String initials;
  final double size;
  final BbAvatarMode mode;
  final bool sealed;

  @override
  Widget build(BuildContext context) {
    final bool masked = mode == BbAvatarMode.masked;
    final Color background = masked ? AppColors.surfaceSunken : AppColors.brandTint;
    final Color foreground = masked ? AppColors.textFaint : AppColors.brandPress;
    final Color borderColor = masked ? AppColors.borderSubtle : AppColors.brandBorder;

    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Container(
            width: size,
            height: size,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: background,
              shape: BoxShape.circle,
              border: Border.all(color: borderColor, width: 2),
            ),
            child: Text(
              initials,
              style: AppTypography.display(
                size: size * 0.36,
                weight: FontWeight.w800,
                color: foreground,
              ),
            ),
          ),
          if (sealed)
            Positioned(
              right: -2,
              bottom: -2,
              child: Container(
                padding: const EdgeInsets.all(1.5),
                decoration: const BoxDecoration(
                  color: AppColors.surfaceCard,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.verified,
                  size: size * 0.30,
                  color: AppColors.success,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
