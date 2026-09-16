import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// A small square control beside a docked CTA — the spec §2.2 listen tile, and
/// any other "one glyph, one job" button on a bar.
///
/// The painted tile is [width] x [height] (50x48 by default), but the TAP area
/// is always at least [OnboardingLayout.tapTarget] in both directions, so a
/// tile drawn to the artboard still clears the worker touch floor.
///
/// [caption] is the SUNIE-style label under the glyph. It is wrapped in
/// [ExcludeSemantics] and scaled down inside the fixed tile, so TalkBack
/// announces only [semanticLabel] (a real sentence) instead of reading a
/// four-letter caption, and a large system font cannot reflow the tile.
class KitSquareIconButton extends StatelessWidget {
  const KitSquareIconButton({
    super.key,
    required this.icon,
    required this.semanticLabel,
    this.onTap,
    this.caption,
    this.iconColor = OnboardingColors.shiftBlue,
    this.width = 50,
    this.height = 48,
  });

  final IconData icon;

  /// What TalkBack announces — e.g. 'Sawaal sunein', never the caption.
  final String semanticLabel;

  /// Null renders the disabled paint and takes the control out of the tab
  /// order. NO DEAD BUTTONS: a caller with nothing to run omits the tile.
  final VoidCallback? onTap;
  final String? caption;
  final Color iconColor;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final bool enabled = onTap != null;
    final Color ink = enabled ? iconColor : OnboardingColors.disabledText;
    final BorderRadius radius = BorderRadius.circular(OnboardingRadii.docked);
    final String? captionText = caption;

    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticLabel,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minWidth: OnboardingLayout.tapTarget,
          minHeight: OnboardingLayout.tapTarget,
        ),
        // `heightFactor: 1` — size to the TILE, never to the incoming maximum.
        // A bare `Center` expands to fill a finite maxHeight, so this tile
        // inside a docked bar's Row stretched the whole bar to the full screen
        // height (which then collapsed the page body and published a
        // screen-tall `bottomBarInset`).
        child: Center(
          heightFactor: 1,
          child: Material(
            color: enabled
                ? OnboardingColors.paperWhite
                : OnboardingColors.canvasBg,
            shape: RoundedRectangleBorder(
              borderRadius: radius,
              side: BorderSide(
                color: enabled
                    ? OnboardingColors.borderDefault
                    : OnboardingColors.disabledBg,
                width: 1.2,
              ),
            ),
            child: InkWell(
              onTap: onTap,
              borderRadius: radius,
              child: SizedBox(
                width: width,
                height: height,
                child: Center(
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        Icon(icon, size: 20, color: ink),
                        if (captionText != null &&
                            captionText.isNotEmpty) ...<Widget>[
                          const SizedBox(height: 2),
                          ExcludeSemantics(
                            child: Text(
                              captionText,
                              style: OnboardingTypography.inter(
                                size: 9,
                                weight: FontWeight.w800,
                                color: ink,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
