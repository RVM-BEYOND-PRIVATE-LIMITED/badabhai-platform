import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/auth/domain/weak_pin.dart';

/// #367 — table-driven coverage for the pre-submit weak-PIN hint.
///
/// bb_pin_keypad_test.dart already spot-checks the obvious 1111/1234/4321 cases;
/// what was unpinned is the BOUNDARY behaviour — near-miss patterns that must
/// NOT be flagged (1212/1122), the strictness of the sequence rule, the
/// length < 2 floor, and the non-digit bail-out. Over-flagging is the expensive
/// failure here: this is a nudge shown to a low-literacy worker, so a false
/// "yeh PIN kamzor hai" on a perfectly good PIN teaches them to ignore it.
void main() {
  group('isWeakPin — flagged (gentle hint, never a block)', () {
    const List<String> weak = <String>[
      '1111', // all-same
      '0000',
      '9999',
      '1234', // strict ascending
      '2345',
      '0123',
      '6789',
      '4321', // strict descending
      '9876',
      '3210',
      '11', // the 2-digit floor still applies
      '12',
      '21',
      '123456', // longer runs stay weak
    ];
    for (final String pin in weak) {
      test('flags "$pin"', () => expect(isWeakPin(pin), isTrue));
    }
  });

  group('isWeakPin — not flagged', () {
    const List<String> strong = <String>[
      '1212', // repeating PAIR, not a run — must not be flagged
      '1122', // paired digits
      '2121',
      '1243', // ascending until the last step breaks it
      '1235',
      '1224', // one repeat inside is not "all same"
      '7416',
      '2580',
      '9043',
      '1357', // arithmetic step of 2 is NOT the ±1 rule
      '9630',
      '0129', // ascending for three digits, then not
    ];
    for (final String pin in strong) {
      test('passes "$pin"', () => expect(isWeakPin(pin), isFalse));
    }
  });

  group('isWeakPin — boundaries and bail-outs', () {
    // Below 2 digits there is no pattern to judge; a mid-typing 1-digit buffer
    // must never flash the hint while the worker is still entering their PIN.
    test('an empty PIN is not weak', () => expect(isWeakPin(''), isFalse));
    test('a single digit is not weak', () => expect(isWeakPin('1'), isFalse));
    test('a single 0 is not weak', () => expect(isWeakPin('0'), isFalse));

    // Non-digit input is deliberately deferred to the server (the real policy
    // authority) rather than guessed at locally.
    test('a non-digit PIN defers to the server', () {
      expect(isWeakPin('abcd'), isFalse);
      expect(isWeakPin('12a4'), isFalse);
      expect(isWeakPin('1 2'), isFalse);
      expect(isWeakPin('11a'), isFalse);
    });

    // Sign characters must not be parsed into a shorter digit list that then
    // reads as a run (the whereType filter is what prevents this).
    test('signed input is not mis-read as a sequence', () {
      expect(isWeakPin('-1'), isFalse);
      expect(isWeakPin('+12'), isFalse);
    });

    // The wrap-around 9→0 is NOT a ±1 step, so it is intentionally not flagged.
    test('a 9-to-0 wrap is not treated as a sequence', () {
      expect(isWeakPin('890'), isFalse);
      expect(isWeakPin('109'), isFalse);
    });
  });
}
