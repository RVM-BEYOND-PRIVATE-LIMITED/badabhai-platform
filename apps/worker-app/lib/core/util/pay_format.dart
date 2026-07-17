/// The ONE pay-band formatter, shared by the Feed card (compact) and the job
/// detail screen (full) so the two surfaces can never disagree about the same
/// number. Pay is REAL wire data per the ADR-0024 addendum (2026-07-16):
/// `pay_min` / `pay_max` are nullable ints (₹/month) on `GET /feed` items and
/// `GET /jobs/:jobId` — a null bound is rendered honestly as one-sided, and a
/// fully-null band returns null so the caller HIDES the row (never fabricates).
///
/// Values are grouped Indian-style ("1,25,000", not "125,000") because these
/// are ₹ wages shown to Indian workers.
library;

/// Full pay-band line for the detail screen, e.g.:
///   * both bounds  → "₹16,000–26,000/mo"
///   * equal bounds → "₹16,000/mo"
///   * min only     → "₹16,000+/mo"
///   * max only     → "Up to ₹26,000/mo"
///   * neither      → null (caller hides the row)
///
/// A negative bound is contract-invalid and treated as absent — the formatter
/// never renders a wage no employer could have offered.
String? formatPayBandFull(int? payMin, int? payMax) {
  final int? min = _validBound(payMin);
  final int? max = _validBound(payMax);
  if (min != null && max != null) {
    if (min == max) return '₹${formatIndianGrouped(min)}/mo';
    return '₹${formatIndianGrouped(min)}–${formatIndianGrouped(max)}/mo';
  }
  if (min != null) return '₹${formatIndianGrouped(min)}+/mo';
  if (max != null) return 'Up to ₹${formatIndianGrouped(max)}/mo';
  return null;
}

/// Compact pay band for the deck card, e.g.:
///   * both bounds  → "₹16k–26k"
///   * equal bounds → "₹16k"
///   * min only     → "₹16k+"
///   * max only     → "Up to ₹26k"
///   * neither      → null (caller leaves [BbJobCardData.payBand] unset)
///
/// Amounts under ₹1,000 render as plain numbers ("₹800+"); non-round thousands
/// keep one decimal ("₹16.5k").
String? formatPayBandCompact(int? payMin, int? payMax) {
  final int? min = _validBound(payMin);
  final int? max = _validBound(payMax);
  if (min != null && max != null) {
    if (min == max) return '₹${_compactAmount(min)}';
    return '₹${_compactAmount(min)}–${_compactAmount(max)}';
  }
  if (min != null) return '₹${_compactAmount(min)}+';
  if (max != null) return 'Up to ₹${_compactAmount(max)}';
  return null;
}

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

/// "16k" / "16.5k" / "800". One decimal at most, trailing ".0" trimmed.
String _compactAmount(int value) {
  if (value < 1000) return value.toString();
  String k = (value / 1000).toStringAsFixed(1);
  if (k.endsWith('.0')) k = k.substring(0, k.length - 2);
  return '${k}k';
}

/// A pay bound must be a non-negative rupee amount; anything else is treated as
/// "not stated" rather than rendered.
int? _validBound(int? bound) => (bound == null || bound < 0) ? null : bound;
