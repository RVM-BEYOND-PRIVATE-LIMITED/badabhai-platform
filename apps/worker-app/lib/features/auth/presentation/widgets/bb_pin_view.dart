import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/onboarding_theme.dart';

/// Stable finder for the caret — there is at most ONE on screen, since only
/// one PIN row can hold focus at a time.
const Key kPinCaretKey = Key('bb_pin_caret');

/// What a filled slot shows. Never the digit.
enum BbPinFilledGlyph { star, dot }

/// The look of one PIN row, so the SAME behaviour (count-only masking, the
/// fill pop, the ring and the blinking caret) can wear two designs:
///
///  - [josh] — the app-wide JUL31 look. The unlock and forgot-PIN screens use
///    it, and it is the default, so they render byte-for-byte as before.
///  - [shiftBlue] — the onboarding kit's set-PIN boxes (58×60, 14 radius, 1.2px
///    hairline, a navy dot per digit).
@immutable
class BbPinSlotStyle {
  const BbPinSlotStyle({
    required this.boxWidth,
    required this.boxHeight,
    required this.radius,
    required this.gap,
    required this.fill,
    required this.borderIdle,
    required this.borderFilled,
    required this.borderActive,
    required this.errorColor,
    required this.borderWidth,
    required this.activeBorderWidth,
    required this.filledGlyph,
    required this.caretHeight,
  });

  final double boxWidth;
  final double boxHeight;
  final double radius;

  /// Horizontal padding on EACH side of a box.
  final double gap;
  final Color fill;
  final Color borderIdle;
  final Color borderFilled;
  final Color borderActive;
  final Color errorColor;
  final double borderWidth;
  final double activeBorderWidth;
  final BbPinFilledGlyph filledGlyph;
  final double caretHeight;

  static const BbPinSlotStyle josh = BbPinSlotStyle(
    // Wider than the 4px grid's 48 so the star glyph has breathing room, short
    // of 64 to leave four boxes comfortable margin on a 360dp screen.
    boxWidth: 56,
    boxHeight: AppSpacing.s10,
    radius: AppRadii.md,
    gap: AppSpacing.s2,
    fill: AppColors.surfaceCard,
    borderIdle: AppColors.borderStrong,
    borderFilled: AppColors.blue,
    borderActive: AppColors.blue,
    errorColor: AppColors.danger,
    borderWidth: 2,
    activeBorderWidth: 2.5,
    filledGlyph: BbPinFilledGlyph.star,
    caretHeight: AppSpacing.s7,
  );

  /// The kit's `_buildPinRow`: 58×60 boxes, 6px margin each side, 14 radius,
  /// white fill, a 1.2px `borderDefault` hairline and a navy `•` per digit. The
  /// active slot takes the kit's focused-input treatment (`borderActive`,
  /// 1.8px) — the same ring the kit draws on the OTP boxes one screen earlier.
  static const BbPinSlotStyle shiftBlue = BbPinSlotStyle(
    boxWidth: 58,
    boxHeight: 60,
    radius: OnboardingRadii.pinBox,
    gap: 6,
    fill: OnboardingColors.paperWhite,
    borderIdle: OnboardingColors.borderDefault,
    borderFilled: OnboardingColors.borderDefault,
    borderActive: OnboardingColors.borderActive,
    errorColor: OnboardingColors.errorRed,
    borderWidth: 1.2,
    activeBorderWidth: 1.8,
    filledGlyph: BbPinFilledGlyph.dot,
    caretHeight: 28,
  );
}

/// The masked PIN indicator: a row of rounded-box slots.
///
/// SECURITY: it renders only the COUNT of entered digits, never the digits
/// themselves. The actual PIN value lives in the parent's local state and is
/// never passed here.
///
/// A newly-entered digit lands with a POP: the box scales from a slightly
/// smaller size up to full size with a gentle overshoot (easeOutBack), so each
/// keypress has a clear, satisfying beat — important feedback for a
/// low-literacy worker who can't see the digit. [error] tints the row crimson
/// (wrong-PIN feedback).
///
/// THE CARET (#1463). Pass [focused] and the slot the next digit will land in
/// gets a ring and a blinking caret. It defaults to false, so the unlock screen
/// renders byte-for-byte as before.
class BbPinView extends StatelessWidget {
  const BbPinView({
    super.key,
    required this.length,
    required this.filled,
    this.error = false,
    this.focused = false,
    this.style = BbPinSlotStyle.josh,
  });

  /// Total PIN length (number of boxes).
  final int length;

  /// How many boxes are filled (digits entered so far).
  final int filled;

  /// Tint the row to signal a wrong PIN.
  final bool error;

  /// Whether the field behind this row currently holds focus. Only then does a
  /// slot become ACTIVE — ringed and carrying the caret. DEFAULT FALSE so every
  /// existing call site (the unlock screen) is untouched.
  final bool focused;

  /// Which design the row wears. Behaviour is identical across styles.
  final BbPinSlotStyle style;

  /// Test seam, mirroring `EditableText.debugDeterministicCursor` — and there
  /// for exactly the same reason. A caret that blinks forever keeps a frame
  /// scheduled forever, so any `pumpAndSettle` that reaches a focused PIN row
  /// (or a focused OTP box, which reuses [BbPinCaret]) would pump until it
  /// times out. Widget tests set this true.
  static bool debugDeterministicCaret = false;

  /// The empty box sits a touch smaller so a fill reads as a pop up to full
  /// size rather than a flat colour swap.
  static const double _emptyScale = 0.92;

  /// Caret geometry for the default ([BbPinSlotStyle.josh]) row.
  static const double caretWidth = 2.5;
  static const double caretHeight = AppSpacing.s7;

  /// Time the just-filled box needs to finish its fill-pop (the [AnimatedScale]
  /// runs 260ms; this leaves a small margin). A parent that CLEARS or SWITCHES
  /// its buffer on the last digit MUST wait this long first — otherwise the
  /// same-frame rebuild drops `filled` before the 4th box ever renders full.
  static const Duration fillPopSettle = Duration(milliseconds: 300);

  /// The slot the next digit lands in — where the caret belongs. Once the row
  /// is full the caret HOLDS on the last slot. -1 when not focused.
  int get _activeIndex {
    if (!focused) return -1;
    return filled >= length ? length - 1 : filled;
  }

  @override
  Widget build(BuildContext context) {
    final BbPinSlotStyle s = style;
    final Color live = error ? s.errorColor : s.borderActive;
    final Color filledBorder = error ? s.errorColor : s.borderFilled;
    final int active = _activeIndex;
    // Four boxes plus their side padding can exceed a 320dp handset's content
    // width — an overflow, complete with yellow stripes, on the cheapest phones
    // the product targets. scaleDown is inert wherever the row already fits.
    return FittedBox(
      fit: BoxFit.scaleDown,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          for (int i = 0; i < length; i++)
            Padding(
              padding: EdgeInsets.symmetric(horizontal: s.gap),
              child: AnimatedScale(
                // The ACTIVE slot is deliberately NOT forced to full size: the
                // slot about to be typed into is the ONLY one a digit ever lands
                // in, and forcing it to 1.0 would kill the pop there.
                scale: i < filled ? 1.0 : _emptyScale,
                duration: Duration(milliseconds: i < filled ? 260 : 160),
                curve: i < filled ? Curves.easeOutBack : Curves.easeOut,
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 160),
                  curve: Curves.easeOut,
                  width: s.boxWidth,
                  height: s.boxHeight,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: s.fill,
                    borderRadius: BorderRadius.circular(s.radius),
                    border: Border.all(
                      color: i == active
                          ? live
                          : (i < filled ? filledBorder : s.borderIdle),
                      width:
                          i == active ? s.activeBorderWidth : s.borderWidth,
                    ),
                  ),
                  child:
                      _slotChild(index: i, active: i == active, tint: live),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// A filled slot shows the style's glyph — never the digit. The active slot
  /// also carries the caret: alone while empty, beside the glyph once the row
  /// is full (the glyph is never dropped, or the row would under-report).
  Widget? _slotChild({
    required int index,
    required bool active,
    required Color tint,
  }) {
    final Widget? glyph = index < filled ? _glyph(tint) : null;
    if (!active) return glyph;
    final Widget caret = BbPinCaret(color: tint, height: style.caretHeight);
    if (glyph == null) return caret;
    return Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[glyph, const SizedBox(width: AppSpacing.s1), caret],
    );
  }

  Widget _glyph(Color tint) {
    switch (style.filledGlyph) {
      case BbPinFilledGlyph.star:
        return Icon(Icons.star_rounded, color: tint, size: AppSpacing.s5);
      case BbPinFilledGlyph.dot:
        // The kit's `Text('•', fontSize: 28)`. Unscaled on purpose: it is a
        // count marker inside a fixed box, not copy to be read, and a 2x system
        // font would push it past the box edge.
        return Text(
          '•',
          textScaler: TextScaler.noScaling,
          style: TextStyle(fontSize: 28, height: 1, color: tint),
        );
    }
  }
}

/// The blinking caret inside an active slot — a PIN box here, or an OTP box on
/// the verify screen, which reuses it.
///
/// Hand-rolled on purpose. The real capture field is a transparent overlay
/// spanning the whole row, so Flutter's own caret would sit at the row's
/// CENTRE — nowhere near the box being typed into. Painting it here puts the
/// cursor where the worker is actually looking.
///
/// It cannot leak a digit: a coloured bar with no text, no semantics and no
/// access to the value.
class BbPinCaret extends StatefulWidget {
  const BbPinCaret({
    super.key,
    required this.color,
    this.height = BbPinView.caretHeight,
    this.caretKey = kPinCaretKey,
  });

  final Color color;
  final double height;

  /// Key on the painted bar. Defaults to [kPinCaretKey] so existing finders
  /// keep working; the OTP screen passes its own.
  final Key caretKey;

  @override
  State<BbPinCaret> createState() => _BbPinCaretState();
}

class _BbPinCaretState extends State<BbPinCaret>
    with SingleTickerProviderStateMixin {
  /// One full on-then-off cycle: two 500ms halves, matching Flutter's own
  /// `_kCursorBlinkHalfPeriod`, so the boxes blink at exactly the rate every
  /// other text field on the worker's device does.
  static const Duration _period = Duration(milliseconds: 1000);

  /// Built EAGERLY in [initState], never lazily. A `late final` initialiser
  /// that the frozen-caret path skips would instead run inside [dispose], and
  /// `createTicker` looks up an inherited [TickerMode] — illegal on an element
  /// that is already deactivated.
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: _period);
    if (!BbPinView.debugDeterministicCaret) {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      // A HARD toggle, not a fade: a linear opacity made a 2.5px bar spend most
      // of its life part-transparent, which reads as a smudge. [Threshold]
      // snaps it fully on then fully off, the way the Android caret behaves.
      opacity: BbPinView.debugDeterministicCaret
          ? const AlwaysStoppedAnimation<double>(1)
          : _controller.drive(
              Tween<double>(begin: 1, end: 0)
                  .chain(CurveTween(curve: const Threshold(0.5))),
            ),
      child: Container(
        key: widget.caretKey,
        width: BbPinView.caretWidth,
        height: widget.height,
        decoration: BoxDecoration(
          color: widget.color,
          borderRadius: BorderRadius.circular(BbPinView.caretWidth / 2),
        ),
      ),
    );
  }
}
