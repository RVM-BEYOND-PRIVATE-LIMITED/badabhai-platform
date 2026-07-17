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
