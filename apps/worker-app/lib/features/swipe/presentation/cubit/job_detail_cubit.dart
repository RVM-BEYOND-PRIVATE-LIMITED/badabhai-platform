import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/job_detail.dart';
import '../../domain/jobs_repository.dart';
import '../../domain/swipe_repository.dart';

class JobDetailState extends Equatable {
  const JobDetailState({
    required this.detail,
    this.loading = false,
    this.loadFailed = false,
    this.applying = false,
    this.appliedNonce = 0,
    this.applyErrorNonce = 0,
  });

  /// The job. Seeded with the LIGHT detail handed in from the row the worker
  /// tapped (title + place — instant header render), then REPLACED wholesale
  /// by the FULL `GET /jobs/:jobId` detail once the fetch lands. It is NEVER
  /// wiped: on a failed fetch the light facts stay on screen — what we have is
  /// real, so we keep showing it.
  final JobDetail detail;

  /// True while the full detail is being fetched (initial load or retry).
  final bool loading;

  /// True when the full-detail fetch failed. The screen keeps the light
  /// content and shows a quiet retry affordance — never a dead end, never a
  /// fabricated section.
  final bool loadFailed;

  final bool applying;

  /// Bumped on a successful apply — the screen pops back with a result once.
  final int appliedNonce;

  /// Bumped on a failed apply — the screen shows a retry snackbar once.
  final int applyErrorNonce;

  JobDetailState copyWith({
    JobDetail? detail,
    bool? loading,
    bool? loadFailed,
    bool? applying,
    int? appliedNonce,
    int? applyErrorNonce,
  }) {
    return JobDetailState(
      detail: detail ?? this.detail,
      loading: loading ?? this.loading,
      loadFailed: loadFailed ?? this.loadFailed,
      applying: applying ?? this.applying,
      appliedNonce: appliedNonce ?? this.appliedNonce,
      applyErrorNonce: applyErrorNonce ?? this.applyErrorNonce,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        detail,
        loading,
        loadFailed,
        applying,
        appliedNonce,
        applyErrorNonce,
      ];
}

/// Drives the job-detail screen.
///
/// Construction renders the header INSTANTLY from the light [JobDetail] the
/// tapped row handed over, then fetches the FULL worker-visible posting from
/// `GET /jobs/:jobId` via [JobsRepository] (the ADR-0024 addendum, 2026-07-16
/// — real pay band / experience window / needed-by / shift / description /
/// requirements / benefits, and NOTHING employer-shaped). Applying goes
/// through the same [SwipeRepository] path as the Feed.
class JobDetailCubit extends Cubit<JobDetailState> {
  JobDetailCubit(this._jobs, this._swipe, JobDetail light)
      : super(JobDetailState(detail: light, loading: true)) {
    _load();
  }

  final JobsRepository _jobs;
  final SwipeRepository _swipe;
  bool _applying = false;

  /// Refetches the full detail after a failed load. No-op while a load is
  /// already in flight.
  Future<void> retry() async {
    if (state.loading) return;
    emit(state.copyWith(loading: true, loadFailed: false));
    await _load();
  }

  Future<void> _load() async {
    try {
      final JobDetail full = await _jobs.jobDetail(state.detail.jobId);
      if (isClosed) return;
      // The wire body never carries the worker's decision, so reattach the
      // opening surface's applicationAction to the fetched detail — otherwise
      // the WA-2 applied-CTA gate would be silently wiped by the swap.
      emit(state.copyWith(
        detail: full.withApplicationAction(state.detail.applicationAction),
        loading: false,
        loadFailed: false,
      ));
    } on Failure catch (_) {
      if (isClosed) return;
      // Keep the light title/place — never wipe real facts on a failed fetch.
      emit(state.copyWith(loading: false, loadFailed: true));
    }
  }

  Future<void> apply() async {
    if (_applying) return;
    _applying = true;
    emit(state.copyWith(applying: true));
    try {
      // rank is a coarse feed display position the detail row doesn't carry; 1
      // is a neutral value for the apply event.
      await _swipe.applyToJob(state.detail.jobId, rank: 1);
      if (isClosed) return;
      emit(state.copyWith(
          applying: false, appliedNonce: state.appliedNonce + 1));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(state.copyWith(
          applying: false, applyErrorNonce: state.applyErrorNonce + 1));
    } finally {
      _applying = false;
    }
  }
}
