import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';

/// Stable finder for the caret — there is at most ONE on screen, since only
/// one PIN row can hold focus at a time.
const Key kPinCaretKey = Key('bb_pin_caret');

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
///
/// THE CARET (#1463). Pass [focused] and the slot the next digit will land in
/// gets a blue ring and a blinking caret — the same "the active slot's ring is
/// the caret" idea the OTP screen already ships one step earlier in this flow,
/// plus the blink, because the set-PIN row is driven by the OS keyboard and a
/// worker there has TWO rows to tell apart. It defaults to false, so the
/// unlock screen renders byte-for-byte as before.
class BbPinView extends StatelessWidget {
  const BbPinView({
    super.key,
    required this.length,
    required this.filled,
    this.error = false,
    this.focused = false,
  });

  /// Total PIN length (number of boxes).
  final int length;

  /// How many boxes are filled (digits entered so far).
  final int filled;

  /// Tint the filled border to signal a wrong PIN.
  final bool error;

  /// Whether the field behind this row currently holds focus. Only then does a
  /// slot become ACTIVE — ringed, full-size, and carrying the caret. DEFAULT
  /// FALSE so every existing call site (the unlock screen) is untouched.
  final bool focused;

  /// Test seam, mirroring `EditableText.debugDeterministicCursor` — and there
  /// for exactly the same reason. A caret that blinks forever keeps a frame
  /// scheduled forever, so any `pumpAndSettle` that reaches a focused PIN row
  /// would pump until it times out. Widget tests set this true; the blink
  /// itself is covered by a dedicated test that pumps in discrete steps.
  static bool debugDeterministicCaret = false;

  /// The empty box sits a touch smaller so a fill reads as a pop up to full
  /// size rather than a flat colour swap.
  static const double _emptyScale = 0.92;

  /// Hairline weights. The active slot's rule is heavier so the box being
  /// typed into is legible across the room, not only up close.
  static const double _borderWidth = 2;
  static const double _activeBorderWidth = 2.5;

  /// Caret geometry. Roughly half the box height — tall enough to read as a
  /// text cursor, short enough to sit clear of the box's own rounded corners.
  static const double caretWidth = 2.5;
  static const double caretHeight = AppSpacing.s7;

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

  /// The slot the next digit lands in — where the caret belongs. Once the row
  /// is full the caret HOLDS on the last slot rather than falling off the end,
  /// so a worker who taps back into a completed row still sees where backspace
  /// will bite. -1 when the row is not focused (no active slot at all).
  int get _activeIndex {
    if (!focused) return -1;
    return filled >= length ? length - 1 : filled;
  }

  @override
  Widget build(BuildContext context) {
    final Color borderOn = error ? AppColors.danger : AppColors.blue;
    const Color borderOff = AppColors.borderStrong;
    final int active = _activeIndex;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s2),
            child: AnimatedScale(
              // Fill → overshoot then settle (the pop); empty → ease back down.
              // The ACTIVE slot also sits full-size, so the box being typed
              // into is the biggest thing in the row even while still empty.
              scale: i < filled || i == active ? 1.0 : _emptyScale,
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
                    // An empty slot is grey UNLESS it is the active one, which
                    // takes the live colour and a thicker rule — the same
                    // "active slot wears the ring" language as the OTP row.
                    color: i < filled || i == active ? borderOn : borderOff,
                    width: i == active ? _activeBorderWidth : _borderWidth,
                  ),
                ),
                child: _slotChild(index: i, active: i == active, tint: borderOn),
              ),
            ),
          ),
      ],
    );
  }

  /// A filled slot shows a STAR tinted like its border — never the digit. The
  /// active slot also carries the caret: alone while the slot is still empty,
  /// and beside the star once the row is full (the star is never dropped, or
  /// the row would under-report how many digits are actually in).
  Widget? _slotChild({
    required int index,
    required bool active,
    required Color tint,
  }) {
    final bool isFilled = index < filled;
    final Widget? star = isFilled
        ? Icon(Icons.star_rounded, color: tint, size: AppSpacing.s5)
        : null;
    if (!active) return star;
    final Widget caret = _BbPinCaret(color: tint);
    if (star == null) return caret;
    return Row(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[star, const SizedBox(width: AppSpacing.s1), caret],
    );
  }
}

/// The blinking caret inside the active slot.
///
/// Hand-rolled on purpose. The real capture field is a transparent overlay
/// spanning the whole row, so Flutter's own caret would sit at the row's
/// CENTRE — nowhere near the box being typed into (the OTP screen records the
/// same finding, and settles for a static ring). Painting it here is what puts
/// the cursor where the worker is actually looking.
///
/// It cannot leak a digit: it is a coloured bar with no text, no semantics and
/// no access to the PIN — [BbPinView] only ever receives a COUNT.
class _BbPinCaret extends StatefulWidget {
  const _BbPinCaret({required this.color});

  final Color color;

  @override
  State<_BbPinCaret> createState() => _BbPinCaretState();
}

class _BbPinCaretState extends State<_BbPinCaret>
    with SingleTickerProviderStateMixin {
  /// Flutter's own `_kCursorBlinkHalfPeriod`, so the PIN boxes blink at exactly
  /// the rate every other text field on the worker's device does.
  static const Duration _halfPeriod = Duration(milliseconds: 500);

  /// Built EAGERLY in [initState], never lazily. A `late final` initialiser
  /// that the frozen-caret path skips would instead run inside [dispose], and
  /// `createTicker` looks up an inherited [TickerMode] — illegal on an element
  /// that is already deactivated.
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: _halfPeriod);
    if (!BbPinView.debugDeterministicCaret) {
      _controller.repeat(reverse: true);
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
      // Blink off (widget tests) still PAINTS the caret at full opacity — it is
      // present and assertable, it just stops scheduling frames.
      opacity: BbPinView.debugDeterministicCaret
          ? const AlwaysStoppedAnimation<double>(1)
          : _controller.drive(Tween<double>(begin: 1, end: 0)),
      child: Container(
        key: kPinCaretKey,
        width: BbPinView.caretWidth,
        height: BbPinView.caretHeight,
        decoration: BoxDecoration(
          color: widget.color,
          // A true pill: half the bar's own width, so it reads as a caret
          // rather than a rectangle at any density.
          borderRadius: BorderRadius.circular(BbPinView.caretWidth / 2),
        ),
      ),
    );
  }
}
