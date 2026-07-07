import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
import '../../domain/applications_repository.dart';

enum ApplicationsStatus { loading, empty, consentRequired, error, ready }

class ApplicationsState extends Equatable {
  const ApplicationsState({
    this.status = ApplicationsStatus.loading,
    this.jobs = const <AppliedJob>[],
  });

  final ApplicationsStatus status;
  final List<AppliedJob> jobs;

  @override
  List<Object?> get props => <Object?>[status, jobs];
}

/// Loads the worker's applied jobs for the Applied-jobs screen.
///
/// Display is NEWEST-FIRST: the API returns oldest-first, so we reverse it so the
/// most recent apply is on top (a display choice — flagged). Empty/error/loading
/// reuse [BbStatusView] in the screen.
class ApplicationsCubit extends Cubit<ApplicationsState> {
  ApplicationsCubit(this._repo) : super(const ApplicationsState());

  final ApplicationsRepository _repo;

  Future<void> load() async {
    emit(const ApplicationsState(status: ApplicationsStatus.loading));
    try {
      final List<AppliedJob> applied = await _repo.appliedJobs();
      if (isClosed) return;
      if (applied.isEmpty) {
        emit(const ApplicationsState(status: ApplicationsStatus.empty));
        return;
      }
      // Reverse oldest-first → newest-first for "recently applied" on top.
      emit(ApplicationsState(
        status: ApplicationsStatus.ready,
        jobs: applied.reversed.toList(),
      ));
    } on ConsentRequiredFailure {
      // 403 from the consent-gated GET /workers/me/applications: a worker who
      // has not completed profiling consent has no applications yet. Surface a
      // graceful "finish your profile" state, NOT a generic error. (Checked
      // before the broader `on Failure` — ConsentRequiredFailure IS a Failure.)
      if (isClosed) return;
      emit(const ApplicationsState(status: ApplicationsStatus.consentRequired));
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const ApplicationsState(status: ApplicationsStatus.error));
    }
  }
}
