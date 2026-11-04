import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_pressable.dart';

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
/// Active tab takes the deep-blue structure colour with a filled glyph, labels
/// always visible (JUL31 nav). Every item clears the 48px tap target.
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
        child: Stack(
          children: <Widget>[
            Padding(
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
            // #2591 — the active-tab indicator slides between slots
            // ([AppMotion.tab], emphasized curve) instead of hard-cutting.
            Positioned(
              top: 0,
              left: AppSpacing.s1,
              right: AppSpacing.s1,
              height: indicatorHeight,
              child: _TabIndicator(
                count: tabs.length,
                index: tabs.indexWhere((BbNavTab t) => t.id == currentId),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Height of the sliding active-tab indicator.
  static const double indicatorHeight = 3;

  /// Key of the sliding indicator bar (for widget tests).
  @visibleForTesting
  static const Key indicatorKey = Key('bb_bottom_nav_indicator');
}

/// The sliding bar over the active tab: a 1/[count]-wide slot translated by
/// [index] slots (transform only). Hidden when no tab is active.
class _TabIndicator extends StatelessWidget {
  const _TabIndicator({required this.count, required this.index});

  final int count;
  final int index;

  @override
  Widget build(BuildContext context) {
    if (count == 0 || index < 0) return const SizedBox.shrink();
    return FractionallySizedBox(
      alignment: Alignment.centerLeft,
      widthFactor: 1 / count,
      child: AnimatedSlide(
        key: BbBottomNav.indicatorKey,
        offset: Offset(index.toDouble(), 0),
        duration: AppMotion.resolve(context, AppMotion.tab),
        curve: AppMotion.emphasized,
        child: Center(
          child: Container(
            width: AppSpacing.s7,
            decoration: BoxDecoration(
              color: AppColors.blue,
              borderRadius: BorderRadius.circular(BbBottomNav.indicatorHeight),
            ),
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
    final Color color = active ? AppColors.blue : AppColors.textMuted;
    return BbPressable(
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
