import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/onboarding_theme.dart';
import 'kit/kit_content_column.dart';

/// The worker-app bottom navigation bar — UI kit v3 §2.3. Four destinations in
/// fixed order: Jobs · Resume · Bada Bhai · Profile.
///
/// A white paper surface with ONE hairline top border (no shadow, D10), labels
/// ALWAYS visible, and a safety-yellow marker over the selected tab's glyph.
///
/// Notifications are NOT a tab here: they moved to a header bell
/// ([BbAlertsAction]), so this bar carries no unread badge.
///
/// ── GEOMETRY (spec §2.3) ────────────────────────────────────────────────────
///
/// [barHeight] 64 ABOVE the device's bottom safe-area inset, which the bar pads
/// for itself (the white surface is painted behind the gesture bar, so the
/// system area never shows canvas through it). Inside: a 28x3 r2 marker, gap 6,
/// a 22dp glyph, gap 3, an Inter 11 label.
///
/// The spec draws `Row spaceAround`; the items are [Expanded] instead, which
/// renders identically for four equal items and makes each one a full-height,
/// quarter-width hit area — well past the worker touch floor
/// ([OnboardingLayout.tapTarget]) on a 320dp screen.
///
/// ── WHY THE TEXT SCALE IS CLAMPED ───────────────────────────────────────────
///
/// Chrome honours the phone's font size up to
/// [OnboardingLayout.chromeMaxTextScale] and no further: at 1.3 the column
/// measures 3 + 6 + 22 + 3 + ~17 = ~51dp inside the fixed 64, while at 2.0 it
/// would need ~76 and overflow the bar. Body copy is never clamped — it
/// scrolls. This is what lets the height stay the spec's fixed 64 now that the
/// app respects the system font size (R1).
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

  /// The bar's height ABOVE the bottom safe-area inset (spec §2.3).
  static const double barHeight = 64;

  /// The marker over the active tab's glyph (spec §2.3: 28x3, radius 2).
  static const double markerWidth = 28;
  static const double markerHeight = 3;
  static const double markerRadius = 2;

  /// The destination glyph size (spec §2.3).
  static const double iconSize = 22;

  /// The four destinations, in [StatefulShellRoute] branch order — see
  /// `TabIndex`, which names the same indices.
  static const List<_NavDestination> _destinations = <_NavDestination>[
    _NavDestination(label: 'Jobs', icon: Icons.work_outline_rounded),
    _NavDestination(label: 'Resume', icon: Icons.description_outlined),
    _NavDestination(
      label: 'Bada Bhai',
      icon: Icons.chat_bubble_outline_rounded,
    ),
    _NavDestination(label: 'Profile', icon: Icons.person_outline_rounded),
  ];

  @override
  Widget build(BuildContext context) {
    final double safeBottom = MediaQuery.paddingOf(context).bottom;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      // The bar owns the BOTTOM edge of the screen, so this is the region the
      // engine reads for the system navigation bar: white with dark icons,
      // matching the surface the bar paints behind it. The navy tab headers
      // annotate the top edge (light status icons) separately.
      value: const SystemUiOverlayStyle(
        systemNavigationBarColor: OnboardingColors.paperWhite,
        systemNavigationBarIconBrightness: Brightness.dark,
        systemNavigationBarContrastEnforced: false,
      ),
      child: MediaQuery.withClampedTextScaling(
        maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
        child: Container(
          height: barHeight + safeBottom,
          padding: EdgeInsets.only(bottom: safeBottom),
          decoration: const BoxDecoration(
            color: OnboardingColors.paperWhite,
            border: Border(
              top: BorderSide(color: OnboardingColors.borderDefault),
            ),
          ),
          // On a tablet the four items stop spreading at
          // [OnboardingLayout.maxTabContentWidth] and centre, while the white
          // surface and its hairline stay full-bleed.
          child: KitContentColumn(
            child: Row(
              // STRETCH so each item is as tall as the bar: with the default
              // centre alignment the InkWell would size to its ~51dp column and
              // leave the bottom 13dp of the bar dead to a thumb.
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                for (int i = 0; i < _destinations.length; i++)
                  Expanded(
                    child: _NavItem(
                      destination: _destinations[i],
                      active: i == currentIndex,
                      onTap: () => onTap(i),
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

/// One destination's label + glyph. Value-only, so the bar's item list stays
/// `const` and the wiring lives in one place.
@immutable
class _NavDestination {
  const _NavDestination({required this.label, required this.icon});

  final String label;
  final IconData icon;
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.destination,
    required this.active,
    required this.onTap,
  });

  final _NavDestination destination;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // The selected tab reads in shift blue: it holds contrast on the white bar,
    // where safety yellow would not, and the yellow is spent on the marker.
    final Color color = active
        ? OnboardingColors.shiftBlue
        : OnboardingColors.ink500;

    return Semantics(
      button: true,
      selected: active,
      label: destination.label,
      // One node per tab, carrying the label and the selected state. Without
      // this the label came through as a bare text node and a screen reader had
      // no way to say WHICH tab the worker is on.
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            // The marker reserves its height in EVERY state (transparent when
            // inactive) so the row never reflows as the worker switches tabs.
            Container(
              width: BbBottomNav.markerWidth,
              height: BbBottomNav.markerHeight,
              decoration: BoxDecoration(
                color: active
                    ? OnboardingColors.safetyYellow
                    : Colors.transparent,
                borderRadius: BorderRadius.circular(BbBottomNav.markerRadius),
              ),
            ),
            const SizedBox(height: 6),
            Icon(destination.icon, size: BbBottomNav.iconSize, color: color),
            const SizedBox(height: 3),
            Text(
              destination.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: OnboardingTypography.inter(
                size: 11,
                weight: active ? FontWeight.w700 : FontWeight.w500,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
