import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the signed-in payer's job postings for the My-jobs screen and drives
/// the per-row lifecycle (publish / pause / resume / close) actions. Each action
/// returns a [JobActionResult] the screen surfaces as a toast; a 409 (illegal
/// transition) becomes an HONEST neutral message, never a crash. Lifecycle
/// actions refetch the list so the pill/buttons update.
///
/// STORE POLICY — NO MONEY ACTIONS LIVE HERE (owner decision, ADR-0035 slice).
/// This cubit used to expose `buyPlan` / `boost` / `topup`, one tap each behind
/// a confirm dialog, charging real money through
/// `POST /payer/job-postings/:id/{plan,boost,quota-topup}`. A mobile app that
/// sells a digital entitlement through its own payment rail is exactly what the
/// App Store / Play Store IAP rules exist to catch, so the whole path is gone
/// from the app: no button, and no cubit method a future screen could quietly
/// re-bind to. The API-client methods and the backend endpoints are UNCHANGED —
/// `apps/payer-web` still drives them, and the app now points there instead
/// (see `resolvePayerWebUrl`).
class JobsCubit extends Cubit<JobsState> {
  JobsCubit(this._api) : super(const JobsState());

  final PayerApiClient _api;

  Future<void> load() async {
    emit(state.copyWith(status: JobsStatus.loading));
    try {
      final List<JobPosting> jobs = await _api.fetchJobs();
      emit(JobsState(status: JobsStatus.ready, jobs: jobs));
    } catch (_) {
      emit(state.copyWith(status: JobsStatus.error));
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  /// Publish a draft (`PATCH … status:'open'`).
  Future<JobActionResult> publish(String id) => _lifecycle(
        () => _api.updateJob(id, status: 'open'),
        okMessage: 'Published — workers can see it now.',
        conflictMessage: "This job can't be published.",
      );

  Future<JobActionResult> pause(String id) => _lifecycle(
        () => _api.pauseJob(id),
        okMessage: 'Paused — hidden from workers for now.',
        conflictMessage: 'Only an open job can be paused.',
      );

  Future<JobActionResult> resume(String id) => _lifecycle(
        () => _api.resumeJob(id),
        okMessage: 'Resumed — live again.',
        conflictMessage: 'Only a paused job can be resumed.',
      );

  // Named [closePosting] (not `close`) so it does not shadow [Cubit.close].
  Future<JobActionResult> closePosting(String id) => _lifecycle(
        () => _api.closeJob(id),
        okMessage: 'Closed.',
        conflictMessage: 'Already closed.',
      );

  /// Edit an existing posting's content (`PATCH /payer/job-postings/:id`). Only
  /// the fields the edit form can safely PREFILL are editable — role title,
  /// location, vacancy band (the company row exposes no description/org to read
  /// back, so those are never sent from an edit to avoid clobbering them). Pass
  /// only changed fields; the screen guarantees ≥1 so the server never 400s a
  /// no-op. Refetches the list on success so the card reflects the new content.
  Future<JobActionResult> editJob(
    String id, {
    String? roleTitle,
    String? locationLabel,
    String? vacancyBand,
  }) =>
      _lifecycle(
        () => _api.updateJob(
          id,
          roleTitle: roleTitle,
          locationLabel: locationLabel,
          vacancyBand: vacancyBand,
        ),
        okMessage: 'Job updated.',
        conflictMessage: "This job can't be edited now.",
      );

  Future<JobActionResult> _lifecycle(
    Future<JobPosting> Function() op, {
    required String okMessage,
    required String conflictMessage,
  }) async {
    try {
      await op();
      await load();
      return JobActionResult.ok(okMessage);
    } on PayerApiException catch (e) {
      return JobActionResult.fail(
        e.isConflict ? conflictMessage : 'Could not update. Please try again.',
      );
    } catch (_) {
      return JobActionResult.fail('Network error. Check your connection.');
    }
  }

  // NOTE: `buyPlan` / `boost` / `topup` were REMOVED here (see the class doc).
  // Do not re-add them — a money action belongs on the web portal, not in the
  // store-distributed app.
}

/// The outcome of a one-shot My-jobs action — a success/neutral flag + a human
/// message the screen shows as a toast. Never carries PII.
class JobActionResult {
  const JobActionResult.ok(this.message) : success = true;
  const JobActionResult.fail(this.message) : success = false;

  final bool success;
  final String message;
}

enum JobsStatus { initial, loading, ready, error }

class JobsState extends Equatable {
  const JobsState({
    this.status = JobsStatus.initial,
    this.jobs = const <JobPosting>[],
  });

  final JobsStatus status;
  final List<JobPosting> jobs;

  JobsState copyWith({JobsStatus? status, List<JobPosting>? jobs}) {
    return JobsState(
      status: status ?? this.status,
      jobs: jobs ?? this.jobs,
    );
  }

  @override
  List<Object?> get props => <Object?>[status, jobs];
}
