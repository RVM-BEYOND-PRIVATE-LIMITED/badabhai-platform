import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/app_theme.dart';
import '../../theme/onboarding_theme.dart';

/// The kit's primary yellow CTA (§1.3 `PrimaryActionButton`): full width, 52px,
/// 14 radius, safety-yellow fill with a shift-blue Anek label and an optional
/// trailing arrow. Elevation 0.
///
/// Behaviour kept from the kit exactly — `isLoading` swaps the label for a
/// spinner and disables the button — plus two things the kit's sketch could not
/// know it needed:
///
///  - the label SCALES DOWN rather than overflowing. A long Hinglish label at a
///    large system font on a 320dp handset would otherwise paint the yellow
///    overflow stripes inside the one control the worker must press.
///  - a light haptic on press, matching every other CTA in the app.
class PrimaryActionButton extends StatelessWidget {
  const PrimaryActionButton({
    super.key,
    required this.label,
    this.onPressed,
    this.showArrow = true,
    this.isLoading = false,
    this.buttonKey,
    this.leadingIcon,
  });

  final String label;

  /// Null renders the disabled state (kit `disabledBg`).
  final VoidCallback? onPressed;
  final bool showArrow;
  final bool isLoading;

  /// An optional glyph BEFORE the label (e.g. a GPS pin). The trailing arrow
  /// is [showArrow]'s job.
  final IconData? leadingIcon;

  /// Key on the underlying Material button, for tests.
  final Key? buttonKey;

  /// The shared yellow CTA paint, re-cornered to this button's own 14 radius
  /// (the docked bar's is 12). One source for the fill, the pressed shade and
  /// the disabled shade means the hero CTA cannot drift between screens.
  static ButtonStyle get _style => KitButtonStyles.primary.copyWith(
    shape: const WidgetStatePropertyAll<OutlinedBorder>(
      RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.button)),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final bool enabled = onPressed != null && !isLoading;
    final Color ink = enabled
        ? OnboardingColors.shiftBlue
        : OnboardingColors.disabledText;
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: SizedBox(
        width: double.infinity,
        height: OnboardingLayout.buttonHeight,
        child: ElevatedButton(
          key: buttonKey,
          style: _style,
          onPressed: enabled
              ? () {
                  HapticFeedback.lightImpact();
                  onPressed!();
                }
              : null,
          child: isLoading
              ? Semantics(
                  label: label,
                  child: const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: OnboardingColors.shiftBlue,
                    ),
                  ),
                )
              : FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      if (leadingIcon != null) ...<Widget>[
                        Icon(leadingIcon, size: 20, color: ink),
                        const SizedBox(width: 8),
                      ],
                      Text(
                        label,
                        style: OnboardingTypography.buttonLabel(color: ink),
                      ),
                      if (showArrow) ...<Widget>[
                        const SizedBox(width: 8),
                        Icon(Icons.arrow_forward_rounded, size: 20, color: ink),
                      ],
                    ],
                  ),
                ),
        ),
      ),
    );
  }
}
