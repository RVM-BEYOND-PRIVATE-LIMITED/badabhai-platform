import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/profile_repository.dart';

enum ProfileStatus { extracting, ready, failed, confirmed }

class ProfileState extends Equatable {
  const ProfileState({this.status = ProfileStatus.extracting, this.failure});

  final ProfileStatus status;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  @override
  List<Object?> get props => <Object?>[status, failure];
}

/// Drives the profile-preview screen: run the async extraction on open, then
/// confirm on the worker's tap. Two sequential async actions, no streaming —
/// hence a Cubit.
class ProfileCubit extends Cubit<ProfileState> {
  ProfileCubit(this._repo) : super(const ProfileState());

  final ProfileRepository _repo;
  bool _confirming = false;

  Future<void> extract() async {
    emit(const ProfileState(status: ProfileStatus.extracting));
    try {
      await _repo.extractProfile();
      if (isClosed) return; // screen popped mid-extraction (the ~14s poll)
      emit(const ProfileState(status: ProfileStatus.ready));
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
      emit(const ProfileState(status: ProfileStatus.confirmed));
    } on Failure catch (_) {
      // No confirm-error affordance in the frozen UI — stay on the ready view.
    } finally {
      _confirming = false;
    }
  }
}
