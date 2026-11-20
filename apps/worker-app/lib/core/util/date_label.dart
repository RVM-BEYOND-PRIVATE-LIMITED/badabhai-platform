/// Month names for [absoluteDateLabel]. English month names are the norm in
/// the app's Hinglish copy (dates on certificates/forms read this way), and a
/// full name avoids ambiguous numeric formats for low-literacy readers.
const List<String> _months = <String>[
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/// "21 July 2026" — an absolute, unambiguous date for Hinglish copy (e.g. the
/// ADR-0031 deletion-grace banner: 'Account 21 July 2026 ko delete hoga').
/// Renders in the DEVICE's local timezone — the worker's own wall-clock day.
String absoluteDateLabel(DateTime when) {
  final DateTime local = when.toLocal();
  return '${local.day} ${_months[local.month - 1]} ${local.year}';
}

/// "24 Sep 2026" — the COMPACT stamp, for a corner slot where the full month
/// name does not fit.
///
/// [absoluteDateLabel] stays the default everywhere else, and its reasoning is
/// unchanged: a full month name is unambiguous for a low-literacy reader, where
/// a numeric format is not. This is the same idea one step shorter — a
/// three-letter month is still a WORD, never `24/09/26`, which is the form that
/// actually confuses (is it September or the 9th?). Used on the résumé cards,
/// where the date shares one line with the status pills.
String shortDateLabel(DateTime when) {
  final DateTime local = when.toLocal();
  final String month = _months[local.month - 1];
  return '${local.day} ${month.substring(0, 3)} ${local.year}';
}

/// A SERVER day (`yyyy-mm-dd`, already in IST) printed as a compact date, or
/// null when the value is not a real day.
///
/// NO TIMEZONE ARITHMETIC: the day is the server's own (`last_active_on`), so
/// re-zoning it could move a worker's activity to a different calendar day.
/// Dart parses the date-only form as a local midnight, and [shortDateLabel]
/// then prints that same day.
String? isoDayLabel(String? raw) {
  final String value = (raw ?? '').trim();
  if (value.isEmpty) return null;
  final DateTime? parsed = DateTime.tryParse(value);
  if (parsed == null) return null;
  return shortDateLabel(parsed);
}
