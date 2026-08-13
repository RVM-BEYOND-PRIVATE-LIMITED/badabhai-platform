import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/job_search_item.dart';
import '../../domain/job_search_repository.dart';
import 'job_search_state.dart';

/// Drives the Indeed-style job search: title/skill + location → paged results.
///
/// The client NEVER ranks — the server returns a deterministic order and this
/// cubit only accumulates pages. All business logic (matching, ranking) is the
/// backend's; the cubit owns query parsing, pagination bookkeeping and honest
/// error surfacing.
class JobSearchCubit extends Cubit<JobSearchState> {
  JobSearchCubit(this._repo) : super(const JobSearchState());

  final JobSearchRepository _repo;

  /// Page size — the server default; its own cap is 50.
  static const int _limit = 20;

  /// Monotonic search generation. Bumped by every [search] and [clear] so a
  /// reply from a SUPERSEDED query (a new search fired while a page fetch is
  /// still in flight) is dropped instead of corrupting the current results /
  /// page cursor — e.g. a stale page-2 from the old query appending onto the new
  /// query's page-1. Captured before each `await`; a mismatch after means "this
  /// result is for a query the worker has already moved on from".
  int _generation = 0;

  /// One-shot latch: a [loadMore] that failed suppresses further load-more until
  /// the next [search] (or [clear]). Without it a worker parked at the bottom of
  /// the list re-fires the SAME failing fetch on every scroll tick. Reset when a
  /// fresh search begins.
  bool _loadMoreFailed = false;

  /// Run a fresh search from page 1. [location] is split on the FIRST comma into
  /// `city` (before) and `state` (after), both trimmed; with no comma the whole
  /// string is the city and state is empty. Empty dimensions are sent as null so
  /// the repository/API omits them from the query.
  Future<void> search({required String title, required String location}) async {
    final int gen = ++_generation;
    _loadMoreFailed = false;

    final String q = title.trim();
    final String loc = location.trim();
    final (String city, String stateQ) = _parseLocation(loc);

    emit(state.copyWith(
      status: JobSearchStatus.loading,
      title: q,
      location: loc,
      items: const <JobSearchItem>[],
      page: 1,
      hasMore: false,
      clearFailure: true,
    ));

    try {
      final JobSearchPage result = await _repo.searchJobs(
        q: q.isEmpty ? null : q,
        city: city.isEmpty ? null : city,
        state: stateQ.isEmpty ? null : stateQ,
        limit: _limit,
        page: 1,
      );
      // A newer search superseded this one mid-flight — drop the stale reply.
      if (gen != _generation) return;
      emit(state.copyWith(
        status: result.items.isEmpty
            ? JobSearchStatus.empty
            : JobSearchStatus.results,
        items: result.items,
        page: result.page,
        hasMore: result.hasMore,
      ));
    } on Failure catch (failure) {
      if (gen != _generation) return;
      emit(state.copyWith(status: JobSearchStatus.error, failure: failure));
    }
  }

  /// Fetch the next page and APPEND it. No-op when a fetch is already in flight,
  /// when there are no more pages, when a previous load-more already failed (the
  /// one-shot latch), or before any successful search. A load-more failure does
  /// NOT wipe the results the worker is reading — it reverts to
  /// [JobSearchStatus.results] and latches so the failing fetch is not hammered
  /// on every scroll tick. (A fresh search still surfaces the full error view;
  /// only paging degrades softly.)
  Future<void> loadMore() async {
    if (_loadMoreFailed) return;
    if (state.isBusy) return;
    if (!state.hasMore) return;
    if (state.status != JobSearchStatus.results) return;

    final int gen = _generation;
    final int nextPage = state.page + 1;
    final String q = state.title;
    final (String city, String stateQ) = _parseLocation(state.location);

    emit(state.copyWith(status: JobSearchStatus.loadingMore));

    try {
      final JobSearchPage result = await _repo.searchJobs(
        q: q.isEmpty ? null : q,
        city: city.isEmpty ? null : city,
        state: stateQ.isEmpty ? null : stateQ,
        limit: _limit,
        page: nextPage,
      );
      // A search fired while this page was in flight — this page belongs to the
      // OLD query; drop it rather than append it onto the new results.
      if (gen != _generation) return;
      emit(state.copyWith(
        status: JobSearchStatus.results,
        items: <JobSearchItem>[...state.items, ...result.items],
        page: result.page,
        hasMore: result.hasMore,
      ));
    } on Failure {
      // The failure belongs to a superseded query — the new search owns the
      // screen now, so neither latch nor emit here.
      if (gen != _generation) return;
      // Keep the current results on screen; drop the trailing spinner and latch
      // so the same failing page is not re-fetched on every scroll tick.
      _loadMoreFailed = true;
      emit(state.copyWith(status: JobSearchStatus.results));
    }
  }

  /// Back to the idle prompt (clears the query and results). Bumps the
  /// generation so any in-flight reply is discarded, and clears the load-more
  /// latch.
  void clear() {
    ++_generation;
    _loadMoreFailed = false;
    emit(const JobSearchState());
  }

  /// Split a "City, State" location on the FIRST comma. No comma → the whole
  /// string is the city, state is "". Both parts trimmed.
  static (String city, String state) _parseLocation(String location) {
    final int comma = location.indexOf(',');
    if (comma < 0) return (location.trim(), '');
    return (
      location.substring(0, comma).trim(),
      location.substring(comma + 1).trim(),
    );
  }
}
