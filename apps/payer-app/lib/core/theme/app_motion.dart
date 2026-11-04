import 'package:flutter/widgets.dart';

/// BadaBhai motion tokens — ported from `tokens/motion.css`.
///
/// Purposeful and reassuring: short fades + small slides on a confident
/// ease-out. One earned exception — **the "stamp"** ([stamp]): a small spring
/// overshoot for verify / unlock / apply / resume-ready success, like a rubber
/// stamp hitting paper. Nothing loops.
class AppMotion {
  AppMotion._();

  // easings
  static const Cubic easeOut = Cubic(0.22, 0.61, 0.36, 1);
  static const Cubic easeInOut = Cubic(0.62, 0, 0.30, 1);
  static const Cubic stamp = Cubic(0.18, 0.9, 0.32, 1.28); // spring overshoot
  static const Cubic easeIn = Cubic(0.55, 0, 1, 0.45);

  // durations
  static const Duration instant = Duration(milliseconds: 80);
  static const Duration fast = Duration(milliseconds: 140);
  static const Duration base = Duration(milliseconds: 220);
  static const Duration slow = Duration(milliseconds: 320);
  static const Duration slower = Duration(milliseconds: 480);

  // ---- #2591 (M3) motion foundation -------------------------------------
  // Subtle + purposeful: 90–300ms, opacity/transform only, ≤6px of travel on
  // in-place elements, and every duration collapses to zero under the OS
  // "remove animations" setting (see [reduced] / [resolve]).

  /// Emphasized enter curve — a fast start that settles softly (M3
  /// emphasized-decelerate). Used for page routes, overlays and the tab
  /// indicator.
  static const Cubic emphasized = Cubic(0.05, 0.7, 0.1, 1);

  /// Press feedback — scale to [pressScale] (and collapse the navy edge).
  static const Duration press = Duration(milliseconds: 90);

  /// Page routes and in-shell overlays — fade + [pageSlide] horizontal slide.
  static const Duration page = Duration(milliseconds: 300);

  /// Bottom sheets in and out.
  static const Duration sheet = Duration(milliseconds: 280);

  /// Bottom-nav tab indicator slide.
  static const Duration tab = Duration(milliseconds: 220);

  /// Delay between consecutive items of a staggered list entrance.
  static const Duration stagger = Duration(milliseconds: 30);

  /// The scale a tappable surface presses down to.
  static const double pressScale = 0.97;

  /// Horizontal slide of a page/overlay transition, as a fraction of its width.
  static const double pageSlide = 0.08;

  // ---- #2595 (M7) form feedback -----------------------------------------
  // Same laws as M3: opacity/transform only, ≤6px of travel, zero under the
  // OS "remove animations" setting (every one is read through [resolve]).

  /// An inline field error appearing: a fade + [errorTravel] slide down.
  static const Duration errorReveal = Duration(milliseconds: 160);

  /// How far an inline error slides down as it appears, in logical pixels.
  static const double errorTravel = 4;

  /// The one shake of the first invalid field on a refused submit.
  static const Duration shake = Duration(milliseconds: 200);

  /// The shake's travel either side of rest, in logical pixels.
  static const double shakeTravel = 6;

  /// A form progress bar filling to its next step.
  static const Duration progress = Duration(milliseconds: 300);

  /// The scale an OTP box pops to as its digit lands (over [press]).
  static const double popScale = 1.04;

  /// True when the OS asks for animations to be removed
  /// ([MediaQueryData.disableAnimations]). Safe without a [MediaQuery].
  static bool reduced(BuildContext context) =>
      MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  /// [duration], or [Duration.zero] when animations are disabled — the one
  /// gate every animated primitive reads its duration through.
  static Duration resolve(BuildContext context, Duration duration) =>
      reduced(context) ? Duration.zero : duration;

  /// [AnimationStyle] for `showModalBottomSheet(sheetAnimationStyle: …)` —
  /// [sheet] in and out, zero when animations are disabled.
  static AnimationStyle sheetStyle(BuildContext context) {
    final Duration d = resolve(context, sheet);
    return AnimationStyle(duration: d, reverseDuration: d);
  }
}
