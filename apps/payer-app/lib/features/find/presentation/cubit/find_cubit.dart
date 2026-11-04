import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/config/app_config.dart';
import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/error/payer_failure.dart';

/// Loads the Find feed. Two shapes behind one cubit:
///
///  - MOCK feed ([kUseMocks] true) — the rich global candidate list; an unlock
///    flips the card locally from "1 credit" to "View" without a refetch.
///  - REAL feed — the payer's OPEN postings drive a per-job, FACELESS applicant
///    list (`GET /payer/reach/jobs/:jobId/applicants`). With >1 open job a
///    selector is shown; with none, an empty state ("post a job").
///
/// The credit spend is server-truth in REAL mode: [unlockApplicant] hits
/// `POST /payer/unlocks` with the real worker UUID and returns a typed
/// [UnlockResult] (the neutral DENY is never treated as success).
class FindCubit extends Cubit<FindState> {
  FindCubit(this._api, {bool? useRealFeed, bool? isAgency})
      : _useRealFeed = useRealFeed ?? !kUseMocks,
        _isAgency = isAgency ?? false,
        super(const FindState());

  final PayerApiClient _api;
  final bool _useRealFeed;

  /// Agency sessions own `jobs` rows, not `job_postings`; the per-job applicant
  /// route is shared, so only the job-source read differs. Without this branch an
  /// agency account's Find tab looked at company postings it does not own (or,
  /// with none, claimed it had no applicants at all).
  final bool _isAgency;

  /// #2592 — bumped by every read that REPLACES the feed ([load], [refresh],
  /// [selectJob]); a response from an older read lost the race and is dropped,
  /// so a slow job switch never lands over the one the payer tapped after it.
  int _generation = 0;

  Future<void> load() async {
    final int generation = ++_generation;
    emit(state.copyWith(status: FindStatus.loading));
    try {
      if (_useRealFeed) {
        await _loadRealFeed(generation);
      } else {
        final List<Candidate> candidates = await _api.fetchCandidates();
        if (isClosed || generation != _generation) return;
        emit(FindState(status: FindStatus.ready, candidates: candidates));
      }
    } catch (e) {
      if (isClosed || generation != _generation) {
        return; // screen popped mid-load — emit would throw StateError
      }
      emit(state.copyWith(
        status: FindStatus.error,
        failure: PayerFailure.from(e),
      ));
    }
  }

  Future<void> _loadRealFeed(int generation) async {
    final List<JobPosting> jobs = await _ownedOpenJobs();
    if (isClosed || generation != _generation) return;
    final List<JobPosting> owned = jobs
        .where((JobPosting j) => (j.id ?? '').isNotEmpty)
        .toList(growable: false);
    if (owned.isEmpty) {
      emit(const FindState(status: FindStatus.empty));
      return;
    }
    await _loadApplicants(owned.first, owned, generation);
  }

  /// The session's OWN open jobs: company postings or agency `jobs` rows.
  /// Both are resolved by the one applicant route (`/payer/reach/jobs/:id/
  /// applicants`), so the feed below is identical once a job is picked.
  Future<List<JobPosting>> _ownedOpenJobs() async {
    if (!_isAgency) return _api.fetchJobs(status: 'open');
    final List<AgencyJobView> rows = await _api.fetchAgencyJobs();
    return rows
        .where((AgencyJobView j) => j.status == 'open' && j.id.isNotEmpty)
        .map(
          (AgencyJobView j) => JobPosting(
            id: j.id,
            title: j.title,
            band: '',
            city: j.city,
            filled: 0,
            quota: 0,
            applicants: j.applicantsReceived,
            unlocks: 0,
            status: JobStatus.live,
            verified: false,
            boosted: false,
            wireStatus: j.status,
          ),
        )
        .toList(growable: false);
  }

  /// #2592 — the quiet re-read behind pull-to-refresh and a return to the
  /// tab: the rows on screen STAY until the fresh ones land (no skeleton), and
  /// the selected job is kept while it is still open. A failure keeps the rows
  /// and comes back to the caller to say why; null on success. With nothing on
  /// screen yet (an error, the first load) it is the normal [load].
  ///
  /// A job switch in flight is left alone: it is already reading fresh rows
  /// for the job the payer picked, and bumping [_generation] here would drop
  /// them (and, on a failed refresh, leave the rows dimmed for good).
  Future<PayerFailure?> refresh() async {
    if (state.status == FindStatus.initial ||
        state.status == FindStatus.loading) {
      return null; // the first load is already in flight
    }
    if (state.status == FindStatus.error) {
      await load();
      return null;
    }
    if (state.switchingJobId != null) return null;
    final int generation = ++_generation;
    try {
      if (!_useRealFeed) {
        final List<Candidate> candidates = await _api.fetchCandidates();
        if (isClosed || generation != _generation) return null;
        emit(FindState(status: FindStatus.ready, candidates: candidates));
        return null;
      }
      final List<JobPosting> owned = (await _ownedOpenJobs())
          .where((JobPosting j) => (j.id ?? '').isNotEmpty)
          .toList(growable: false);
      if (isClosed || generation != _generation) return null;
      if (owned.isEmpty) {
        emit(const FindState(status: FindStatus.empty));
        return null;
      }
      final String? keep = state.selectedJob?.id;
      final JobPosting job = owned.firstWhere(
        (JobPosting j) => j.id == keep,
        orElse: () => owned.first,
      );
      final List<Applicant> applicants = await _api.fetchApplicants(job.id!);
      if (isClosed || generation != _generation) return null;
      emit(FindState(
        status: FindStatus.ready,
        jobs: owned,
        selectedJob: job,
        applicants: applicants,
      ));
      return null;
    } catch (e) {
      if (isClosed || generation != _generation) return null;
      return PayerFailure.from(e);
    }
  }

  /// Switch the REAL feed to another owned open job (job selector).
  ///
  /// #2592 — the current rows stay on screen, dimmed, while the new job's
  /// applicants load ([FindState.switchingJobId]); [FindState.selectedJob]
  /// only moves once they have landed, so a failed switch never claims a job
  /// whose feed it could not read.
  Future<void> selectJob(JobPosting job) async {
    // Re-picking the job on screen, or the one already loading, is a no-op.
    if (job.id == (state.switchingJobId ?? state.selectedJob?.id)) return;
    final int generation = ++_generation;
    emit(state.copyWith(switchingJobId: job.id));
    try {
      final List<Applicant> applicants = await _api.fetchApplicants(job.id!);
      if (isClosed || generation != _generation) return;
      emit(FindState(
        status: FindStatus.ready,
        jobs: state.jobs,
        selectedJob: job,
        applicants: applicants,
      ));
    } catch (e) {
      if (isClosed || generation != _generation) return;
      emit(FindState(
        status: FindStatus.error,
        jobs: state.jobs,
        selectedJob: state.selectedJob,
        applicants: state.applicants,
        failure: PayerFailure.from(e),
      ));
    }
  }

  Future<void> _loadApplicants(
    JobPosting job,
    List<JobPosting> jobs,
    int generation,
  ) async {
    final List<Applicant> applicants = await _api.fetchApplicants(job.id!);
    if (isClosed || generation != _generation) return;
    emit(FindState(
      status: FindStatus.ready,
      jobs: jobs,
      selectedJob: job,
      applicants: applicants,
    ));
  }

  /// REAL unlock: spend a credit against the opaque worker UUID. On a grant the
  /// applicant is marked unlocked (with its `unlockId`) so a later "View" can
  /// reveal without re-unlocking. Returns the typed result for the caller to
  /// route (reveal on grant, neutral toast on `unavailable`).
  ///
  /// #348 — an OUTAGE surfaces as an error state AND rethrows. Both matter: the
  /// state keeps this cubit consistent with its siblings ([load]/[selectJob],
  /// which already emit [FindStatus.error]), and the rethrow lets the tap
  /// handler show a retry toast. It must NOT be swallowed into
  /// `UnlockResult.unavailable()` — that is the neutral DENY, and conflating an
  /// outage with a deny is exactly the bug #346 fixed one layer down.
  ///
  /// #2592 — [jobId] is the job whose feed the tapped row came from, bound at
  /// the TAP: a job switch can land while the confirm dialog is open, and the
  /// grant must be filed against the posting the worker applied to, never the
  /// one selected by the time the payer confirms. The row is marked unlocked
  /// only while that job's feed is still the one on screen.
  Future<UnlockResult> unlockApplicant(
    Applicant applicant, {
    String? jobId,
  }) async {
    final String? job = jobId ?? state.selectedJob?.id;
    final UnlockResult result;
    try {
      result = await _api.unlock(
        workerId: applicant.workerId,
        jobId: job,
      );
    } catch (e) {
      // Keep the rethrow (the tap handler shows a retry toast) but never emit into
      // a closed cubit if the screen was popped during the unlock round-trip.
      if (!isClosed) {
        emit(state.copyWith(
          status: FindStatus.error,
          failure: PayerFailure.from(e),
        ));
      }
      rethrow;
    }
    if (isClosed) return result;
    if (result.granted && state.selectedJob?.id == job) {
      emit(state.copyWith(
        applicants: state.applicants
            .map((Applicant a) => a.workerId == applicant.workerId
                ? a.copyWith(unlocked: true, unlockId: result.unlockId)
                : a)
            .toList(growable: false),
      ));
    }
    return result;
  }

  /// Mark a MOCK candidate unlocked in the local list (call after the spend).
  void markUnlocked(int candidateId) {
    emit(
      state.copyWith(
        candidates: state.candidates
            .map(
              (Candidate c) =>
                  c.id == candidateId ? c.copyWith(unlocked: true) : c,
            )
            .toList(growable: false),
      ),
    );
  }
}

enum FindStatus { initial, loading, ready, error, empty }

class FindState extends Equatable {
  const FindState({
    this.status = FindStatus.initial,
    this.candidates = const <Candidate>[],
    this.jobs = const <JobPosting>[],
    this.selectedJob,
    this.applicants = const <Applicant>[],
    this.failure,
    this.switchingJobId,
  });

  final FindStatus status;

  /// The classified reason the last load failed — drives the honest error copy.
  /// Null unless [status] is [FindStatus.error].
  final PayerFailure? failure;

  /// MOCK feed rows.
  final List<Candidate> candidates;

  /// REAL feed — the payer's open postings (drives the job selector).
  final List<JobPosting> jobs;

  /// REAL feed — the currently selected owned job (`null` in MOCK mode).
  final JobPosting? selectedJob;

  /// REAL feed — faceless applicants for [selectedJob].
  final List<Applicant> applicants;

  /// #2592 — the job the payer just picked while its applicants load: the
  /// rows for [selectedJob] stay on screen, dimmed, until they are replaced.
  /// Null when no switch is in flight.
  final String? switchingJobId;

  /// True when rendering the REAL per-job feed (a job is selected).
  bool get isRealFeed => selectedJob != null;

  FindState copyWith({
    FindStatus? status,
    List<Candidate>? candidates,
    List<JobPosting>? jobs,
    JobPosting? selectedJob,
    List<Applicant>? applicants,
    PayerFailure? failure,
    String? switchingJobId,
  }) {
    return FindState(
      status: status ?? this.status,
      candidates: candidates ?? this.candidates,
      jobs: jobs ?? this.jobs,
      selectedJob: selectedJob ?? this.selectedJob,
      applicants: applicants ?? this.applicants,
      failure: failure ?? this.failure,
      switchingJobId: switchingJobId ?? this.switchingJobId,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        candidates,
        jobs,
        selectedJob,
        applicants,
        failure,
        switchingJobId,
      ];
}
