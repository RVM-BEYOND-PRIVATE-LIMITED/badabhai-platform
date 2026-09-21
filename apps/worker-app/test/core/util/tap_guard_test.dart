import 'package:flutter_test/flutter_test.dart';
import 'package:badabhai_worker_app/core/util/tap_guard.dart';

/// #1474 — a worker on a cheap handset taps twice when nothing appears to
/// happen, and both taps were honoured: two identical education cards, or the
/// same screen stacked twice.
void main() {
  late Duration now;
  TapGuard build({Duration? window}) => TapGuard(
        window: window ?? kTapGuardWindow,
        clock: () => now,
      );

  setUp(() => now = Duration.zero);

  test('the first tap is always allowed', () {
    expect(build().allow(), isTrue);
  });

  test('a second tap inside the window is dropped', () {
    final TapGuard g = build();
    expect(g.allow(), isTrue);
    now += const Duration(milliseconds: 80); // a real double-tap
    expect(g.allow(), isFalse);
  });

  test('a deliberate second tap AFTER the window is honoured', () {
    // Adding two entries in a row must never be blocked.
    final TapGuard g = build();
    expect(g.allow(), isTrue);
    now += kTapGuardWindow + const Duration(milliseconds: 1);
    expect(g.allow(), isTrue);
  });

  test('the window runs from the ACCEPTED tap, not the rejected one', () {
    // A worker hammering the button must not extend their own lockout.
    final TapGuard g = build();
    expect(g.allow(), isTrue);
    for (int i = 0; i < 3; i++) {
      now += const Duration(milliseconds: 100); // 100, 200, 300ms — all inside
      expect(g.allow(), isFalse);
    }
    now += const Duration(milliseconds: 150); // 450ms from the ACCEPTED tap
    expect(g.allow(), isTrue);
  });

  test('wrap runs the action once and drops the repeat', () {
    final TapGuard g = build();
    int calls = 0;
    final void Function() tap = g.wrap(() => calls++)!;
    tap();
    now += const Duration(milliseconds: 50);
    tap();
    expect(calls, 1);
  });

  test('wrap keeps a disabled button disabled', () {
    expect(build().wrap(null), isNull);
  });

  test('reset re-arms immediately, for a retry after a failure', () {
    final TapGuard g = build();
    expect(g.allow(), isTrue);
    g.reset();
    expect(g.allow(), isTrue);
  });
}
