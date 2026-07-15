import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/job_detail.dart';
import '../../domain/swipe_repository.dart';

class JobDetailState extends Equatable {
  const JobDetailState({
    required this.detail,
    this.applying = false,
    this.appliedNonce = 0,
    this.applyErrorNonce = 0,
  });

  /// The REAL job, handed in from the feed row the worker tapped. There is no
  /// fetch — and so no loading/failed state: the worker-facing feed is the only
  /// source of job facts, and the row already carries them.
  final JobDetail detail;
  final bool applying;

  /// Bumped on a successful apply — the screen pops back with a result once.
  final int appliedNonce;

  /// Bumped on a failed apply — the screen shows a retry snackbar once.
  final int applyErrorNonce;

  JobDetailState copyWith({
    bool? applying,
    int? appliedNonce,
    int? applyErrorNonce,
  }) {
    return JobDetailState(
      detail: detail,
      applying: applying ?? this.applying,
      appliedNonce: appliedNonce ?? this.appliedNonce,
      applyErrorNonce: applyErrorNonce ?? this.applyErrorNonce,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[detail, applying, appliedNonce, applyErrorNonce];
}

/// Drives the job-detail screen: applies through the same [SwipeRepository]
/// path as the Feed.
///
/// It deliberately LOADS nothing. The previous implementation fetched a
/// client-side mock that invented the employer name and pay band from
/// `jobId.hashCode` — see [JobDetail].
class JobDetailCubit extends Cubit<JobDetailState> {
  JobDetailCubit(this._swipe, JobDetail detail)
      : super(JobDetailState(detail: detail));

  final SwipeRepository _swipe;
  bool _applying = false;

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
