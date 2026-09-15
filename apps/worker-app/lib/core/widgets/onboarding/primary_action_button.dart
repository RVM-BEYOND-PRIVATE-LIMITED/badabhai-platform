import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
  });

  final String label;

  /// Null renders the disabled state (kit `disabledBg`).
  final VoidCallback? onPressed;
  final bool showArrow;
  final bool isLoading;

  /// Key on the underlying Material button, for tests.
  final Key? buttonKey;

  static ButtonStyle get _style => ButtonStyle(
        elevation: const WidgetStatePropertyAll<double>(0),
        shape: const WidgetStatePropertyAll<OutlinedBorder>(
          RoundedRectangleBorder(
            borderRadius:
                BorderRadius.all(Radius.circular(OnboardingRadii.button)),
          ),
        ),
        padding: const WidgetStatePropertyAll<EdgeInsetsGeometry>(
          EdgeInsets.symmetric(horizontal: 16),
        ),
        backgroundColor: WidgetStateProperty.resolveWith((Set<WidgetState> s) {
          if (s.contains(WidgetState.disabled)) {
            return OnboardingColors.disabledBg;
          }
          if (s.contains(WidgetState.pressed)) {
            return OnboardingColors.safetyYellowDark;
          }
          return OnboardingColors.safetyYellow;
        }),
        foregroundColor: WidgetStateProperty.resolveWith((Set<WidgetState> s) =>
            s.contains(WidgetState.disabled)
                ? OnboardingColors.disabledText
                : OnboardingColors.shiftBlue),
        // The pressed colour IS the feedback; a translucent ripple on top of it
        // would muddy the kit's flat yellow.
        overlayColor: const WidgetStatePropertyAll<Color>(Colors.transparent),
      );

  @override
  Widget build(BuildContext context) {
    final bool enabled = onPressed != null && !isLoading;
    final Color ink =
        enabled ? OnboardingColors.shiftBlue : OnboardingColors.disabledText;
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
                      Text(label,
                          style: OnboardingTypography.buttonLabel(color: ink)),
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
