import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/config/app_config.dart';
import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/error/payer_failure.dart';

/// Loads the Find feed. Two shapes behind one cubit:
///
///  - MOCK feed ([kUseMocks] true) — the rich global candidate list; an unlock
///    flips the card locally from "Unlock" to "View" without a refetch.
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

  /// The job the REAL feed opens on (#2593): the one a Jobs card's
  /// "Applicants" was tapped on, then whichever the selector picked last. Null
  /// = the first open job.
  String? _wantedJobId;

  /// One request per worker (#2593): a second unlock while one is in flight
  /// joins it, never a second spend.
  final Map<String, Future<UnlockResult>> _unlocksInFlight =
      <String, Future<UnlockResult>>{};

  /// Loads the feed. [jobId] is the posting a Jobs card's "Applicants" was
  /// tapped on (#2593): the feed opens on THAT job when it is one of the
  /// payer's open postings — it used to open on the first one whatever was
  /// tapped — else on the first. Null keeps the job asked for last, so the
  /// error state's Retry stays on the tapped job.
  Future<void> load({String? jobId}) async {
    if (jobId != null) _wantedJobId = jobId;
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
    // A tapped job that is no longer open (closed since the Jobs list loaded)
    // falls back to the first; the header and the selector name the job shown.
    final JobPosting job = owned.firstWhere(
      (JobPosting j) => j.id == _wantedJobId,
      orElse: () => owned.first,
    );
    await _loadApplicants(job, owned, generation);
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
        // An unlock still in flight keeps its spinner across a refresh.
        unlocking: state.unlocking,
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
    _wantedJobId = job.id;
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
        // An unlock still in flight keeps its spinner across a job switch.
        unlocking: state.unlocking,
      ));
    } catch (e) {
      if (isClosed || generation != _generation) return;
      emit(FindState(
        status: FindStatus.error,
        jobs: state.jobs,
        selectedJob: state.selectedJob,
        applicants: state.applicants,
        failure: PayerFailure.from(e),
        unlocking: state.unlocking,
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
      // An unlock still in flight keeps its spinner across a job switch.
      unlocking: state.unlocking,
    ));
  }

  /// REAL unlock: spend a credit against the opaque worker UUID. On a grant the
  /// applicant is marked unlocked (with its `unlockId`) so a later "View" can
  /// reveal without re-unlocking. Returns the typed result for the caller to
  /// route (reveal on grant, neutral toast on `unavailable`).
  ///
  /// #2593 — ONE REQUEST PER WORKER: while it is in flight the worker is in
  /// [FindState.unlocking] (the card's button shows progress), and a second
  /// call joins the first instead of spending again.
  ///
  /// #348 / #2593 — an OUTAGE rethrows, so the tap handler shows a retry toast,
  /// and the LIST STAYS: one failed unlock used to swap the whole feed for an
  /// error page. It must NOT be swallowed into `UnlockResult.unavailable()` —
  /// that is the neutral DENY, and conflating an outage with a deny is exactly
  /// the bug #346 fixed one layer down.
  ///
  /// #2592 — [jobId] is the job whose feed the tapped row came from, bound at
  /// the TAP: a job switch can land while the confirm dialog is open, and the
  /// grant must be filed against the posting the worker applied to, never the
  /// one selected by the time the payer confirms. The row is marked unlocked
  /// only while that job's feed is still the one on screen.
  Future<UnlockResult> unlockApplicant(
    Applicant applicant, {
    String? jobId,
  }) {
    final String workerId = applicant.workerId;
    // A BLOCK body on purpose: `=> remove(...)` would return the removed value
    // — this very future — and `whenComplete` would wait on itself forever.
    return _unlocksInFlight[workerId] ??=
        _unlockApplicant(workerId, jobId ?? state.selectedJob?.id)
            .whenComplete(() {
      _unlocksInFlight.remove(workerId);
    });
  }

  Future<UnlockResult> _unlockApplicant(String workerId, String? jobId) async {
    if (!isClosed) {
      emit(state.copyWith(unlocking: <String>{...state.unlocking, workerId}));
    }
    final UnlockResult result;
    try {
      result = await _api.unlock(workerId: workerId, jobId: jobId);
    } catch (_) {
      // Never emit into a closed cubit (the screen popped mid-request).
      if (!isClosed) {
        emit(state.copyWith(
          unlocking: state.unlocking.difference(<String>{workerId}),
        ));
      }
      rethrow;
    }
    if (isClosed) return result;
    final bool onScreen = state.selectedJob?.id == jobId;
    emit(state.copyWith(
      unlocking: state.unlocking.difference(<String>{workerId}),
      applicants: result.granted && onScreen
          ? state.applicants
              .map((Applicant a) => a.workerId == workerId
                  ? a.copyWith(unlocked: true, unlockId: result.unlockId)
                  : a)
              .toList(growable: false)
          : null,
    ));
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
    this.unlocking = const <String>{},
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

  /// REAL feed — workers with an unlock in flight (their button shows
  /// progress and takes no tap, #2593).
  final Set<String> unlocking;

  /// True when rendering the REAL per-job feed (a job is selected).
  bool get isRealFeed => selectedJob != null;

  bool isUnlocking(String workerId) => unlocking.contains(workerId);

  FindState copyWith({
    FindStatus? status,
    List<Candidate>? candidates,
    List<JobPosting>? jobs,
    JobPosting? selectedJob,
    List<Applicant>? applicants,
    PayerFailure? failure,
    String? switchingJobId,
    Set<String>? unlocking,
  }) {
    return FindState(
      status: status ?? this.status,
      candidates: candidates ?? this.candidates,
      jobs: jobs ?? this.jobs,
      selectedJob: selectedJob ?? this.selectedJob,
      applicants: applicants ?? this.applicants,
      failure: failure ?? this.failure,
      switchingJobId: switchingJobId ?? this.switchingJobId,
      unlocking: unlocking ?? this.unlocking,
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
        unlocking,
      ];
}
