import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';

/// The masked PIN indicator: a row of rounded-box slots. An empty slot has a
/// grey border; a filled slot's border turns the theme blue and the box shows
/// a STAR glyph tinted that same colour.
///
/// SECURITY: it renders only the COUNT of entered digits, never the digits
/// themselves. The actual PIN value lives in the parent's local state and is
/// never passed here.
///
/// A newly-entered digit lands with a POP: the box scales from a slightly
/// smaller size up to full size with a gentle overshoot (easeOutBack) while
/// its border cross-fades from grey to the theme blue, so each keypress has a
/// clear, satisfying beat — important feedback for a low-literacy worker who
/// can't see the digit. [error] tints the border (and star) crimson (wrong-PIN
/// feedback).
class BbPinView extends StatelessWidget {
  const BbPinView({
    super.key,
    required this.length,
    required this.filled,
    this.error = false,
  });

  /// Total PIN length (number of boxes).
  final int length;

  /// How many boxes are filled (digits entered so far).
  final int filled;

  /// Tint the filled border to signal a wrong PIN.
  final bool error;

  /// The empty box sits a touch smaller so a fill reads as a pop up to full
  /// size rather than a flat colour swap.
  static const double _emptyScale = 0.92;

  /// Box width — wider than the 4px grid's [AppSpacing.s9] (48) so the star
  /// glyph has real breathing room, but short of [AppSpacing.s10] (64) to
  /// leave 4 boxes + gaps comfortable margin on a 360dp screen (the
  /// short-screen scroll test's own width) inside the auth screens' 20px
  /// gutter.
  static const double _boxWidth = 56;

  /// Time the just-filled box needs to finish its fill-pop (the [AnimatedScale]
  /// runs 260ms; this leaves a small margin). A parent that CLEARS or SWITCHES
  /// its buffer on the last digit MUST wait this long first — otherwise the
  /// same-frame rebuild drops `filled` before the 4th box ever renders full,
  /// masking the pop the first three showed. Set, reset, and unlock all honour
  /// it so the last box pops on every PIN surface.
  static const Duration fillPopSettle = Duration(milliseconds: 300);

  @override
  Widget build(BuildContext context) {
    final Color borderOn = error ? AppColors.danger : AppColors.blue;
    const Color borderOff = AppColors.borderStrong;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s2),
            child: AnimatedScale(
              // Fill → overshoot then settle (the pop); empty → ease back down.
              scale: i < filled ? 1.0 : _emptyScale,
              duration: Duration(milliseconds: i < filled ? 260 : 160),
              curve: i < filled ? Curves.easeOutBack : Curves.easeOut,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 160),
                curve: Curves.easeOut,
                width: _boxWidth,
                height: AppSpacing.s10,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: AppColors.surfaceCard,
                  borderRadius: BorderRadius.circular(AppRadii.md),
                  border: Border.all(
                    color: i < filled ? borderOn : borderOff,
                    width: 2,
                  ),
                ),
                // A filled slot shows a STAR, tinted the same colour as its
                // border — never the digit. An empty slot stays blank.
                child: i < filled
                    ? Icon(Icons.star_rounded, color: borderOn, size: AppSpacing.s5)
                    : null,
              ),
            ),
          ),
      ],
    );
  }
}
