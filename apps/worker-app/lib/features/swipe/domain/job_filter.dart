/// The Jobs-feed filter domain: the selection model + every matching rule.
///
/// Five dimensions — Trade, City, Experience, Shift and a pay floor. Each maps to
/// a real, PII-free field the `/feed` contract actually returns, so nothing here
/// filters on invented data:
///   * TRADE      → [FeedItem.tradeKey] / [FeedItem.title] (one of the alpha
///                  trades), keyword substring match.
///   * CITY       → [FeedItem.city] (`jobs.city` is NOT NULL), exact match.
///   * EXPERIENCE → [FeedItem.minExperienceYears] / [FeedItem.maxExperienceYears]
///                  (year counts, PII-free like pay bands), band-overlap match.
///   * SHIFT      → [FeedItem.shift] ('day' | 'night' | 'rotational'), single
///                  value, exact match.
///   * PAY FLOOR  → [FeedItem.payMax] vs a ₹/month floor, "pays at least" match.
///
/// The multi-select dimensions (Trade, City, Experience) combine AND across,
/// OR within; Shift + pay floor are SINGLE-value. An EMPTY set / null on a
/// dimension means "no filter on that dimension" (identity), so the default
/// [FilterSelection.initial] shows the whole feed.
///
/// ── Why AREA is deliberately NOT a filter dimension ──────────────────────────
/// `jobs.area` is NULL for the entire reach pool, so an area filter would match
/// nothing and silently drop every job the moment a worker touched it. `city` is
/// NOT NULL and is therefore THE location filter. (DISTANCE stays out for the
/// same honesty reason — it is not modelled. Shift + pay used to be out too, but
/// the ADR-0024 addendum (2026-07-16) put both on the `/feed` wire, so they are
/// now honest filters.)
///
/// Trade/City/Experience/Shift/pay all match CLIENT-SIDE over the already-loaded
/// queue (so the deck + the sheet's "Show N jobs" count narrow instantly); Shift
/// and the pay floor ALSO ride `GET /feed` as `shift` / `pay_min` for server-side
/// narrowing on the next load (see `ApiClient.getFeed`).
///
/// Kept pure and dependency-free (api_models + equatable only) so the bloc and
/// its tests share one source of truth and the bloc never imports presentation.
library;

import 'package:equatable/equatable.dart';

import '../../../core/api/api_models.dart';

/// Maps a Filters-sheet trade label to the keyword(s) that identify a matching
/// [FeedItem] (substring, case-insensitive, against `tradeKey`/`title`). Labels
/// whose tokens already prefix the trade key (CNC/VMC/Welder/Fitter) match
/// directly; `QC` is spelled out because `quality_inspector` shares no substring.
const Map<String, List<String>> kTradeFilterKeywords = <String, List<String>>{
  'CNC': <String>['cnc'],
  'VMC': <String>['vmc'],
  'Welder': <String>['weld'],
  'Fitter': <String>['fitter'],
  'QC': <String>['quality', 'inspector', 'qc'],
};

/// The experience bands offered in the Filters sheet, in DISPLAY ORDER. These
/// labels are the wire format of [FilterSelection.experienceBands] — the sheet
/// renders them verbatim and hands the same strings back.
const List<String> kExperienceBandLabels = <String>[
  '0-2 yrs',
  '2-5 yrs',
  '5+ yrs',
];

/// Shift options offered in the Filters sheet, DISPLAY label → the RAW wire value
/// ('day' | 'night' | 'rotational') that [FeedItem.shift] carries and `GET /feed`
/// accepts as its `shift` param. SINGLE-select — a job has exactly one shift, so
/// the sheet stores the chosen wire value (not a set) in [FilterSelection.shift].
const Map<String, String> kShiftFilterLabels = <String, String>{
  'Day': 'day',
  'Night': 'night',
  'Rotational': 'rotational',
};

/// Pay-floor options offered in the Filters sheet, DISPLAY label → ₹/month floor.
/// SINGLE-select: the chosen floor is matched client-side (see [jobMatchesPayFloor])
/// AND sent to `GET /feed` as `pay_min`. Round monthly wages spanning the alpha
/// manufacturing roles; keeping them as preset chips (not a slider/keyboard) suits
/// the low-literacy, large-tap-target design.
const Map<String, int> kPayFloorOptions = <String, int>{
  '₹15,000+': 15000,
  '₹20,000+': 20000,
  '₹25,000+': 25000,
  '₹30,000+': 30000,
};

/// A band's closed/open year window. A null [max] means open-ended (infinity).
class _Band {
  const _Band(this.min, this.max);

  final int min;
  final int? max;
}

/// The year window each label selects. `5+ yrs` is open-ended (null max).
/// Bands intentionally ABUT (2 and 5 are shared endpoints) because matching is
/// INCLUSIVE overlap, not bucketing: a job wanting exactly 2 years is honestly
/// both "0-2" and "2-5", and showing it under both beats hiding it under one.
const Map<String, _Band> _kBands = <String, _Band>{
  '0-2 yrs': _Band(0, 2),
  '2-5 yrs': _Band(2, 5),
  '5+ yrs': _Band(5, null),
};

/// The worker's active Feed filter (spec §5.7). Session-only — persistence
/// (saved filters) is a follow-up.
///
/// Lives in the DOMAIN layer, not in the sheet, so the bloc can hold it in state
/// without importing presentation. Trade/City/Experience are multi-select sets
/// (empty = that dimension not filtered); [shift] and [payMin] are SINGLE values
/// (null = not filtered).
///
/// NOTE: there is deliberately NO distance/location-radius field — the alpha feed
/// is LIBERAL (the backend returns every open job with no location filter), so a
/// distance chip would filter nothing and falsely imply location filtering;
/// [cities] is the honest location control. Shift + pay USED to be excluded here
/// too (shift was mock-only display data), but the ADR-0024 addendum put both on
/// the `/feed` wire, so they are now real filter dimensions: matched client-side
/// AND threaded into `GET /feed` (see `ApiClient.getFeed`). See the LOCATION SEAM
/// in `ApplicationsRepository.findOpenJobs` for where a real distance filter
/// re-lands later.
class FilterSelection extends Equatable {
  const FilterSelection({
    required this.trades,
    required this.cities,
    required this.experienceBands,
    this.shift,
    this.payMin,
  });

  /// Labels from [kTradeFilterKeywords]. Empty = no trade filter.
  final Set<String> trades;

  /// City names as they appear on the loaded queue (see [availableCities]).
  /// Empty = no city filter.
  final Set<String> cities;

  /// Labels from [kExperienceBandLabels]. Empty = no experience filter.
  final Set<String> experienceBands;

  /// The chosen shift as its RAW wire value ('day' | 'night' | 'rotational'),
  /// from [kShiftFilterLabels]. null = no shift filter. Single-value: a job has
  /// exactly one shift.
  final String? shift;

  /// The chosen ₹/month pay FLOOR (from [kPayFloorOptions]). null = no pay
  /// filter. A job matches when its pay could reach this floor (see
  /// [jobMatchesPayFloor]).
  final int? payMin;

  /// Default filter state = NOTHING selected on any dimension. The alpha feed is
  /// LIBERAL — every open job shows until the worker actively narrows — so the
  /// default must be "show all", not a pre-selected set. Keeping these empty
  /// stays in lock-step with the bloc's initial filter: the sheet never
  /// pre-selects a value the deck isn't actually narrowed to, so a no-op
  /// "Show jobs" apply can't silently drop jobs.
  static const FilterSelection initial = FilterSelection(
    trades: <String>{},
    cities: <String>{},
    experienceBands: <String>{},
  );

  /// True when no dimension is filtered — i.e. this selection is the identity
  /// and the deck shows the whole queue.
  bool get isEmpty =>
      trades.isEmpty &&
      cities.isEmpty &&
      experienceBands.isEmpty &&
      shift == null &&
      payMin == null;

  /// PRESERVE-only copy for the multi-select sets (and, when passed, shift/pay).
  /// The nullable [shift]/[payMin] cannot be CLEARED here (a null argument means
  /// "leave unchanged") — the sheet rebuilds them via the constructor, and
  /// [FilterSelection.initial] resets everything, so no caller needs copyWith to
  /// unset them.
  FilterSelection copyWith({
    Set<String>? trades,
    Set<String>? cities,
    Set<String>? experienceBands,
    String? shift,
    int? payMin,
  }) {
    return FilterSelection(
      trades: trades ?? this.trades,
      cities: cities ?? this.cities,
      experienceBands: experienceBands ?? this.experienceBands,
      shift: shift ?? this.shift,
      payMin: payMin ?? this.payMin,
    );
  }

  /// Value equality over every dimension (Equatable compares collections
  /// deeply), so a bloc state holding a [FilterSelection] de-duplicates emits
  /// correctly.
  @override
  List<Object?> get props =>
      <Object?>[trades, cities, experienceBands, shift, payMin];
}

/// True if [job] matches ANY of [selectedTrades] (OR within the dimension). An
/// EMPTY selection means "no trade filter" → every job matches.
bool jobMatchesTrades(FeedItem job, Set<String> selectedTrades) {
  if (selectedTrades.isEmpty) return true;
  final String haystack = '${job.tradeKey} ${job.title}'.toLowerCase();
  for (final String trade in selectedTrades) {
    final List<String> keywords =
        kTradeFilterKeywords[trade] ?? <String>[trade.toLowerCase()];
    for (final String keyword in keywords) {
      if (keyword.isNotEmpty && haystack.contains(keyword)) return true;
    }
  }
  return false;
}

/// True if [job]'s city EXACTLY equals any of [selectedCities], compared
/// case-insensitively (OR within the dimension). An EMPTY selection means "no
/// city filter" → every job matches.
///
/// Exact (not substring) on purpose: substring would make "Pune" match a
/// hypothetical "Punegaon" and quietly widen the worker's choice behind their
/// back. `jobs.city` is NOT NULL, so there is no null case to be liberal about.
///
/// Normalisation here (trim + lowercase) MUST mirror [availableCities], which
/// derives the offered chips the same way. If the two ever diverge, a job whose
/// city carries stray whitespace would be offered as a chip (trimmed) that then
/// matched nothing (untrimmed) — a dead-end option, exactly what deriving the
/// list from the queue is supposed to make impossible.
bool jobMatchesCities(FeedItem job, Set<String> selectedCities) {
  if (selectedCities.isEmpty) return true;
  final String city = _normalizeCity(job.city);
  for (final String selected in selectedCities) {
    if (_normalizeCity(selected) == city) return true;
  }
  return false;
}

/// The single normalisation rule for city comparison + de-duplication, shared by
/// [jobMatchesCities] and [availableCities] so the offered chips and the matched
/// jobs can never disagree.
String _normalizeCity(String city) => city.trim().toLowerCase();

/// True if [job]'s experience window OVERLAPS any of [selectedBands] (OR within
/// the dimension). An EMPTY selection means "no experience filter" → every job
/// matches.
///
/// The job's window is [minExperienceYears ?? 0, maxExperienceYears ?? infinity]
/// — the API passes these through honestly, nulls included (null min = "no
/// floor", null max = "open-ended"). A band [bandMin, bandMax] overlaps it when:
///
///     bandMin <= jobMax && (bandMax == null || bandMax >= jobMin)
///
/// INCLUSIVE at both ends, so abutting bands share their endpoints.
///
/// CONSEQUENCE (deliberate, not a bug): a job with NO experience data at all has
/// the window [0, infinity] and therefore matches EVERY band — it is never
/// silently dropped by an experience filter. That is consistent with this alpha
/// feed's liberal philosophy and with the API's own contract note: a blank field
/// must never cost a job its impressions. Do NOT "fix" this by defaulting a null
/// min/max to a concrete number.
bool jobMatchesExperience(FeedItem job, Set<String> selectedBands) {
  if (selectedBands.isEmpty) return true;
  final int jobMin = job.minExperienceYears ?? 0;
  final int? jobMax = job.maxExperienceYears; // null = open-ended (infinity)
  for (final String label in selectedBands) {
    final _Band? band = _kBands[label];
    if (band == null) continue; // unknown label ⇒ not a match, never a crash
    final bool startsBeforeJobEnds = jobMax == null || band.min <= jobMax;
    final bool endsAfterJobStarts = band.max == null || band.max! >= jobMin;
    if (startsBeforeJobEnds && endsAfterJobStarts) return true;
  }
  return false;
}

/// True if [job]'s shift equals [selectedShift] (single-value, case-insensitive).
/// A null selection means "no shift filter" → every job matches.
///
/// CONSEQUENCE (deliberate, mirroring experience): a job whose shift is null/blank
/// on the wire matches EVERY shift — an unstated shift never costs the job its
/// impressions. Only a job with a KNOWN, DIFFERENT shift is dropped.
bool jobMatchesShift(FeedItem job, String? selectedShift) {
  if (selectedShift == null) return true;
  final String? jobShift = job.shift;
  if (jobShift == null || jobShift.isEmpty) return true; // unstated ⇒ never dropped
  return jobShift.toLowerCase() == selectedShift.toLowerCase();
}

/// True if [job] could pay AT LEAST [payMin] (₹/month floor). A null floor means
/// "no pay filter" → every job matches.
///
/// The test is against the band's CEILING ([FeedItem.payMax]): a job is dropped
/// only when its top pay is KNOWN and strictly below the floor. A null payMax
/// (open-ended / unstated ceiling) keeps the job — same liberal rule as the
/// experience bands: a blank field must never cost a job its impressions. Do NOT
/// "fix" this by defaulting a null bound to a concrete number.
bool jobMatchesPayFloor(FeedItem job, int? payMin) {
  if (payMin == null) return true;
  final int? top = job.payMax;
  if (top == null) return true; // open-ended / unstated ceiling ⇒ never dropped
  return top >= payMin;
}

/// True if [job] satisfies EVERY filtered dimension (AND across dimensions).
/// Dimensions left empty/null are identity, so [FilterSelection.initial] matches
/// all.
bool jobMatchesFilters(FeedItem job, FilterSelection filters) =>
    jobMatchesTrades(job, filters.trades) &&
    jobMatchesCities(job, filters.cities) &&
    jobMatchesExperience(job, filters.experienceBands) &&
    jobMatchesShift(job, filters.shift) &&
    jobMatchesPayFloor(job, filters.payMin);

/// [jobs] narrowed to those matching [filters], original order preserved. An
/// empty selection returns the list UNCHANGED (identity — the unfiltered feed),
/// same instance, so callers can cheaply compare by reference.
List<FeedItem> applyJobFilters(List<FeedItem> jobs, FilterSelection filters) {
  if (filters.isEmpty) return jobs;
  return jobs.where((FeedItem job) => jobMatchesFilters(job, filters)).toList();
}

/// The city options to offer: the distinct non-empty [FeedItem.city] values
/// DERIVED from the loaded queue, unioned with anything already [selected],
/// sorted for stable display.
///
/// Derived and never hardcoded — a fixed city list would invent options the feed
/// cannot honour (an option matching zero loaded jobs is a dead end that reads
/// as a broken filter). De-duplication is case-INSENSITIVE, mirroring
/// [jobMatchesCities]: two spellings differing only in case select an identical
/// set of jobs, so offering both would be two chips doing one job. The
/// first-seen spelling wins (the queue's own casing is shown, never re-cased).
///
/// [selected] is unioned in so an ACTIVE city always keeps a chip to turn it off
/// with. Without it, a city whose jobs all drain from the queue (applied/skipped,
/// or narrowed away by another dimension) would vanish from the sheet while still
/// filtering the deck — the worker would see "no jobs match", open the sheet, and
/// find no Pune chip to deselect. A filter you cannot see is a filter you cannot
/// clear, which is the same class of lie this whole surface exists to remove.
List<String> availableCities(
  List<FeedItem> jobs, {
  Set<String> selected = const <String>{},
}) {
  final Map<String, String> bySlug = <String, String>{};
  for (final FeedItem job in jobs) {
    final String city = job.city.trim();
    if (city.isEmpty) continue;
    // Key by the SAME normalisation jobMatchesCities compares on, so every chip
    // offered here is guaranteed to match at least the job it came from.
    bySlug.putIfAbsent(_normalizeCity(city), () => city);
  }
  for (final String city in selected) {
    final String trimmed = city.trim();
    if (trimmed.isEmpty) continue;
    bySlug.putIfAbsent(_normalizeCity(trimmed), () => trimmed);
  }
  final List<String> cities = bySlug.values.toList();
  cities.sort(
    (String a, String b) => _normalizeCity(a).compareTo(_normalizeCity(b)),
  );
  return cities;
}
