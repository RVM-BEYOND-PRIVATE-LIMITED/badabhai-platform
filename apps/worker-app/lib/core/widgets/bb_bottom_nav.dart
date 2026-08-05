import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The worker-app bottom navigation bar — the kit's four destinations in fixed
/// order: Jobs · Resume · Bada Bhai · Profile. The kit's `BBNav`: a white paper
/// surface, a single hairline top border (no shadow), labels ALWAYS visible,
/// and a haldi active indicator on the selected tab.
///
/// Notifications are NOT a tab here: they moved to a header bell
/// ([BbAlertsAction]), so this bar carries no unread badge.
///
/// Each tab is at least [AppSpacing.tap] tall — gloved hands, low-end screens.
class BbBottomNav extends StatelessWidget {
  const BbBottomNav({
    super.key,
    required this.currentIndex,
    required this.onTap,
  });

  /// Index of the active destination
  /// (0 Jobs · 1 Resume · 2 Bada Bhai · 3 Profile).
  final int currentIndex;

  /// Fired with the tapped destination index.
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: AppColors.surfaceCard,
        border: Border(
          top: BorderSide(color: AppColors.borderSubtle),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: AppSpacing.s1 + 2,
            horizontal: AppSpacing.s1,
          ),
          child: Row(
            children: const <Widget>[
              _NavItem(
                index: 0,
                label: 'Jobs',
                iconInactive: Icons.work_outline,
              ),
              _NavItem(
                index: 1,
                label: 'Resume',
                iconInactive: Icons.description_outlined,
              ),
              _NavItem(
                index: 2,
                label: 'Bada Bhai',
                iconInactive: Icons.chat_bubble_outline,
              ),
              _NavItem(
                index: 3,
                label: 'Profile',
                iconInactive: Icons.person_outline,
              ),
            ].map(_resolve).toList(growable: false),
          ),
        ),
      ),
    );
  }

  /// Threads parent state into each [_NavItem] so the items themselves stay
  /// `const`-friendly and the wiring lives in one place.
  Widget _resolve(Widget item) {
    final _NavItem nav = item as _NavItem;
    return Expanded(
      child: nav.bind(
        active: nav.index == currentIndex,
        onTap: () => onTap(nav.index),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.index,
    required this.label,
    required this.iconInactive,
    this.active = false,
    this.onTap,
  });

  final int index;
  final String label;
  final IconData iconInactive;
  final bool active;
  final VoidCallback? onTap;

  /// Returns a copy of this item bound to its resolved interaction state.
  _NavItem bind({
    required bool active,
    required VoidCallback onTap,
  }) {
    return _NavItem(
      index: index,
      label: label,
      iconInactive: iconInactive,
      active: active,
      onTap: onTap,
    );
  }

  @override
  Widget build(BuildContext context) {
    // Selected tab reads in deep blue (structure/navigation in the Josh system),
    // which also holds contrast on the white bar far better than haldi would.
    final Color color = active ? AppColors.blue : AppColors.textMuted;

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadii.sm),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: AppSpacing.tap),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            // Haldi active indicator — the earned brand rail on the selected tab.
            // A 3px haldi pill above the glyph; it reserves its height in EVERY
            // state (transparent when inactive) so the row never reflows on tap.
            Container(
              width: 22,
              height: 3,
              margin: const EdgeInsets.only(bottom: 5),
              decoration: BoxDecoration(
                color: active ? AppColors.haldi : Colors.transparent,
                borderRadius: BorderRadius.circular(AppRadii.pill),
              ),
            ),
            // The outline glyph stays in every state; the active tab reads in
            // deep blue — legible on white, with haldi reserved for the indicator.
            Icon(iconInactive, size: 24, color: color),
            const SizedBox(height: 3),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                size: AppTypography.size2xs,
                weight: FontWeight.w700,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
