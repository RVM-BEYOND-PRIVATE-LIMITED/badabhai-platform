/// Money formatting for the payer app. Wages and prices are ₹ shown to Indian
/// users, so amounts are grouped Indian-style ("1,25,000", not "125,000") — the
/// same rule the worker app uses, kept in lockstep so the two brands never
/// disagree about the same number.
library;

/// Indian-style digit grouping: last three digits, then groups of two —
/// 16000 → "16,000", 125000 → "1,25,000". Exposed for tests.
String formatIndianGrouped(int value) {
  final String digits = value.toString();
  if (digits.length <= 3) return digits;
  final List<String> parts = <String>[digits.substring(digits.length - 3)];
  String rest = digits.substring(0, digits.length - 3);
  while (rest.length > 2) {
    parts.insert(0, rest.substring(rest.length - 2));
    rest = rest.substring(0, rest.length - 2);
  }
  parts.insert(0, rest);
  return parts.join(',');
}
