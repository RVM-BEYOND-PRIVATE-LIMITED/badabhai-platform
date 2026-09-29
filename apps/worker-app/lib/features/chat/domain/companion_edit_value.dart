import '../../../core/util/taxonomy_labels.dart';

/// One `before`/`after` value on the companion's edit card, made readable
/// (ADR-0046 §5.1).
///
/// WHY THIS EXISTS. The server fills those two fields straight from the edit
/// catalogue's stored values, and for nine of the catalogue's fields that value
/// is a CLOSED-SET TOKEN, not prose: `occupations:role_id` is a taxonomy id
/// (`role_cnc_operator`), `preferences:shift` / `job_type` /
/// `availability_status`, `languages:language` and
/// `qualifications:education_credential` / `education_council` are slugs
/// (`night`, `daily_wage`, `hindi`), and `willing_to_travel`,
/// `willing_to_relocate` and `accommodation_needed` are the strings `"true"` and
/// `"false"`. Printed verbatim, a worker confirming a change to their own
/// profile reads "role_cnc_operator → role_welder" or "false → true".
///
/// The repo rule is absolute: never show a raw id, enum or token on a
/// worker-facing screen — humanise at the DISPLAY EDGE, which is here. The wire
/// still carries the token, because the token is what the confirm route
/// validates against; only the pixels change.
///
/// DELIBERATELY CONSERVATIVE. Most catalogue fields are the worker's own free
/// text — an employer's name, what they did there, a certificate, a city, a
/// `2024-03`, a salary. Those must survive UNTOUCHED, including their own
/// capitalisation and any acronym they typed; re-casing a worker's words would
/// be a second bug wearing this one's clothes. So a value is only reshaped when
/// it is token-SHAPED (see [_looksLikeToken]); anything else is returned exactly
/// as it arrived.
///
/// PII-FREE and offline: tokens are opaque code strings, never worker data, and
/// nothing here reaches the network. The two mirrored vocabularies below follow
/// the `kSalaryPeriodLabels` / `kAvailabilityStatusLabels` precedent in
/// `api_models.dart` — a documented mirror of a tiny, stable server dictionary.
/// The day the server sends the label beside the token, this shrinks to nothing.
String companionEditValue(String raw) {
  final String value = raw.trim();
  if (value.isEmpty) return value;

  // The three boolean preferences. "Haan"/"Nahi" is the same yes/no the rest of
  // the app speaks, and `"true"` is never a worker's own word.
  final String? yesNo = _kBooleanLabels[value.toLowerCase()];
  if (yesNo != null) return yesNo;

  // A taxonomy id (`role_*`, `skill_*`, `mach_*`, …). Returns the value
  // unchanged when it is not id-shaped, so this is safe to try first.
  final String taxonomy = taxonomyLabel(value);
  if (taxonomy != value) return taxonomy;

  final String? mapped = _kClosedSetLabels[value.toLowerCase()];
  if (mapped != null) return mapped;

  // Not a vocabulary this build knows — but still a token, so it must not reach
  // the screen raw. `serving_notice` → "Serving Notice".
  if (_looksLikeToken(value)) {
    return value
        .split('_')
        .where((String word) => word.isNotEmpty)
        .map((String word) => '${word[0].toUpperCase()}${word.substring(1)}')
        .join(' ');
  }

  // The worker's own words. Untouched.
  return value;
}

/// The three `"true"`/`"false"` preference scalars.
const Map<String, String> _kBooleanLabels = <String, String>{
  'true': 'Haan',
  'false': 'Nahi',
};

/// The closed sets whose slugs the edit card can carry, mirrored from
/// `apps/api/src/profiles/worker-preferences.vocabulary.ts` (`SHIFTS`,
/// `JOB_TYPES`). Small, stable, and worth naming properly rather than letting
/// the generic prettifier render "Daily Wage" for `daily_wage`.
///
/// A slug this build has not heard of is NOT a bug: it falls through to the
/// prettifier, which is why an added shift or job type shows as readable text on
/// an old build instead of as a raw token.
const Map<String, String> _kClosedSetLabels = <String, String>{
  // SHIFTS
  'day': 'Day shift',
  'night': 'Night shift',
  'rotational': 'Rotational shifts',
  'any': 'Any shift',
  // JOB_TYPES
  'permanent': 'Permanent',
  'contract': 'Contract',
  'apprentice': 'Apprenticeship',
  'daily_wage': 'Daily wage',
};

/// Whether [value] is a closed-set token rather than something a worker typed.
///
/// A token is lower-case, carries no whitespace, and is built only of letters,
/// digits and underscores. That deliberately EXCLUDES a date (`2024-03`, the
/// hyphen), a year or a salary (digits alone are left as they are by the
/// prettifier anyway), and every free-text field, which carries spaces or the
/// worker's own capitals.
bool _looksLikeToken(String value) {
  if (value.contains(RegExp(r'\s'))) return false;
  if (value != value.toLowerCase()) return false;
  if (!RegExp(r'^[a-z0-9_]+$').hasMatch(value)) return false;
  // Digits alone are a year or an amount, not a token.
  return !RegExp(r'^[0-9]+$').hasMatch(value);
}
