import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/error/payer_failure.dart';
import '../../../../core/util/read_order.dart';

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

  /// #2592 — a quiet [refresh] and the re-read after an action can be in
  /// flight together; the one sent later wins ([ReadOrder]).
  final ReadOrder _reads = ReadOrder();

  Future<void> load() async {
    emit(state.copyWith(status: AgencyJobsStatus.loading));
    await _refresh();
  }

  /// Fetches the list WITHOUT flipping to [AgencyJobsStatus.loading] — the
  /// refetch after an action (#2594), so the list stays on screen and the
  /// closed card settles in place instead of the tab flashing to a spinner.
  /// #2592 — ordered against a quiet [refresh] in flight ([ReadOrder]).
  Future<void> _refresh() async {
    final int read = _reads.start();
    try {
      final List<AgencyJobView> jobs = await _api.fetchAgencyJobs();
      if (isClosed || !_reads.claim(read)) return; // a newer read landed
      emit(AgencyJobsState(status: AgencyJobsStatus.ready, jobs: jobs));
    } catch (_) {
      if (isClosed || !_reads.isLatest(read)) return;
      // The error replaces the list on screen: a refresh sent before the
      // close/edit must not land after it and paint the old card back.
      _reads.settle(read);
      emit(state.copyWith(status: AgencyJobsStatus.error));
    }
  }

  /// #2592 — pull-to-refresh and a return to the tab: re-reads the postings
  /// with the list staying on screen. A failure KEEPS the list and comes back
  /// to the caller to say why; null on success. With nothing on screen yet it
  /// is the normal [load].
  Future<PayerFailure?> refresh() async {
    if (state.status == AgencyJobsStatus.initial ||
        state.status == AgencyJobsStatus.loading) {
      return null; // the first load is already in flight
    }
    if (state.status == AgencyJobsStatus.error) {
      await load();
      return null;
    }
    final int read = _reads.start();
    try {
      final List<AgencyJobView> jobs = await _api.fetchAgencyJobs();
      if (isClosed) return null;
      if (_reads.claim(read)) {
        emit(AgencyJobsState(status: AgencyJobsStatus.ready, jobs: jobs));
      }
      return null;
    } catch (e) {
      if (isClosed || !_reads.isLatest(read)) return null;
      return PayerFailure.from(e);
    }
  }

  Future<JobActionResult> closePosting(String id) => _lifecycle(
        () => _api.closeAgencyJob(id),
        // The toast title already says "Job closed" (#2594).
        okMessage: 'No longer taking applicants.',
        // A close 400 means the row is already closed (the only 400 this
        // terminal transition has).
        badRequestMessage: 'This job is already closed.',
      );

  /// Edit an agency posting (`PATCH /payer/agency/jobs/:id`). Every field the
  /// [AgencyJobView] carries is typed + prefillable, so the edit form is
  /// complete (trade / title / city / area / pay & experience bands / timing).
  /// The screen sends ≥1 field; refetches on success so the card updates.
  ///
  /// [description]/[shift]/[benefits]/[requirements] are the WORKER-VISIBLE
  /// content the route also accepts, and the job view RETURNS them since #1647,
  /// so the screen prefills them and passes null for anything the payer did not
  /// touch; an explicitly EMPTY list is passed through (it clears the chips
  /// server-side). [payType] says what the ₹ band means (#1648). [clear]
  /// (#1652) names the fields the payer EMPTIED that had a saved value — never
  /// one that is also passed as a value (the server 400s that).
  Future<JobActionResult> editJob(
    String id, {
    String? tradeKey,
    String? title,
    String? city,
    String? area,
    int? payMin,
    int? payMax,
    String? payType,
    int? minExperienceYears,
    int? maxExperienceYears,
    String? neededBy,
    String? roleKind,
    String? description,
    String? shift,
    List<String>? benefits,
    List<String>? requirements,

    /// Migration 0141 — the trade-specific form. The server re-validates the
    /// rung/answers and derives `match_skill_ids` from the chips.
    String? tradeLevel,
    Map<String, List<String>>? tradeAnswers,

    /// ADR-0050 — the demand-skill pick (`match_skill_ids`). Null omits it (the
    /// stored set survives); a passed list (including `[]`) replaces it.
    List<String>? matchSkillIds,
    List<AgencyJobClearField>? clear,
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
          payType: payType,
          minExperienceYears: minExperienceYears,
          maxExperienceYears: maxExperienceYears,
          neededBy: neededBy,
          roleKind: roleKind,
          description: description,
          shift: shift,
          benefits: benefits,
          requirements: requirements,
          tradeLevel: tradeLevel,
          tradeAnswers: tradeAnswers,
          matchSkillIds: matchSkillIds,
          clear: clear,
        ),
        okMessage: 'Job updated.',
        badRequestMessage:
            'Could not save changes. Check the details and try again.',
      );

  Future<JobActionResult> _lifecycle(
    Future<AgencyJobView> Function() op, {
    required String okMessage,
    required String badRequestMessage,
  }) async {
    try {
      await op();
      await _refresh();
      return JobActionResult.ok(okMessage);
    } on PayerApiException catch (e) {
      // #1652 — checked BEFORE the blanket 400 below: a set-and-cleared edit
      // is a 400 too, and the wrong reason would be named.
      if (e.isSetAndCleared) {
        return const JobActionResult.fail(kJobEditSetAndClearedMessage);
      }
      // A save with nothing changed is NOT a closed job. The old blanket
      // `isBadRequest -> "already closed"` told a payer their freshly added,
      // still-open job was closed whenever they tapped Save without editing.
      if (e.code == kJobEditNoChangesCode) {
        return const JobActionResult.fail(kJobEditNoChangesMessage);
      }
      if (e.code == kJobEditClosedCode) {
        return const JobActionResult.fail(kJobEditClosedMessage);
      }
      // Any other validation 400 names the field the server refused (e.g.
      // "Job title: Must not contain a company name."), instead of the old
      // "check the details" that left the agent guessing — and hands every
      // issue on by field, so the edit screen can show each AT its box.
      if (e.validationMessage != null && e.validationMessage!.isNotEmpty) {
        return JobActionResult.fail(
          e.validationMessage!,
          fieldErrors: e.fieldErrors,
        );
      }
      return JobActionResult.fail(
        e.isNotFound
            ? "This job isn't available."
            : e.isBadRequest
                ? badRequestMessage
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
  const JobActionResult.ok(this.message)
      : success = true,
        fieldErrors = const <String, String>{};
  const JobActionResult.fail(
    this.message, {
    this.fieldErrors = const <String, String>{},
  }) : success = false;

  final bool success;
  final String message;

  /// #2595 — a refused edit's issues by wire field
  /// ([PayerApiException.fieldErrors]); empty otherwise.
  final Map<String, String> fieldErrors;
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
