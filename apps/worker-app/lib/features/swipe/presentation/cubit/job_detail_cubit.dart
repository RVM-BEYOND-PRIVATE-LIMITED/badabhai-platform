import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/job_detail.dart';
import '../../domain/jobs_repository.dart';
import '../../domain/swipe_repository.dart';

enum JobDetailStatus { loading, ready, failed }

class JobDetailState extends Equatable {
  const JobDetailState({
    this.status = JobDetailStatus.loading,
    this.detail,
    this.applying = false,
    this.appliedNonce = 0,
    this.applyErrorNonce = 0,
  });

  final JobDetailStatus status;
  final JobDetail? detail;
  final bool applying;

  /// Bumped on a successful apply — the screen navigates to Applied once.
  final int appliedNonce;

  /// Bumped on a failed apply — the screen shows a retry snackbar once.
  final int applyErrorNonce;

  JobDetailState copyWith({
    JobDetailStatus? status,
    JobDetail? detail,
    bool? applying,
    int? appliedNonce,
    int? applyErrorNonce,
  }) {
    return JobDetailState(
      status: status ?? this.status,
      detail: detail ?? this.detail,
      applying: applying ?? this.applying,
      appliedNonce: appliedNonce ?? this.appliedNonce,
      applyErrorNonce: applyErrorNonce ?? this.applyErrorNonce,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, detail, applying, appliedNonce, applyErrorNonce];
}

/// Drives the job-detail screen: load the posting on open, then apply (through
/// the same [SwipeRepository] path as the Feed) or skip on the worker's tap.
class JobDetailCubit extends Cubit<JobDetailState> {
  JobDetailCubit(this._jobs, this._swipe) : super(const JobDetailState());

  final JobsRepository _jobs;
  final SwipeRepository _swipe;
  bool _applying = false;

  Future<void> load(String jobId) async {
    emit(const JobDetailState(status: JobDetailStatus.loading));
    try {
      final JobDetail detail = await _jobs.jobDetail(jobId);
      if (isClosed) return;
      emit(JobDetailState(status: JobDetailStatus.ready, detail: detail));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const JobDetailState(status: JobDetailStatus.failed));
    }
  }

  Future<void> apply() async {
    final JobDetail? detail = state.detail;
    if (detail == null || _applying) return;
    _applying = true;
    emit(state.copyWith(applying: true));
    try {
      // rank is a coarse feed display position the detail doesn't carry — 1 is a
      // neutral placeholder for the (mock) apply event.
      await _swipe.applyToJob(detail.jobId, rank: 1);
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
