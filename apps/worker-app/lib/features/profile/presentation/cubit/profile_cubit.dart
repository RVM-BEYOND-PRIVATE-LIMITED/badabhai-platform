import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../../profile_tab/domain/profile_summary.dart';
import '../../../profile_tab/domain/profile_summary_repository.dart';
import '../../domain/profile_repository.dart';

enum ProfileStatus { extracting, ready, failed, confirmed }

class ProfileState extends Equatable {
  const ProfileState({
    this.status = ProfileStatus.extracting,
    this.failure,
    this.summary,
    this.confirming = false,
    this.confirmFailure,
  });

  final ProfileStatus status;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  /// The REAL extracted profile (trade / city / strength) read back from
  /// GET /workers/me/profile-summary, so the confirm step shows the worker
  /// their actual data — not a placeholder. `null` when the summary read
  /// missed (extraction still succeeded); the view then degrades honestly.
  final ProfileSummary? summary;

  /// True while `POST /profile/confirm` is in flight (#360). The CTA binds this
  /// so the worker sees the tap was registered — on 2G the request can run the
  /// full 15s timeout, and an unbound button looked simply dead.
  final bool confirming;

  /// The typed cause of a FAILED confirm (#360). Distinct from [failure], which
  /// belongs to the `failed` status: a confirm error keeps the worker on the
  /// READY view (their profile is intact and retryable), so it needs its own
  /// slot. Non-null for exactly one emission — the view announces it, and the
  /// next attempt clears it.
  final Failure? confirmFailure;

  @override
  List<Object?> get props =>
      <Object?>[status, failure, summary, confirming, confirmFailure];
}

/// Drives the profile-preview screen: run the async extraction on open, then
/// confirm on the worker's tap. Two sequential async actions, no streaming —
/// hence a Cubit.
class ProfileCubit extends Cubit<ProfileState> {
  ProfileCubit(this._repo, this._summaryRepo) : super(const ProfileState());

  final ProfileRepository _repo;
  final ProfileSummaryRepository _summaryRepo;
  bool _confirming = false;

  Future<void> extract() async {
    emit(const ProfileState(status: ProfileStatus.extracting));
    try {
      await _repo.extractProfile();
      if (isClosed) return; // screen popped mid-extraction (the ~14s poll)
      // Read back the REAL extracted profile so the confirm step reflects the
      // worker's actual data. A summary-read miss is non-fatal — extraction
      // already succeeded — so the screen goes ready with a null summary and
      // the view degrades honestly (never a fabricated placeholder).
      ProfileSummary? summary;
      try {
        summary = await _summaryRepo.summary();
      } on Failure {
        summary = null;
      }
      if (isClosed) return;
      emit(ProfileState(status: ProfileStatus.ready, summary: summary));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(ProfileState(status: ProfileStatus.failed, failure: f));
    }
  }

  Future<void> confirm() async {
    if (_confirming || state.status != ProfileStatus.ready) return;
    _confirming = true;
    // #360 — announce the in-flight request. Clears any previous confirmFailure
    // so a retry does not re-trigger the old error announcement.
    emit(ProfileState(
      status: ProfileStatus.ready,
      summary: state.summary,
      confirming: true,
    ));
    try {
      await _repo.confirmProfile();
      if (isClosed) return;
      emit(ProfileState(
          status: ProfileStatus.confirmed, summary: state.summary));
    } on Failure catch (failure) {
      if (isClosed) return;
      // #360 — this used to emit NOTHING ("no confirm-error affordance in the
      // frozen UI"), so a failed confirm on a weak link was indistinguishable
      // from a dead button: 15s of nothing, then still nothing. The worker taps
      // repeatedly and abandons at the FINAL step of the Phase-1 exit flow.
      // Stay on the ready view — the profile is intact and the retry is one tap
      // — but surface the real reason.
      emit(ProfileState(
        status: ProfileStatus.ready,
        summary: state.summary,
        confirmFailure: failure,
      ));
    } finally {
      _confirming = false;
    }
  }
}
