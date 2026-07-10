import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the signed-in payer's job postings for the My-jobs screen and drives
/// the per-row lifecycle (publish / pause / resume / close) + monetization
/// (buy-plan / boost / quota-topup) actions. Each action returns a
/// [JobActionResult] the screen surfaces as a toast; a 409 (illegal transition,
/// no active plan, active boost exists) becomes an HONEST neutral message,
/// never a crash. Lifecycle actions refetch the list so the pill/buttons update.
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

  // --- Monetization ----------------------------------------------------------

  Future<JobActionResult> buyPlan(String id, String tier) async {
    try {
      final PlanPurchase p = await _api.buyPlan(id, tier: tier);
      await load();
      final int? q = p.applicantVisibilityQuota;
      return JobActionResult.ok(
        q == null ? 'Plan active.' : 'Plan active · $q applicant views.',
      );
    } on PayerApiException {
      return JobActionResult.fail("Couldn't buy the plan right now.");
    } catch (_) {
      return JobActionResult.fail('Network error. Check your connection.');
    }
  }

  Future<JobActionResult> boost(String id) async {
    try {
      await _api.buyBoost(id);
      await load();
      return JobActionResult.ok('Boosted — more reach, within relevance.');
    } on PayerApiException catch (e) {
      return JobActionResult.fail(
        e.isConflict
            ? 'This job already has an active boost.'
            : "Couldn't boost right now.",
      );
    } catch (_) {
      return JobActionResult.fail('Network error. Check your connection.');
    }
  }

  Future<JobActionResult> topup(String id, String tier) async {
    try {
      final PlanPurchase p = await _api.quotaTopup(id, tier: tier);
      await load();
      final int? q = p.applicantVisibilityQuota;
      return JobActionResult.ok(
        q == null ? 'Quota topped up.' : 'Quota topped up · +$q views.',
      );
    } on PayerApiException catch (e) {
      return JobActionResult.fail(
        e.isConflict
            ? 'Buy a plan first, then top up.'
            : "Couldn't top up right now.",
      );
    } catch (_) {
      return JobActionResult.fail('Network error. Check your connection.');
    }
  }
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
