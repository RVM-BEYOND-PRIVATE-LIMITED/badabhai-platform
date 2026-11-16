import 'package:flutter/material.dart';
import '../../../../core/theme/bb_palette.dart';
import 'package:flutter/services.dart';

import '../../../../core/theme/onboarding_theme.dart';

/// One of the two doors (#1499) — a big, obvious, two-line tap target.
///
/// A BUTTON WOULD HAVE BEEN TOO SMALL. Each door needs a title the worker
/// recognises AND a line explaining what happens next, because the choice is
/// between two unfamiliar things and the second line is what makes it a
/// choice rather than a guess. A CTA button truncates to one line by design, so
/// this is a card: the Master UI Kit's action-card shape (screen 7) — r14, a
/// 1.2px hairline, no shadow, a 38px icon tile like the selection cards, an
/// Inter 15 w700 title over an Inter 12 subtitle.
///
/// [emphasis] paints the safety-yellow hero fill with shift-blue ink. EXACTLY
/// ONE door may set it (one yellow hero surface per screen).
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

  static const double _radius = 14;
  static const double _iconTile = 38;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final bool enabled = onTap != null && !loading;
    final Color fill =
        emphasis ? p.action : p.card;
    // The yellow card's hairline matches its own fill: a grey rule around the
    // hero surface would read as a second, competing edge.
    final Color border = emphasis
        ? p.action
        : p.borderDefault;
    final Color titleColor = emphasis ? p.onAction : p.textPrimary;
    final Color subtitleColor = emphasis ? p.onAction : p.textSecondary;
    final Color iconTileFill = emphasis
        ? p.brandSurface.withValues(alpha: 0.10)
        : p.cardIconBg;
    final Color iconColor = emphasis ? p.onAction : p.textBrand;

    return Opacity(
      // Dimmed rather than hidden: the doors he did not take must stay legible
      // so he can see what is happening to the one he did.
      opacity: enabled || loading ? 1 : 0.5,
      child: Material(
        key: tileKey,
        color: fill,
        // Elevation is ALWAYS 0 — separation is fill + hairline, never shadow.
        elevation: 0,
        borderRadius: BorderRadius.circular(_radius),
        child: InkWell(
          onTap: enabled
              ? () {
                  HapticFeedback.lightImpact();
                  onTap!();
                }
              : null,
          borderRadius: BorderRadius.circular(_radius),
          child: Container(
            // Comfortably past the 48px worker tap floor, because a two-line
            // card that a calloused thumb misses is worse than a button.
            constraints: const BoxConstraints(minHeight: 72),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(_radius),
              border: Border.all(color: border, width: 1.2),
            ),
            child: Row(
              children: <Widget>[
                Container(
                  width: _iconTile,
                  height: _iconTile,
                  decoration: BoxDecoration(
                    color: iconTileFill,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  alignment: Alignment.center,
                  child: loading
                      ? SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2.5,
                            color: iconColor,
                          ),
                        )
                      : Icon(icon, size: 20, color: iconColor),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      Text(
                        title,
                        style: OnboardingTypography.inter(
                          size: 15,
                          weight: FontWeight.w700,
                          color: titleColor,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        style: OnboardingTypography.inter(
                          size: 12,
                          height: 1.35,
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
