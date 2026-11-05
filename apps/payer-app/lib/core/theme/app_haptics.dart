import 'package:flutter/services.dart' show HapticFeedback;

/// The payer app's three haptic voices (#2591, M3). Never call
/// [HapticFeedback] directly from a widget — pick the intent here so every
/// surface feels the same:
///
///  - [tap]     — light impact on every tappable surface.
///  - [confirm] — medium impact when a consequential choice is confirmed
///    (unlock, sign out).
///  - [error]   — a double light tick when something failed.
///  - [errorOnce] — ONE light tick for a form submit refused by validation
///    (#2690): the first invalid field shakes once, and the phone buzzes once.
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

  /// One light tick — the submit-with-errors voice (#2690). The platform's
  /// haptic engine still honours the OS haptics setting.
  static Future<void> errorOnce() => HapticFeedback.lightImpact();
}
