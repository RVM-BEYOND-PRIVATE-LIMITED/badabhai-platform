import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/candidate_search_models.dart';
import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/error/payer_failure.dart';
import '../../../../core/util/read_order.dart';

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
/// re-bind to. The mobile API-client methods are gone too (#2589); the backend
/// endpoints are UNCHANGED and `apps/payer-web` still drives them.
class JobsCubit extends Cubit<JobsState> {
  JobsCubit(this._api) : super(const JobsState());

  final PayerApiClient _api;

  /// #2592 — a quiet [refresh] and the re-read after an action can be in
  /// flight together; the one sent later wins ([ReadOrder]).
  final ReadOrder _reads = ReadOrder();

  Future<void> load() async {
    emit(state.copyWith(status: JobsStatus.loading));
    await Future.wait(<Future<void>>[
      _refresh(),
      _loadMatchingVocabulary(),
    ]);
  }

  /// #2671 — the find-matching button needs the 16-trade catalogue (the job's
  /// own `match_skill_id`) and the Candidates filter cities (a city the search
  /// does not recognise must never be sent). Both are vocabulary, not worker
  /// data; a failure keeps the previous read (or none) and never fails the job
  /// list — without them the button simply reads the city as absent.
  Future<void> _loadMatchingVocabulary() async {
    final Future<List<PostingTradeForm>> tradesRead = _readTrades();
    final Future<CandidateFilters?> filtersRead = _readFilters();
    final List<PostingTradeForm> trades = await tradesRead;
    final CandidateFilters? filters = await filtersRead;
    if (isClosed) return;
    emit(state.copyWith(postingTrades: trades, candidateFilters: filters));
  }

  Future<List<PostingTradeForm>> _readTrades() async {
    try {
      return await _api.fetchPostingTrades();
    } catch (_) {
      return state.postingTrades;
    }
  }

  Future<CandidateFilters?> _readFilters() async {
    try {
      return await _api.fetchCandidateFilters();
    } catch (_) {
      return state.candidateFilters;
    }
  }

  /// Fetches the list WITHOUT flipping to [JobsStatus.loading] — the refetch
  /// after an action (#2594), so the list stays on screen and the changed card
  /// settles in place instead of the whole tab flashing to a spinner. #2592 —
  /// ordered against a quiet [refresh] in flight ([ReadOrder]).
  Future<void> _refresh() async {
    final int read = _reads.start();
    try {
      final List<JobPosting> jobs = await _api.fetchJobs();
      if (isClosed) {
        return; // screen popped mid-load — emit would throw StateError
      }
      if (!_reads.claim(read)) return; // a newer read already landed
      emit(JobsState(
        status: JobsStatus.ready,
        jobs: jobs,
        postingTrades: state.postingTrades,
        candidateFilters: state.candidateFilters,
      ));
    } catch (e) {
      if (isClosed || !_reads.isLatest(read)) return;
      // The error replaces the list on screen: a refresh sent before the
      // action must not land after it and paint the old pills back.
      _reads.settle(read);
      emit(state.copyWith(
        status: JobsStatus.error,
        failure: PayerFailure.from(e),
      ));
    }
  }

  /// #2592 — pull-to-refresh and a return to the tab: re-reads the postings
  /// with the list staying on screen. A failure KEEPS the list and comes back
  /// to the caller to say why; null on success. With nothing on screen yet it
  /// is the normal [load].
  Future<PayerFailure?> refresh() async {
    if (state.status == JobsStatus.initial ||
        state.status == JobsStatus.loading) {
      return null; // the first load is already in flight
    }
    if (state.status == JobsStatus.error) {
      await load();
      return null;
    }
    final int read = _reads.start();
    try {
      final List<JobPosting> jobs = await _api.fetchJobs();
      if (isClosed) return null;
      if (_reads.claim(read)) {
        emit(JobsState(
          status: JobsStatus.ready,
          jobs: jobs,
          postingTrades: state.postingTrades,
          candidateFilters: state.candidateFilters,
        ));
      }
      return null;
    } catch (e) {
      if (isClosed || !_reads.isLatest(read)) return null;
      return PayerFailure.from(e);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  // The ok messages sit under a toast title that already names the action
  // ("Job paused", #2594), so each says what changed for workers.

  /// Publish a draft (`PATCH … status:'open'`).
  Future<JobActionResult> publish(String id) => _lifecycle(
        () => _api.updateJob(id, status: 'open'),
        okMessage: 'Workers can see it now.',
        conflictMessage: "This job can't be published.",
      );

  Future<JobActionResult> pause(String id) => _lifecycle(
        () => _api.pauseJob(id),
        okMessage: 'Hidden from workers until you resume it.',
        conflictMessage: 'Only an open job can be paused.',
      );

  Future<JobActionResult> resume(String id) => _lifecycle(
        () => _api.resumeJob(id),
        okMessage: 'Workers can see it again.',
        conflictMessage: 'Only a paused job can be resumed.',
      );

  // Named [closePosting] (not `close`) so it does not shadow [Cubit.close].
  Future<JobActionResult> closePosting(String id) => _lifecycle(
        () => _api.closeJob(id),
        okMessage: 'Workers can no longer apply.',
        conflictMessage: 'This job is already closed.',
      );

  /// Edit an existing posting's content (`PATCH /payer/job-postings/:id`) —
  /// role title, location, vacancy band, plus the WORKER-VISIBLE display fields
  /// the payer row really carries back and the PATCH schema really accepts
  /// ([city], [area], [payMin]/[payMax], [payType], the experience window,
  /// [shift], [neededBy], [description], [benefits], [requirements]). Pass only
  /// changed fields; the screen guarantees ≥1 so the server never 400s a no-op,
  /// and it sends nothing it could not prefill (a null leaves the stored value
  /// alone rather than clobbering it with a blank). A chip list is the one
  /// exception: an explicitly EMPTY list IS sent, because `[]` is how the
  /// contract clears one. [clear] (#1652) names the fields the payer EMPTIED
  /// that had a saved value — never one that is also passed as a value (the
  /// server 400s that; it comes back as [kJobEditSetAndClearedMessage]).
  /// Refetches on success so the card reflects the new content.
  Future<JobActionResult> editJob(
    String id, {
    String? roleTitle,
    String? locationLabel,
    String? vacancyBand,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? shift,
    String? neededBy,
    String? roleKind,
    String? description,
    List<String>? benefits,
    List<String>? requirements,

    /// Migration 0141 — the trade-specific form. The server re-validates the
    /// rung/answers and derives `match_skill_ids` from the chips.
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,
    List<JobPostingClearField>? clear,
  }) =>
      _lifecycle(
        () => _api.updateJob(
          id,
          roleTitle: roleTitle,
          locationLabel: locationLabel,
          vacancyBand: vacancyBand,
          city: city,
          area: area,
          payMin: payMin,
          payMax: payMax,
          payType: payType,
          minExperienceYears: minExperienceYears,
          maxExperienceYears: maxExperienceYears,
          shift: shift,
          neededBy: neededBy,
          roleKind: roleKind,
          description: description,
          benefits: benefits,
          requirements: requirements,
          tradeLevel: tradeLevel,
          tradeAnswers: tradeAnswers,
          clear: clear,
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
      await _refresh();
      return JobActionResult.ok(okMessage);
    } on PayerApiException catch (e) {
      // #1652 — a set-and-cleared edit is named for what it is: retrying the
      // same save cannot succeed.
      if (e.isSetAndCleared) {
        return const JobActionResult.fail(kJobEditSetAndClearedMessage);
      }
      if (e.code == kJobEditNoChangesCode) {
        return const JobActionResult.fail(kJobEditNoChangesMessage);
      }
      if (e.code == kJobEditClosedCode) {
        return const JobActionResult.fail(kJobEditClosedMessage);
      }
      // #2635 — a live company job must name one of the 16 trades. Flagged so
      // the screen opens the trade picker instead of toasting; the issue rides
      // at `role_kind`, so a form shows it AT the picker.
      if (e.isPostingTradeRequired) {
        return JobActionResult.fail(
          kPostingTradeRequiredMessage,
          fieldErrors: e.fieldErrors,
          tradeRequired: true,
        );
      }
      // A field-level validation 400 names the box to fix, e.g.
      // "Job title: Must not contain a company name." — and hands every
      // issue on by field, so the edit screen can show each AT its box.
      if (e.validationMessage != null && e.validationMessage!.isNotEmpty) {
        return JobActionResult.fail(
          e.validationMessage!,
          fieldErrors: e.fieldErrors,
        );
      }
      return JobActionResult.fail(
        e.isConflict ? conflictMessage : 'Could not update. Please try again.',
      );
    } catch (e) {
      // Name the real reason (a timeout is not a dead link) — same honesty as
      // load(), instead of a blanket "check your connection".
      return JobActionResult.fail(PayerFailure.from(e).message);
    }
  }

  // NOTE: `buyPlan` / `boost` / `topup` were REMOVED here (see the class doc).
  // Do not re-add them — a money action belongs on the web portal, not in the
  // store-distributed app.
}

/// The outcome of a one-shot My-jobs action — a success/neutral flag + a human
/// message the screen shows as a toast. Never carries PII.
class JobActionResult {
  const JobActionResult.ok(this.message)
      : success = true,
        fieldErrors = const <String, String>{},
        tradeRequired = false;
  const JobActionResult.fail(
    this.message, {
    this.fieldErrors = const <String, String>{},
    this.tradeRequired = false,
  }) : success = false;

  final bool success;
  final String message;

  /// #2595 — a refused edit's issues by wire field
  /// ([PayerApiException.fieldErrors]); empty otherwise.
  final Map<String, String> fieldErrors;

  /// #2635 — the server refused because the job would be live without one of
  /// the 16 trades ([PayerApiException.isPostingTradeRequired]). The caller
  /// shows the trade picker, never a toast of the reason.
  final bool tradeRequired;
}

enum JobsStatus { initial, loading, ready, error }

class JobsState extends Equatable {
  const JobsState({
    this.status = JobsStatus.initial,
    this.jobs = const <JobPosting>[],
    this.failure,
    this.postingTrades = const <PostingTradeForm>[],
    this.candidateFilters,
  });

  final JobsStatus status;
  final List<JobPosting> jobs;

  /// The classified reason the last load failed — drives the honest error copy.
  /// Null unless [status] is [JobsStatus.error].
  final PayerFailure? failure;

  /// #2671 — the 16-trade catalogue (`GET /payer/posting-trades`), read beside
  /// the list so a card can offer "Find matching workers" with its job's own
  /// trade. Empty until loaded (or when the read failed).
  final List<PostingTradeForm> postingTrades;

  /// #2671 — the Candidates filter options, read for their city vocabulary
  /// only: a job city the search does not list is left out. Null until loaded
  /// (or when the read failed).
  final CandidateFilters? candidateFilters;

  JobsState copyWith({
    JobsStatus? status,
    List<JobPosting>? jobs,
    PayerFailure? failure,
    List<PostingTradeForm>? postingTrades,
    CandidateFilters? candidateFilters,
  }) {
    return JobsState(
      status: status ?? this.status,
      jobs: jobs ?? this.jobs,
      failure: failure ?? this.failure,
      postingTrades: postingTrades ?? this.postingTrades,
      candidateFilters: candidateFilters ?? this.candidateFilters,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, jobs, failure, postingTrades, candidateFilters];
}
