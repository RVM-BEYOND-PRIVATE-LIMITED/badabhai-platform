/// Turns a raw `education_level` scalar into a worker-readable label.
///
/// `education_level` is a FREE-TEXT scalar the extractor writes — the profiling
/// prompt asks the model for a short label ('10th', '12th', 'ITI', 'Diploma',
/// 'Graduate'), but it sometimes emits a token-ish value such as `below_10`. A
/// low-literacy worker must never see a raw token on their profile, so this
/// normalises defensively at the presentation edge (the value can be anything):
///  - a KNOWN token maps to a friendly label,
///  - any other snake_case token is prettified (underscores → spaces, each word
///    capitalised) — e.g. `post_graduate` → "Post Graduate",
///  - an already-readable label is returned UNCHANGED, so acronyms and casing
///    survive ('ITI', 'B.Tech', '12th' are never re-cased).
///
/// PII-free: `education_level` carries a schooling level, never identity.
String humanizeEducationLevel(String raw) {
  final String value = raw.trim();
  if (value.isEmpty) return value;

  // Only the value we have actually seen the model emit is mapped explicitly;
  // everything else falls through to the generic prettifier below rather than to
  // an invented vocabulary.
  const Map<String, String> known = <String, String>{
    'below_10': '10th se kam',
    'below_10th': '10th se kam',
  };
  final String? mapped = known[value.toLowerCase()];
  if (mapped != null) return mapped;

  // Leave normal labels ('12th', 'ITI', 'B.Tech', 'Diploma') exactly as written;
  // only reshape token-ish snake_case values.
  if (!value.contains('_')) return value;
  return value
      .split('_')
      .where((String w) => w.isNotEmpty)
      .map((String w) => '${w[0].toUpperCase()}${w.substring(1)}')
      .join(' ');
}
