import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// One bottom-nav destination — Phosphor-style glyph + text label.
class BbNavTab {
  const BbNavTab({
    required this.id,
    required this.label,
    required this.iconInactive,
    required this.iconActive,
  });

  final String id;
  final String label;
  final IconData iconInactive;
  final IconData iconActive;
}

/// The payer-app bottom navigation — `.bb-bottomnav`. Role-aware: the tab list
/// is supplied by the caller (Company = Home·Find·Jobs·Credits·Account;
/// Agency = Home·Find·Jobs·**Earn**·Account), matching the kit's `navTabs`.
///
/// Active tab takes the vermilion brand colour with a filled glyph. Every item
/// clears the 48px tap target.
class BbBottomNav extends StatelessWidget {
  const BbBottomNav({
    super.key,
    required this.tabs,
    required this.currentId,
    required this.onSelect,
  });

  final List<BbNavTab> tabs;
  final String currentId;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        color: AppColors.surfaceCard,
        border: Border(top: BorderSide(color: AppColors.borderSubtle)),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: AppSpacing.s1 + 2,
            horizontal: AppSpacing.s1,
          ),
          child: Row(
            children: tabs
                .map(
                  (BbNavTab tab) => Expanded(
                    child: _NavItem(
                      tab: tab,
                      active: tab.id == currentId,
                      onTap: () => onSelect(tab.id),
                    ),
                  ),
                )
                .toList(growable: false),
          ),
        ),
      ),
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.tab,
    required this.active,
    required this.onTap,
  });

  final BbNavTab tab;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final Color color = active ? AppColors.brandPress : AppColors.textMuted;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadii.sm),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: AppSpacing.tap),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Icon(
              active ? tab.iconActive : tab.iconInactive,
              size: 24,
              color: color,
            ),
            const SizedBox(height: 3),
            Text(
              tab.label,
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
