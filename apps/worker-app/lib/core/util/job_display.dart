/// Display mappings for the coarse job enums the worker-visible surface serves
/// (ADR-0024 addendum, 2026-07-16): `shift` and `needed_by` on
/// `GET /jobs/:jobId` (and `shift` on `GET /feed` items), plus the experience
/// window already on both.
///
/// Every mapper returns NULL for an unknown/absent value so the caller HIDES
/// the row — an unrecognised enum string is never echoed to the worker and
/// never guessed at. Shared by the deck card and the detail screen so the two
/// surfaces can never disagree.
library;

/// 'day' → 'Day', 'night' → 'Night', 'rotational' → 'Rotational'; anything
/// else → null. The deck card shows this label as-is; the detail screen
/// appends " shift" (e.g. "Day shift").
String? shiftLabel(String? shift) {
  return switch (shift) {
    'day' => 'Day',
    'night' => 'Night',
    'rotational' => 'Rotational',
    _ => null,
  };
}

/// Hinglish urgency copy for `needed_by`: 'immediate' → 'Turant chahiye',
/// 'soon' → 'Jaldi chahiye', 'flexible' → 'Flexible'; anything else → null.
/// (No prior needed_by display mapping existed anywhere in the app — this is
/// the one source of truth for it.)
String? neededByLabel(String? neededBy) {
  return switch (neededBy) {
    'immediate' => 'Turant chahiye',
    'soon' => 'Jaldi chahiye',
    'flexible' => 'Flexible',
    _ => null,
  };
}

/// The job's experience window as one honest line, matching the Filters
/// sheet's "N-M yrs" band vocabulary (see kExperienceBandLabels in
/// features/swipe/domain/job_filter.dart):
///   * both bounds  → "2–5 yrs experience"
///   * equal bounds → "3 yrs experience"
///   * min only     → "5+ yrs experience"
///   * max only     → "Up to 5 yrs experience"
///   * neither      → null (caller hides the row — a job with no stated window
///     never gets one invented for it)
String? experienceLabel(int? minYears, int? maxYears) {
  final int? min = (minYears != null && minYears >= 0) ? minYears : null;
  final int? max = (maxYears != null && maxYears >= 0) ? maxYears : null;
  if (min != null && max != null) {
    if (min == max) return '$min yrs experience';
    return '$min–$max yrs experience';
  }
  if (min != null) return '$min+ yrs experience';
  if (max != null) return 'Up to $max yrs experience';
  return null;
}
