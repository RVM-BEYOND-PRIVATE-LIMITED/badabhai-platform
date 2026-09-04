import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/util/devanagari_guard.dart';

void main() {
  group('containsDevanagari / stripDevanagari', () {
    test('detects a pure Devanagari phrase', () {
      expect(containsDevanagari('मेने काम किया'), isTrue);
    });

    test('detects Devanagari mixed into otherwise-Roman text', () {
      expect(containsDevanagari('Turning machine पर kaam kiya'), isTrue);
    });

    test('does not flag plain Hinglish/Roman text', () {
      expect(containsDevanagari('Turning machine par kaam kiya'), isFalse);
    });

    test('does not flag digits, punctuation or English', () {
      expect(containsDevanagari('CNC Turning & Fanuc Programming, 2020'),
          isFalse);
    });

    test('strips only the Devanagari characters, leaving Roman text intact',
        () {
      expect(stripDevanagari('Turning machine पर kaam kiya'),
          'Turning machine  kaam kiya');
    });

    test('strips a pure Devanagari phrase down to just its ASCII spaces', () {
      // Only Devanagari CHARACTERS are removed — the spaces between the
      // three words are plain ASCII and survive untouched.
      expect(stripDevanagari('मेने काम किया'), '  ');
    });

    test('strips the danda/double-danda sentence terminators', () {
      expect(containsDevanagari('phone number 98765। 43210'), isTrue);
      expect(stripDevanagari('kaam khatam।'), 'kaam khatam');
    });
  });

  group('DevanagariBlockFormatter', () {
    TextEditingValue apply(String oldText, String newText,
        {VoidCallback? onBlocked}) {
      final DevanagariBlockFormatter formatter =
          DevanagariBlockFormatter(onBlocked: onBlocked);
      return formatter.formatEditUpdate(
        TextEditingValue(text: oldText),
        TextEditingValue(
          text: newText,
          selection: TextSelection.collapsed(offset: newText.length),
        ),
      );
    }

    test('passes Roman keystrokes through unchanged, never calling onBlocked',
        () {
      bool blocked = false;
      final TextEditingValue result =
          apply('Turning', 'Turning machine', onBlocked: () => blocked = true);
      expect(result.text, 'Turning machine');
      expect(blocked, isFalse);
    });

    test('strips a Devanagari keystroke and fires onBlocked', () {
      bool blocked = false;
      final TextEditingValue result =
          apply('', 'क', onBlocked: () => blocked = true);
      expect(result.text, '');
      expect(blocked, isTrue);
    });

    test('strips only the Devanagari portion of a mixed paste', () {
      bool blocked = false;
      final TextEditingValue result = apply('', 'Fanuc फैनक programming',
          onBlocked: () => blocked = true);
      expect(result.text, 'Fanuc  programming');
      expect(blocked, isTrue);
    });

    test('places the caret at the end of the stripped text', () {
      final TextEditingValue result = apply('', 'मेने');
      expect(result.selection, TextSelection.collapsed(offset: 0));
    });
  });
}
