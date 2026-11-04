/// Copy helpers for the My-jobs list (#2594): a count whose noun agrees with
/// the number ("1 job", never "1 jobs") and a date the payer reads at a glance
/// ("20 Jul 2026", never "2026-07-20"). Pure functions, so the cards and their
/// tests share one spelling. No intl dependency (the app has none).
library;

/// "1 job" · "0 jobs" · "3 jobs". [plural] defaults to [singular] + "s".
String countLabel(int count, String singular, {String? plural}) =>
    '$count ${count == 1 ? singular : plural ?? '${singular}s'}';

/// A BANDED vacancy count (one of `kVacancyBands`, ADR-0012 — never a raw
/// headcount) with its noun: "1 vacancy", "2-5 vacancies", "25+ vacancies".
String vacanciesLabel(String band) =>
    band == '1' ? '1 vacancy' : '$band vacancies';

const List<String> _kMonths = <String>[
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// An ISO-8601 timestamp as the payer's own calendar date: "20 Jul 2026".
/// Null when [iso] does not parse — the card then leaves the date out rather
/// than print a raw wire string.
String? readableDate(String iso) {
  final DateTime? at = DateTime.tryParse(iso)?.toLocal();
  if (at == null) return null;
  return '${at.day} ${_kMonths[at.month - 1]} ${at.year}';
}
