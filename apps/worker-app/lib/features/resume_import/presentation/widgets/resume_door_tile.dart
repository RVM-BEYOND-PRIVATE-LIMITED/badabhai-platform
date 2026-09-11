import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_spinner.dart';

/// One of the three doors (#1499) — a big, obvious, two-line tap target.
///
/// A BUTTON WOULD HAVE BEEN TOO SMALL. Each door needs a title the worker
/// recognises AND a line explaining what happens next, because the choice is
/// between three unfamiliar things and the second line is what makes it a
/// choice rather than a guess. [BbButton] truncates to one line by design, so
/// this is a tile: hairline border, no shadow, `AppRadii.md`, ink title over a
/// muted subtitle — the JUL31 `.aw-kitrow` shape, sized up to the full width.
///
/// [emphasis] paints the haldi hero fill. EXACTLY ONE door may set it (the
/// design system allows one haldi surface per screen).
class ResumeDoorTile extends StatelessWidget {
  const ResumeDoorTile({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.emphasis = false,
    this.loading = false,
    this.tileKey,
  });

  final IconData icon;
  final String title;
  final String subtitle;

  /// Null disables the door — every door goes inert while any of them is busy.
  final VoidCallback? onTap;

  final bool emphasis;
  final bool loading;

  /// Key on the tappable surface, for widget tests.
  final Key? tileKey;

  @override
  Widget build(BuildContext context) {
    final bool enabled = onTap != null && !loading;
    final Color fill = emphasis ? AppColors.haldi : AppColors.paper;
    final Color border =
        emphasis ? AppColors.haldi : AppColors.borderDefault;
    final Color titleColor =
        emphasis ? AppColors.onHaldi : AppColors.ink900;
    final Color subtitleColor =
        emphasis ? AppColors.blue : AppColors.ink550;

    return Opacity(
      // Dimmed rather than hidden: the doors he did not take must stay legible
      // so he can see what is happening to the one he did.
      opacity: enabled || loading ? 1 : 0.5,
      child: Material(
        key: tileKey,
        color: fill,
        // Elevation is ALWAYS 0 — separation is fill + hairline, never shadow.
        elevation: 0,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: InkWell(
          onTap: enabled
              ? () {
                  HapticFeedback.lightImpact();
                  onTap!();
                }
              : null,
          borderRadius: BorderRadius.circular(AppRadii.md),
          child: Container(
            // Comfortably past the 48px worker tap floor, because a two-line
            // tile that a calloused thumb misses is worse than a button.
            constraints: const BoxConstraints(minHeight: 72),
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.s4,
              vertical: AppSpacing.s4,
            ),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadii.md),
              border: Border.all(color: border, width: 1.5),
            ),
            child: Row(
              children: <Widget>[
                SizedBox(
                  width: AppSpacing.s8,
                  height: AppSpacing.s8,
                  child: loading
                      ? const Center(child: BbSpinner(size: 20))
                      : Icon(icon, size: 26, color: titleColor),
                ),
                const SizedBox(width: AppSpacing.s4),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        title,
                        style: AppTypography.display(
                          size: AppTypography.sizeMd,
                          color: titleColor,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.s1),
                      Text(
                        subtitle,
                        style: AppTypography.body(
                          size: 14,
                          color: subtitleColor,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
