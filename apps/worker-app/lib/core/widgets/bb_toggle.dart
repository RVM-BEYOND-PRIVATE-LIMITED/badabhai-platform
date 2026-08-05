import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';

/// The BadaBhai switch — spec `.aw-toggle` (ui.css). A 52×30 pill track that
/// fades from ink (off) to green (on) while a white knob slides across; the
/// whole control is padded so its tap area clears [AppSpacing.tap].
///
/// Stateless: drive [value] from the caller and flip it in [onChanged].
class BbToggle extends StatelessWidget {
  const BbToggle({super.key, required this.value, required this.onChanged});

  final bool value;
  final ValueChanged<bool> onChanged;

  static const double _trackWidth = 52;
  static const double _trackHeight = 30;
  static const double _knobSize = 24;

  @override
  Widget build(BuildContext context) {
    // Vertical padding lifts the 30px track to the 48px sacred tap target.
    const double padV = (AppSpacing.tap - _trackHeight) / 2;

    return GestureDetector(
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
            color: value ? AppColors.success : AppColors.ink300,
            borderRadius: BorderRadius.circular(AppRadii.pill),
          ),
          child: AnimatedAlign(
            duration: AppMotion.base,
            curve: AppMotion.easeOut,
            alignment: value ? Alignment.centerRight : Alignment.centerLeft,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s1 / 2),
              child: Container(
                width: _knobSize,
                height: _knobSize,
                // Elevation 0 — the design system BANS shadows (separation is by
                // color/hairline, never a drop shadow). The white knob reads fine
                // on both the green (on) and ink (off) track without one.
                decoration: const BoxDecoration(
                  color: AppColors.surfaceCard,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
