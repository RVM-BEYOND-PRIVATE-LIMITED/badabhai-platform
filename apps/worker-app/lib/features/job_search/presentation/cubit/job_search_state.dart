import 'package:equatable/equatable.dart';

import '../../../../core/error/failure.dart';
import '../../domain/job_search_item.dart';

/// - [idle]        — no search run yet (the prompt-to-search state).
/// - [loading]     — a fresh (page-1) search is in flight.
/// - [loadingMore] — appending the next page under existing results.
/// - [results]     — one or more jobs to show.
/// - [empty]       — the search succeeded but matched nothing.
/// - [error]       — the search failed; [JobSearchState.failure] carries the
///                   honest reason (never a generic "check internet").
enum JobSearchStatus { idle, loading, loadingMore, results, empty, error }

class JobSearchState extends Equatable {
  const JobSearchState({
    this.status = JobSearchStatus.idle,
    this.items = const <JobSearchItem>[],
    this.title = '',
    this.location = '',
    this.page = 1,
    this.hasMore = false,
    this.failure,
  });

  final JobSearchStatus status;

  /// The accumulated results (page 1 plus every appended page).
  final List<JobSearchItem> items;

  /// The last submitted title/skill query (trimmed) — kept so the empty state
  /// can name it honestly and [loadMore] re-issues the SAME query.
  final String title;

  /// The last submitted location text (trimmed), re-parsed into city/state on
  /// [loadMore] so paging narrows on exactly what the worker searched.
  final String location;

  /// The last page number successfully loaded (1-based).
  final int page;

  /// Whether the server says more pages exist. [loadMore] is a no-op when false.
  final bool hasMore;

  /// The typed cause when [status] is [JobSearchStatus.error] — the error view
  /// surfaces its honest reason instead of a generic line.
  final Failure? failure;

  /// True while any page fetch is in flight (blocks a concurrent load-more).
  bool get isBusy =>
      status == JobSearchStatus.loading || status == JobSearchStatus.loadingMore;

  JobSearchState copyWith({
    JobSearchStatus? status,
    List<JobSearchItem>? items,
    String? title,
    String? location,
    int? page,
    bool? hasMore,
    Failure? failure,
    bool clearFailure = false,
  }) {
    return JobSearchState(
      status: status ?? this.status,
      items: items ?? this.items,
      title: title ?? this.title,
      location: location ?? this.location,
      page: page ?? this.page,
      hasMore: hasMore ?? this.hasMore,
      failure: clearFailure ? null : (failure ?? this.failure),
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        items,
        title,
        location,
        page,
        hasMore,
        failure,
      ];
}
