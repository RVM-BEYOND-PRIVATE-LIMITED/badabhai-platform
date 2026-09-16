import 'package:flutter/material.dart';

import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/onboarding_theme.dart';

/// The BadaBhai switch: a 52x30 pill track that slides from the disabled grey
/// (off) to shift blue (on) while the knob turns safety yellow. The whole
/// control is padded so its tap area clears [OnboardingLayout.tapTarget].
///
/// ON is navy + yellow, matching the v3 selected grammar (a ticked checkbox is
/// a navy fill with a yellow mark) — green is reserved for money and success,
/// so it is off the switches.
///
/// Stateless: drive [value] from the caller and flip it in [onChanged].
class BbToggle extends StatelessWidget {
  const BbToggle({
    super.key,
    required this.value,
    required this.onChanged,
    this.semanticLabel,
  });

  final bool value;
  final ValueChanged<bool> onChanged;

  /// Accessibility label announced by TalkBack, alongside the on/off state.
  /// Pass what the toggle controls (e.g. the row's title).
  final String? semanticLabel;

  static const double _trackWidth = 52;
  static const double _trackHeight = 30;
  static const double _knobSize = 24;

  @override
  Widget build(BuildContext context) {
    // Vertical padding lifts the 30px track to the 48px sacred tap target.
    const double padV = (OnboardingLayout.tapTarget - _trackHeight) / 2;

    return Semantics(
      container: true,
      toggled: value,
      button: true,
      label: semanticLabel,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => onChanged(!value),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: padV),
          child: AnimatedContainer(
            duration: AppMotion.base,
            curve: AppMotion.easeOut,
            width: _trackWidth,
            height: _trackHeight,
            decoration: BoxDecoration(
              color: value
                  ? OnboardingColors.shiftBlue
                  : OnboardingColors.disabledBg,
              borderRadius: BorderRadius.circular(AppRadii.pill),
              border: Border.all(
                color: value
                    ? OnboardingColors.safetyYellow
                    : OnboardingColors.disabledBg,
                width: 1.5,
              ),
            ),
            child: AnimatedAlign(
              duration: AppMotion.base,
              curve: AppMotion.easeOut,
              alignment: value ? Alignment.centerRight : Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.s1 / 2,
                ),
                child: AnimatedContainer(
                  duration: AppMotion.base,
                  curve: AppMotion.easeOut,
                  width: _knobSize,
                  height: _knobSize,
                  // Elevation 0 — the design system BANS shadows (separation is
                  // by colour/hairline, never a drop shadow).
                  decoration: BoxDecoration(
                    color: value
                        ? OnboardingColors.safetyYellow
                        : OnboardingColors.paperWhite,
                    shape: BoxShape.circle,
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
