import 'package:flutter/animation.dart';

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
}
