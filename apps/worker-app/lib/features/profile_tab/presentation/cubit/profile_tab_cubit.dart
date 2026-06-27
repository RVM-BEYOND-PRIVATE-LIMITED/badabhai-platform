import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/profile_summary.dart';
import '../../domain/profile_summary_repository.dart';

enum ProfileTabStatus { loading, ready, failed }

class ProfileTabState extends Equatable {
  const ProfileTabState({this.status = ProfileTabStatus.loading, this.summary});

  final ProfileTabStatus status;
  final ProfileSummary? summary;

  @override
  List<Object?> get props => <Object?>[status, summary];
}

/// Loads the tabbed Profile summary on open.
class ProfileTabCubit extends Cubit<ProfileTabState> {
  ProfileTabCubit(this._repo) : super(const ProfileTabState());

  final ProfileSummaryRepository _repo;

  Future<void> load() async {
    emit(const ProfileTabState(status: ProfileTabStatus.loading));
    try {
      final ProfileSummary summary = await _repo.summary();
      if (isClosed) return;
      emit(ProfileTabState(status: ProfileTabStatus.ready, summary: summary));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const ProfileTabState(status: ProfileTabStatus.failed));
    }
  }
}
