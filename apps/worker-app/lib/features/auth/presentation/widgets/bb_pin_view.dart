import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';

/// The masked PIN indicator: a row of dots that FILL as digits are entered.
///
/// SECURITY: it renders only the COUNT of entered digits, never the digits
/// themselves. The actual PIN value lives in the parent's local state and is
/// never passed here.
///
/// A newly-entered digit lands with a POP: the dot scales from a slightly
/// smaller hollow ring up to full size with a gentle overshoot (easeOutBack)
/// while its fill cross-fades in, so each keypress has a clear, satisfying beat
/// — important feedback for a low-literacy worker who can't see the digit.
/// [error] tints the dots crimson (wrong-PIN feedback).
class BbPinView extends StatelessWidget {
  const BbPinView({
    super.key,
    required this.length,
    required this.filled,
    this.error = false,
  });

  /// Total PIN length (number of dots).
  final int length;

  /// How many dots are filled (digits entered so far).
  final int filled;

  /// Tint the dots to signal a wrong PIN.
  final bool error;

  /// The empty (hollow) dot sits a touch smaller so a fill reads as a pop up to
  /// full size rather than a flat colour swap.
  static const double _emptyScale = 0.72;

  /// Time the just-filled dot needs to finish its fill-pop (the [AnimatedScale]
  /// runs 260ms; this leaves a small margin). A parent that CLEARS or SWITCHES
  /// its buffer on the last digit MUST wait this long first — otherwise the
  /// same-frame rebuild drops `filled` before the 4th dot ever renders full,
  /// masking the pop the first three showed. Set, reset, and unlock all honour
  /// it so the last dot pops on every PIN surface.
  static const Duration fillPopSettle = Duration(milliseconds: 300);

  @override
  Widget build(BuildContext context) {
    final Color on = error ? AppColors.danger : AppColors.brand;
    final Color off = AppColors.borderStrong;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s3),
            child: AnimatedScale(
              // Fill → overshoot then settle (the pop); empty → ease back down.
              scale: i < filled ? 1.0 : _emptyScale,
              duration: Duration(milliseconds: i < filled ? 260 : 160),
              curve: i < filled ? Curves.easeOutBack : Curves.easeOut,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                curve: Curves.easeOut,
                width: AppSpacing.s4,
                height: AppSpacing.s4,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: i < filled ? on : Colors.transparent,
                  border: Border.all(
                    color: i < filled ? on : off,
                    width: 2,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}
