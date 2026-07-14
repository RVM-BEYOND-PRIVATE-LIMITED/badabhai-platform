/// Trade filtering for the swipe Feed.
///
/// The only PII-free, real field on [FeedItem] we can honestly filter on is its
/// coarse [FeedItem.tradeKey] (one of the 15 alpha trades) — mirrored by
/// [FeedItem.title]. Distance/shift are NOT on the `/feed` contract (shift is
/// mock display-only, distance is not modelled), so they are deliberately NOT
/// filtered here (see the Filters sheet + the task doc). Matching is client-side
/// over the already-loaded queue — there is no `/feed` filter param to invent.
///
/// Kept as a pure, dependency-free helper so the bloc and its tests share one
/// source of truth and the presentation layer stays declarative.
library;

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

/// True if [job] matches ANY of [selectedTrades]. An EMPTY selection means "no
/// trade filter" → every job matches, which preserves the unfiltered feed.
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

/// [jobs] narrowed to those matching [selectedTrades], original order preserved.
/// Empty selection returns the list unchanged (identity — the unfiltered feed).
List<FeedItem> applyTradeFilter(
  List<FeedItem> jobs,
  Set<String> selectedTrades,
) {
  if (selectedTrades.isEmpty) return jobs;
  return jobs
      .where((FeedItem job) => jobMatchesTrades(job, selectedTrades))
      .toList();
}
