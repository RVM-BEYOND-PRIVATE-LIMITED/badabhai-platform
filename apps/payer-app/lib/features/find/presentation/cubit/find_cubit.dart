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

  Future<void> load() async {
    emit(state.copyWith(status: FindStatus.loading));
    try {
      if (_useRealFeed) {
        await _loadRealFeed();
      } else {
        final List<Candidate> candidates = await _api.fetchCandidates();
        if (isClosed) return;
        emit(FindState(status: FindStatus.ready, candidates: candidates));
      }
    } catch (e) {
      if (isClosed) {
        return; // screen popped mid-load — emit would throw StateError
      }
      emit(state.copyWith(
        status: FindStatus.error,
        failure: PayerFailure.from(e),
      ));
    }
  }

  Future<void> _loadRealFeed() async {
    final List<JobPosting> jobs = await _ownedOpenJobs();
    if (isClosed) return;
    final List<JobPosting> owned = jobs
        .where((JobPosting j) => (j.id ?? '').isNotEmpty)
        .toList(growable: false);
    if (owned.isEmpty) {
      emit(const FindState(status: FindStatus.empty));
      return;
    }
    await _loadApplicants(owned.first, owned);
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

  /// Switch the REAL feed to another owned open job (job selector).
  Future<void> selectJob(JobPosting job) async {
    if (job.id == state.selectedJob?.id) return;
    emit(state.copyWith(status: FindStatus.loading));
    try {
      await _loadApplicants(job, state.jobs);
    } catch (e) {
      if (isClosed) return;
      emit(state.copyWith(
        status: FindStatus.error,
        failure: PayerFailure.from(e),
      ));
    }
  }

  Future<void> _loadApplicants(JobPosting job, List<JobPosting> jobs) async {
    final List<Applicant> applicants = await _api.fetchApplicants(job.id!);
    if (isClosed) return;
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
  Future<UnlockResult> unlockApplicant(Applicant applicant) async {
    final UnlockResult result;
    try {
      result = await _api.unlock(
        workerId: applicant.workerId,
        jobId: state.selectedJob?.id,
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
    if (result.granted) {
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

  /// True when rendering the REAL per-job feed (a job is selected).
  bool get isRealFeed => selectedJob != null;

  FindState copyWith({
    FindStatus? status,
    List<Candidate>? candidates,
    List<JobPosting>? jobs,
    JobPosting? selectedJob,
    List<Applicant>? applicants,
    PayerFailure? failure,
  }) {
    return FindState(
      status: status ?? this.status,
      candidates: candidates ?? this.candidates,
      jobs: jobs ?? this.jobs,
      selectedJob: selectedJob ?? this.selectedJob,
      applicants: applicants ?? this.applicants,
      failure: failure ?? this.failure,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, candidates, jobs, selectedJob, applicants, failure];
}
