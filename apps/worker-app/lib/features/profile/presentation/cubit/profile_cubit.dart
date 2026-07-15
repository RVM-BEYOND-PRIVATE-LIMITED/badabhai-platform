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

  @override
  List<Object?> get props => <Object?>[status, failure, summary];
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
    try {
      await _repo.confirmProfile();
      if (isClosed) return;
      emit(ProfileState(
          status: ProfileStatus.confirmed, summary: state.summary));
    } on Failure catch (_) {
      // No confirm-error affordance in the frozen UI — stay on the ready view.
    } finally {
      _confirming = false;
    }
  }
}
