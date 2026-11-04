import 'package:flutter/services.dart';

import 'pay_format.dart';

/// Whole-number input (#2595): pay and experience boxes take DIGITS ONLY.
///
/// Every non-digit is dropped — a pasted "₹18,000/-" or "Rs. 18000" lands as
/// 18000 — an edit that would pass [max] is refused (the box keeps its old
/// value, like a length cap), and leading zeros fall away. With [grouped] the
/// number is shown Indian-grouped as it is typed ("1,25,000"), keeping the
/// caret after the same digit it was after. Read the value back with
/// [parseWholeNumber].
///
/// A DECIMAL POINT is never just another dropped character: a fraction's
/// digits would join the whole part, so "₹18,000.00" would land as 18,00,000
/// and "2.5" years as 25. A fraction of zeros is the whole number itself and
/// lands as that ("₹18,000.00" → 18,000); any other fraction refuses the edit,
/// and a point typed on its own changes nothing — the box never holds a number
/// the payer did not mean.
class WholeNumberInputFormatter extends TextInputFormatter {
  const WholeNumberInputFormatter({required this.max, this.grouped = false});

  /// The largest value the box accepts (the server's own ceiling).
  final int max;

  /// Show Indian digit grouping while typing.
  final bool grouped;

  static final RegExp _nonDigit = RegExp(r'\D');

  /// A decimal point with a digit on each side, and its fraction digits
  /// (group 1). A point after a word ("Rs. 18000") is not one.
  static final RegExp _decimalPoint = RegExp(r'(?<=\d)\.(\d+)');

  static final RegExp _nonZeroDigit = RegExp('[1-9]');

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    String typed = newValue.text;
    // The caret ends what this edit typed or pasted; the digits after it were
    // already in the box (the box itself never holds a point).
    int caret = newValue.selection.isValid
        ? newValue.selection.extentOffset.clamp(0, typed.length)
        : typed.length;
    // Last match first, so each cut leaves the earlier offsets valid.
    for (final RegExpMatch point
        in _decimalPoint.allMatches(newValue.text).toList().reversed) {
      // Refused: a point typed INTO a number ("2|5" → "2.5", "18,0|00" →
      // "18,0.00") — its "fraction" is digits the payer already entered — and
      // a fraction that is not all zeros.
      if (point.end > caret || _nonZeroDigit.hasMatch(point.group(1)!)) {
        return oldValue;
      }
      typed = typed.replaceRange(point.start, point.end, '');
      caret -= point.end - point.start;
    }
    // A point with no digit after it ("2.") is dropped like any other
    // non-digit: it leaves the box as it was.
    final String digits = typed.replaceAll(_nonDigit, '');
    if (digits.isEmpty) {
      return const TextEditingValue(
        selection: TextSelection.collapsed(offset: 0),
      );
    }
    final int? value = int.tryParse(digits);
    if (value == null || value > max) return oldValue;

    final String plain = value.toString();
    final String text = grouped ? formatIndianGrouped(value) : plain;

    // Keep the caret after the same digit: count the digits before it in what
    // was typed, less any leading zeros that fell away.
    final int dropped = digits.length - plain.length;
    final int digitsBefore = (_digitCount(typed.substring(0, caret)) - dropped)
        .clamp(0, plain.length);
    return TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(
        offset: _offsetAfterDigits(text, digitsBefore),
      ),
    );
  }

  static int _digitCount(String s) => s.replaceAll(_nonDigit, '').length;

  /// The offset in [text] just after its [count]-th digit (0 → the start).
  static int _offsetAfterDigits(String text, int count) {
    if (count <= 0) return 0;
    int seen = 0;
    for (int i = 0; i < text.length; i++) {
      final int unit = text.codeUnitAt(i);
      if (unit >= 0x30 && unit <= 0x39) {
        seen++;
        if (seen == count) return i + 1;
      }
    }
    return text.length;
  }
}

/// The whole number a [WholeNumberInputFormatter] box holds ("18,000" →
/// 18000), or null when it holds none.
int? parseWholeNumber(String raw) {
  final String digits = raw.replaceAll(RegExp(r'\D'), '');
  return digits.isEmpty ? null : int.tryParse(digits);
}
