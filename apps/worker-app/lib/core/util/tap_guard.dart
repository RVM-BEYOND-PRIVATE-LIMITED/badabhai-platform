import 'package:flutter/scheduler.dart';

/// How long after an accepted tap a second one is ignored.
///
/// Long enough to swallow the double-tap a thumb makes on a button that does
/// not visibly move (a row appended below the fold, a screen that takes a
/// frame to push), short enough that a worker deliberately adding two entries
/// in a row is never blocked.
/// 400ms — comfortably past the ~250ms a double-tap lands in, and well short
/// of a deliberate second tap.
const Duration kTapGuardWindow = Duration(milliseconds: 400);

/// Swallows the SECOND of a rapid double activation (#1474).
///
/// A worker on a cheap handset taps twice when nothing appears to happen — and
/// on this app "nothing appears to happen" is common: "Aur ek entry jodein"
/// appends a card BELOW the fold, and a route push takes a frame. Both taps
/// were being honoured, so the worker got two identical education cards, or
/// the same screen stacked twice with a back button that seemed not to work.
///
/// Deliberately time-based rather than "disable while busy": these actions are
/// synchronous and there is no in-flight state to hang a flag on. Hold ONE
/// guard per action in the widget's State — a guard rebuilt inside `build()`
/// would forget every tap it ever saw.
class TapGuard {
  TapGuard({this.window = kTapGuardWindow, Duration Function()? clock})
      : _clock = clock ?? _frameTime;

  /// The FRAME timestamp, not the wall clock (#1474). `DateTime.now()` does
  /// not move when a widget test pumps fake time, so a wall-clock guard sees
  /// zero elapsed between every tap and swallows taps a test — and therefore a
  /// reviewer — believes are seconds apart. This advances with pumped time in
  /// a test and with real frames on a device, so the guard behaves the same in
  /// both.
  ///
  /// `currentSystemFrameTimeStamp`, NOT `currentFrameTimeStamp`: the latter
  /// asserts unless a frame is actually being produced, and a tap callback runs
  /// BETWEEN frames — it threw on the very first tap.
  static Duration _frameTime() =>
      SchedulerBinding.instance.currentSystemFrameTimeStamp;

  final Duration window;
  final Duration Function() _clock;

  Duration? _last;

  /// True at most once per [window]. Call it AT the tap.
  bool allow() {
    final Duration now = _clock();
    final Duration? last = _last;
    if (last != null && now - last < window) return false;
    _last = now;
    return true;
  }

  /// [action], wrapped so a rapid second tap is dropped. Null in, null out —
  /// so a disabled button stays disabled.
  VoidCallback? wrap(VoidCallback? action) {
    if (action == null) return null;
    return () {
      if (allow()) action();
    };
  }

  /// Forget the last tap — for a widget that legitimately re-arms early (a
  /// failed action the worker should be able to retry at once).
  void reset() => _last = null;
}
