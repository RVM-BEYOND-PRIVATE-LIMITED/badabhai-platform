import 'package:flutter/material.dart';

import '../theme/app_motion.dart';

/// A whole number that counts up to its REAL [value] over [AppMotion.countUp]
/// on an ease-out (#2596 — "count-ups on key numbers"). It starts from 0 when
/// it first shows and, when [value] later changes, counts from the figure on
/// screen to the new one. It never shows a number the data did not give: the
/// in-between frames run only between 0 and the real value.
///
/// Screen readers get the final value only (the frames are excluded). With
/// animations disabled it shows [value] at once.
///
/// Feed it a known number only — an unknown figure is the caller's honest '—',
/// never a count from 0.
class BbCountUp extends StatelessWidget {
  const BbCountUp({
    super.key,
    required this.value,
    this.style,
    this.format = _plain,
  });

  final int value;
  final TextStyle? style;

  /// Renders a frame's whole number (e.g. Indian digit grouping).
  final String Function(int value) format;

  static String _plain(int value) => '$value';

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: format(value),
      excludeSemantics: true,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: 0, end: value.toDouble()),
        duration: AppMotion.resolve(context, AppMotion.countUp),
        curve: AppMotion.easeOut,
        builder: (BuildContext context, double frame, Widget? _) =>
            Text(format(frame.round()), style: style),
      ),
    );
  }
}
