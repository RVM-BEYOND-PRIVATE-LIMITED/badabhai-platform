/// Free-text availability parsing for the "Kuch aur — khud likhein" box on
/// the "Kab se available hain?" page (`trade_form_preferences_page.dart`).
///
/// The closed `availability.status` enum (`immediate` | `within_week` |
/// `within_month` | `serving_notice`, plus `notice_period_days` 0–180) cannot
/// grow a new slug without a backend migration, so this box maps Hinglish
/// durations onto the EXISTING vocabulary instead:
///
///   1. Hinglish durations — "dedh mahina" (1.5 months → 45 din),
///      "sava do mahine" (2.25 → 68), "15 din", "2 hafte".
///   2. A bare number — "2" means 2 mahine (60 din); 13–180 means days.
///      Availability answers live on a weeks/months scale, so a small bare
///      number is months, not days ("2" is never a 2-day notice).
///   3. Rubbish — anything without a duration ("asdf", "pata nahi") parses
///      to null and the page keeps availability EMPTY (the field is optional).
///
/// Deterministic and offline: the same duration-word tables the server's
/// `profiling-lexicon` (`availability.json`) uses, extended with the
/// fractional words (`dedh`, `dhai`, `sava`, `paune`, `aadha`) that table
/// never needed because the interview always asked with context. No LLM call,
/// no network — a typed duration must resolve the same way every time.
class AvailabilityFreeText {
  const AvailabilityFreeText({
    required this.status,
    this.noticeDays,
  });

  /// The closed status slug to store.
  final String status;

  /// Days to store beside it (only for `serving_notice`), already clamped
  /// to 0–180.
  final int? noticeDays;
}

/// Parse one free-text availability answer. Null means "rubbish or empty" —
/// the caller keeps availability cleared.
AvailabilityFreeText? parseAvailabilityFreeText(String raw) {
  final String text = raw.trim().toLowerCase();
  if (text.isEmpty) return null;

  // Immediate cues first — same precedence as the server's `parseAvailability`
  // (immediate wins over a duration in the same message).
  if (_hasImmediateCue(text)) {
    return const AvailabilityFreeText(status: 'immediate');
  }

  // Tenure, not a start date: "lagbhag 8 mahine se kaam kar raha hoon" was
  // read as a 240-day notice in production once — the same guard the
  // server's `askedNoticeBlockers` carry. Fail toward empty, never a guess.
  if (RegExp(r'\blag\s*bhag\b|\blagbhag\b|\bpehle\b|\bexperience\b')
          .hasMatch(text) ||
      RegExp(r'\bkaam\s+kar').hasMatch(text)) {
    return null;
  }

  final bool mentionsNotice =
      text.contains('notice') || text.contains('resign');

  final double? months = _fractionalMonths(text);
  int? days;
  if (months != null) {
    days = (months * 30).round();
  } else {
    days = _durationDays(text) ?? _bareNumberDays(text);
  }
  if (days == null) return null;
  if (days < 0) return null;
  if (days > 180) days = 180;

  if (mentionsNotice || days > 30) {
    return AvailabilityFreeText(status: 'serving_notice', noticeDays: days);
  }
  if (days <= 7) {
    return const AvailabilityFreeText(status: 'within_week');
  }
  return const AvailabilityFreeText(status: 'within_month');
}

bool _hasImmediateCue(String text) {
  return RegExp(
    r'\b(immediate(ly)?|turant|fauran|foran|ready\s+to\s+join)\b',
  ).hasMatch(text) ||
      (text.contains('abhi') &&
          RegExp(r'\b(join|start|shuru|aa)\b').hasMatch(text));
}

/// "dedh mahina" → 1.5, "dhai mahine" → 2.5, "sava mahina" → 1.25,
/// "paune do mahine" → 1.75, "aadha mahina" → 0.5. Months only: fractions
/// of a day/week are never a real availability answer.
double? _fractionalMonths(String text) {
  if (!RegExp(r'\b(mahin|maheen|month)').hasMatch(text)) return null;
  if (RegExp(r'\b(dedh|derh|daidh)\b').hasMatch(text)) return 1.5;
  if (RegExp(r'\b(dhai|dhaai)\b').hasMatch(text)) return 2.5;
  if (RegExp(r'\b(aadha|adha|aadhe)\b').hasMatch(text)) return 0.5;
  final RegExpMatch? sava =
      RegExp(r'\b(sava|sawa|savva)\b\s*([a-z0-9]+)?').firstMatch(text);
  if (sava != null) {
    // "sava mahina" captures the unit as group 2 — not a number, so the
    // lookup misses and the base falls back to 1 (1.25 months). Correct
    // by construction, not by a special case.
    return (_numberValue(sava.group(2) ?? '') ?? 1.0) + 0.25;
  }
  final RegExpMatch? paune =
      RegExp(r'\b(paune|pauna|pona)\b\s*([a-z0-9]+)?').firstMatch(text);
  if (paune != null) {
    return (_numberValue(paune.group(2) ?? '') ?? 1.0) - 0.25;
  }
  return null;
}

/// "{number} {unit}" → days. Mirrors the lexicon's NUM/UNIT tables plus the
/// teen/twenty words workers actually type.
int? _durationDays(String text) {
  final RegExpMatch? m = RegExp(
    r'\b([0-9]{1,3}|dedh|dhai|aadha|adha|ek|do|teen|tin|char|chaar|paanch|panch|chhah|chhe|saat|aath|nau|das|gyarah|barah|terah|pandrah|bees|bis|tees|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s*(din|days?|haftey?|hafta|weeks?|mahin[ae]?|maheen[ae]?|months?)\b',
  ).firstMatch(text);
  if (m == null) return null;
  final double? value = _numberValue(m.group(1) ?? '');
  if (value == null) return null;
  final String unit = (m.group(2) ?? '').toLowerCase();
  if (unit.startsWith('din') || unit.startsWith('day')) {
    return value.round();
  }
  if (unit.startsWith('haft') || unit.startsWith('week')) {
    return (value * 7).round();
  }
  return (value * 30).round();
}

/// A bare number with no unit: 1–12 means months ("2" → 60 din), 0/13–180
/// means days. Small bare numbers are months because availability answers
/// live on a weeks/months scale — "2" is 2 mahine, never a 2-day notice.
int? _bareNumberDays(String text) {
  if (!RegExp(r'^[0-9]{1,3}$').hasMatch(text)) {
    final String word = text.replaceAll(RegExp(r'[^a-z]'), ' ').trim();
    if (!RegExp(
      r'^(ek|do|teen|tin|char|chaar|paanch|panch|chhah|chhe|saat|aath|nau|das|one|two|three|four|five|six|seven|eight|nine|ten)$',
    ).hasMatch(word)) {
      return null;
    }
    final double? value = _numberValue(word);
    if (value == null) return null;
    return (value * 30).round();
  }
  final int n = int.parse(text);
  if (n >= 1 && n <= 12) return n * 30;
  if (n <= 180) return n;
  return null;
}

double? _numberValue(String raw) {
  const Map<String, double> words = <String, double>{
    'dedh': 1.5,
    'dhai': 2.5,
    'aadha': 0.5,
    'adha': 0.5,
    'ek': 1,
    'one': 1,
    'do': 2,
    'two': 2,
    'teen': 3,
    'tin': 3,
    'three': 3,
    'char': 4,
    'chaar': 4,
    'four': 4,
    'paanch': 5,
    'panch': 5,
    'five': 5,
    'chhah': 6,
    'chhe': 6,
    'six': 6,
    'saat': 7,
    'seven': 7,
    'aath': 8,
    'eight': 8,
    'nau': 9,
    'nine': 9,
    'das': 10,
    'ten': 10,
    'gyarah': 11,
    'eleven': 11,
    'barah': 12,
    'twelve': 12,
    'terah': 13,
    'pandrah': 15,
    'fifteen': 15,
    'bees': 20,
    'bis': 20,
    'twenty': 20,
    'tees': 30,
    'thirty': 30,
  };
  final String key = raw.toLowerCase();
  if (words.containsKey(key)) return words[key];
  return double.tryParse(key);
}
