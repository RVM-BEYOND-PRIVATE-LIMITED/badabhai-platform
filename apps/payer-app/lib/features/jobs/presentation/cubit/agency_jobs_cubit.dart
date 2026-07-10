import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the AGENCY session's own job postings (`GET /payer/agency/jobs`) and
/// drives the per-row lifecycle (close / pause). Agent-only — the screen only
/// mounts this for an agency session (the routes 403 for a company). A pause
/// returns `status:'closed'` (Phase-1 has no `paused` state), so its success
/// copy says so honestly. Actions refetch the list so the pill/buttons update.
class AgencyJobsCubit extends Cubit<AgencyJobsState> {
  AgencyJobsCubit(this._api) : super(const AgencyJobsState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: AgencyJobsStatus.loading));
    try {
      final List<AgencyJobView> jobs = await _api.fetchAgencyJobs();
      emit(AgencyJobsState(status: AgencyJobsStatus.ready, jobs: jobs));
    } catch (_) {
      emit(state.copyWith(status: AgencyJobsStatus.error));
    }
  }

  Future<JobActionResult> closePosting(String id) => _lifecycle(
        () => _api.closeAgencyJob(id),
        okMessage: 'Closed — no longer taking applicants.',
      );

  /// A pause maps to `closed` server-side (Phase-1 has no separate paused
  /// state) — surfaced honestly so the payer is not misled.
  Future<JobActionResult> pausePosting(String id) => _lifecycle(
        () => _api.pauseAgencyJob(id),
        okMessage: 'Paused — the job is now closed (no separate paused state).',
      );

  Future<JobActionResult> _lifecycle(
    Future<AgencyJobView> Function() op, {
    required String okMessage,
  }) async {
    try {
      await op();
      await load();
      return JobActionResult.ok(okMessage);
    } on PayerApiException catch (e) {
      return JobActionResult.fail(
        e.isNotFound
            ? "This job isn't available."
            : e.isBadRequest
                ? 'This job is already closed.'
                : 'Could not update. Please try again.',
      );
    } catch (_) {
      return JobActionResult.fail('Network error. Check your connection.');
    }
  }
}

/// The outcome of a one-shot agency My-jobs action — a success/neutral flag + a
/// human message the screen shows as a toast. Never carries PII.
class JobActionResult {
  const JobActionResult.ok(this.message) : success = true;
  const JobActionResult.fail(this.message) : success = false;

  final bool success;
  final String message;
}

enum AgencyJobsStatus { initial, loading, ready, error }

class AgencyJobsState extends Equatable {
  const AgencyJobsState({
    this.status = AgencyJobsStatus.initial,
    this.jobs = const <AgencyJobView>[],
  });

  final AgencyJobsStatus status;
  final List<AgencyJobView> jobs;

  AgencyJobsState copyWith({
    AgencyJobsStatus? status,
    List<AgencyJobView>? jobs,
  }) {
    return AgencyJobsState(
      status: status ?? this.status,
      jobs: jobs ?? this.jobs,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, jobs];
}
