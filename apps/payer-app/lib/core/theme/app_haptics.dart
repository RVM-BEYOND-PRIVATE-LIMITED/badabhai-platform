import 'package:flutter/services.dart' show HapticFeedback;

/// The payer app's three haptic voices (#2591, M3). Never call
/// [HapticFeedback] directly from a widget — pick the intent here so every
/// surface feels the same:
///
///  - [tap]     — light impact on every tappable surface.
///  - [confirm] — medium impact when a consequential choice is confirmed
///    (unlock, sign out).
///  - [error]   — a double light tick when something failed.
class AppHaptics {
  AppHaptics._();

  /// Gap between the two ticks of [error].
  static const Duration errorTickGap = Duration(milliseconds: 70);

  static Future<void> tap() => HapticFeedback.lightImpact();

  static Future<void> confirm() => HapticFeedback.mediumImpact();

  static Future<void> error() async {
    await HapticFeedback.lightImpact();
    await Future<void>.delayed(errorTickGap);
    await HapticFeedback.lightImpact();
  }
}
