import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The worker-app bottom navigation bar — four destinations in fixed order:
/// Jobs · Resume · Profile · Alerts. A token-driven port of the `Nav` block
/// (`screens.jsx` 29–42) / `.aw-nav` (`ui.css` 218–222); cream card surface,
/// a hairline top border, and a danger pill counting unread alerts.
///
/// Each tab is at least [AppSpacing.tap] tall — gloved hands, low-end screens.
class BbBottomNav extends StatelessWidget {
  const BbBottomNav({
    super.key,
    required this.currentIndex,
    required this.onTap,
    this.alertsUnread = 0,
  });

  /// Index of the active destination (0 Jobs · 1 Resume · 2 Profile · 3 Alerts).
  final int currentIndex;

  /// Fired with the tapped destination index.
  final ValueChanged<int> onTap;

  /// Unread-alerts count; renders a badge on the Alerts tab when > 0.
  final int alertsUnread;

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
                iconActive: Icons.work,
              ),
              _NavItem(
                index: 1,
                label: 'Resume',
                iconInactive: Icons.description_outlined,
                iconActive: Icons.description,
              ),
              _NavItem(
                index: 2,
                label: 'Profile',
                iconInactive: Icons.person_outline,
                iconActive: Icons.person,
              ),
              _NavItem(
                index: 3,
                label: 'Alerts',
                iconInactive: Icons.notifications_outlined,
                iconActive: Icons.notifications,
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
        badgeCount: nav.index == 3 ? alertsUnread : 0,
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.index,
    required this.label,
    required this.iconInactive,
    required this.iconActive,
    this.active = false,
    this.onTap,
    this.badgeCount = 0,
  });

  final int index;
  final String label;
  final IconData iconInactive;
  final IconData iconActive;
  final bool active;
  final VoidCallback? onTap;
  final int badgeCount;

  /// Returns a copy of this item bound to its resolved interaction state.
  _NavItem bind({
    required bool active,
    required VoidCallback onTap,
    required int badgeCount,
  }) {
    return _NavItem(
      index: index,
      label: label,
      iconInactive: iconInactive,
      iconActive: iconActive,
      active: active,
      onTap: onTap,
      badgeCount: badgeCount,
    );
  }

  @override
  Widget build(BuildContext context) {
    final Color color =
        active ? AppColors.brandPress : AppColors.textMuted;

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadii.sm),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: AppSpacing.tap),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            _IconWithBadge(
              icon: active ? iconActive : iconInactive,
              color: color,
              badgeCount: badgeCount,
            ),
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

class _IconWithBadge extends StatelessWidget {
  const _IconWithBadge({
    required this.icon,
    required this.color,
    required this.badgeCount,
  });

  final IconData icon;
  final Color color;
  final int badgeCount;

  @override
  Widget build(BuildContext context) {
    final Icon glyph = Icon(icon, size: 24, color: color);
    if (badgeCount <= 0) {
      return glyph;
    }
    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        glyph,
        Positioned(
          top: -4,
          right: -8,
          child: _Badge(count: badgeCount),
        ),
      ],
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 16),
      height: 16,
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s1),
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: AppColors.danger,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.pill)),
      ),
      child: Text(
        '$count',
        textAlign: TextAlign.center,
        style: AppTypography.body(
          size: AppTypography.size2xs,
          weight: FontWeight.w700,
          color: AppColors.textOnBrand,
        ),
      ),
    );
  }
}
