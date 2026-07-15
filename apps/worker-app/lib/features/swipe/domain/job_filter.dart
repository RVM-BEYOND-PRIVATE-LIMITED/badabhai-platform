/// The Jobs-feed filter domain: the selection model + every matching rule.
///
/// Three dimensions, and only three — Trade, City, Experience. Each maps to a
/// real, PII-free field the `/feed` contract actually returns, so nothing here
/// filters on invented data:
///   * TRADE      → [FeedItem.tradeKey] / [FeedItem.title] (one of the 15 alpha
///                  trades), keyword substring match.
///   * CITY       → [FeedItem.city] (`jobs.city` is NOT NULL), exact match.
///   * EXPERIENCE → [FeedItem.minExperienceYears] / [FeedItem.maxExperienceYears]
///                  (year counts, PII-free like pay bands), band-overlap match.
///
/// Combination: AND across dimensions, OR within a dimension. An EMPTY set for a
/// dimension means "no filter on that dimension" (identity), so the default
/// [FilterSelection.initial] shows the whole feed.
///
/// ── Why AREA is deliberately NOT a filter dimension ──────────────────────────
/// `jobs.area` is NULL for the entire reach pool, so an area filter would match
/// nothing and silently drop every job the moment a worker touched it. `city` is
/// NOT NULL and is therefore THE location filter. (Distance/shift/pay stay out
/// for the same honesty reason: distance is not modelled, and shift/pay are not
/// on the wire — shift is frozen mock-only display data per ADR-0024.)
///
/// Matching is client-side over the already-loaded queue — there is no `/feed`
/// filter param to invent.
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
/// without importing presentation. All three sets are multi-select; an empty set
/// means that dimension is not filtered.
///
/// NOTE: there is deliberately NO distance/location-radius field and NO shift
/// field. The alpha feed is LIBERAL — the backend returns every open job with no
/// location filter — so a distance chip would filter nothing and falsely imply
/// location filtering; [cities] is the honest location control. Shift is not on
/// the `/feed` wire at all (mock display data, frozen by ADR-0024), so filtering
/// on it was dead. See the LOCATION SEAM in `ApplicationsRepository.findOpenJobs`
/// for where a real distance filter re-lands later.
class FilterSelection extends Equatable {
  const FilterSelection({
    required this.trades,
    required this.cities,
    required this.experienceBands,
  });

  /// Labels from [kTradeFilterKeywords]. Empty = no trade filter.
  final Set<String> trades;

  /// City names as they appear on the loaded queue (see [availableCities]).
  /// Empty = no city filter.
  final Set<String> cities;

  /// Labels from [kExperienceBandLabels]. Empty = no experience filter.
  final Set<String> experienceBands;

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
      trades.isEmpty && cities.isEmpty && experienceBands.isEmpty;

  FilterSelection copyWith({
    Set<String>? trades,
    Set<String>? cities,
    Set<String>? experienceBands,
  }) {
    return FilterSelection(
      trades: trades ?? this.trades,
      cities: cities ?? this.cities,
      experienceBands: experienceBands ?? this.experienceBands,
    );
  }

  /// Value equality over the three sets (Equatable compares collections deeply),
  /// so a bloc state holding a [FilterSelection] de-duplicates emits correctly.
  @override
  List<Object?> get props => <Object?>[trades, cities, experienceBands];
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

/// True if [job] satisfies EVERY filtered dimension (AND across dimensions).
/// Dimensions left empty are identity, so [FilterSelection.initial] matches all.
bool jobMatchesFilters(FeedItem job, FilterSelection filters) =>
    jobMatchesTrades(job, filters.trades) &&
    jobMatchesCities(job, filters.cities) &&
    jobMatchesExperience(job, filters.experienceBands);

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
