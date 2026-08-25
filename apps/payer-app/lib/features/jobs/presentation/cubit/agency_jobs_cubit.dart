import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the AGENCY session's own job postings (`GET /payer/agency/jobs`) and
/// drives the per-row lifecycle (close / edit). Agent-only — the screen only
/// mounts this for an agency session (the routes 403 for a company).
///
/// NO PAUSE METHOD (backend contract): on the deployed backend
/// `POST /payer/agency/jobs/:id/pause` maps to a TERMINAL close server-side
/// ("pause == close", Phase-1), so a cubit method labelled pause would let a
/// future screen promise a resumable state the server cannot honour. Removed
/// until #1202 ships a real paused state + resume; the API-client method stays
/// untouched for payer-web. Actions refetch the list so the pill/buttons update.
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

  /// Edit an agency posting (`PATCH /payer/agency/jobs/:id`). Every field the
  /// [AgencyJobView] carries is typed + prefillable, so the edit form is
  /// complete (trade / title / city / area / pay & experience bands / timing).
  /// The screen sends ≥1 field; refetches on success so the card updates.
  Future<JobActionResult> editJob(
    String id, {
    String? tradeKey,
    String? title,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
  }) =>
      _lifecycle(
        () => _api.updateAgencyJob(
          id,
          tradeKey: tradeKey,
          title: title,
          city: city,
          area: area,
          payMin: payMin,
          payMax: payMax,
          minExperienceYears: minExperienceYears,
          maxExperienceYears: maxExperienceYears,
          neededBy: neededBy,
        ),
        okMessage: 'Job updated.',
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
