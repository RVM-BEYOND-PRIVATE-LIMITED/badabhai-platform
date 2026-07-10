import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/config/app_config.dart';
import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';

/// Loads the Find feed. Two shapes behind one cubit:
///
///  - MOCK feed ([kUseMocks] true) — the rich global candidate list; an unlock
///    flips the card locally from "₹40" to "View" without a refetch.
///  - REAL feed — the payer's OPEN postings drive a per-job, FACELESS applicant
///    list (`GET /payer/reach/jobs/:jobId/applicants`). With >1 open job a
///    selector is shown; with none, an empty state ("post a job").
///
/// The credit spend is server-truth in REAL mode: [unlockApplicant] hits
/// `POST /payer/unlocks` with the real worker UUID and returns a typed
/// [UnlockResult] (the neutral DENY is never treated as success).
class FindCubit extends Cubit<FindState> {
  FindCubit(this._api, {bool? useRealFeed})
      : _useRealFeed = useRealFeed ?? !kUseMocks,
        super(const FindState());

  final PayerApiClient _api;
  final bool _useRealFeed;

  Future<void> load() async {
    emit(state.copyWith(status: FindStatus.loading));
    try {
      if (_useRealFeed) {
        await _loadRealFeed();
      } else {
        final List<Candidate> candidates = await _api.fetchCandidates();
        emit(FindState(status: FindStatus.ready, candidates: candidates));
      }
    } catch (_) {
      emit(state.copyWith(status: FindStatus.error));
    }
  }

  Future<void> _loadRealFeed() async {
    final List<JobPosting> jobs = await _api.fetchJobs(status: 'open');
    final List<JobPosting> owned = jobs
        .where((JobPosting j) => (j.id ?? '').isNotEmpty)
        .toList(growable: false);
    if (owned.isEmpty) {
      emit(const FindState(status: FindStatus.empty));
      return;
    }
    await _loadApplicants(owned.first, owned);
  }

  /// Switch the REAL feed to another owned open job (job selector).
  Future<void> selectJob(JobPosting job) async {
    if (job.id == state.selectedJob?.id) return;
    emit(state.copyWith(status: FindStatus.loading));
    try {
      await _loadApplicants(job, state.jobs);
    } catch (_) {
      emit(state.copyWith(status: FindStatus.error));
    }
  }

  Future<void> _loadApplicants(JobPosting job, List<JobPosting> jobs) async {
    final List<Applicant> applicants = await _api.fetchApplicants(job.id!);
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
  Future<UnlockResult> unlockApplicant(Applicant applicant) async {
    final UnlockResult result = await _api.unlock(
      workerId: applicant.workerId,
      jobId: state.selectedJob?.id,
    );
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
  });

  final FindStatus status;

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
  }) {
    return FindState(
      status: status ?? this.status,
      candidates: candidates ?? this.candidates,
      jobs: jobs ?? this.jobs,
      selectedJob: selectedJob ?? this.selectedJob,
      applicants: applicants ?? this.applicants,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, candidates, jobs, selectedJob, applicants];
}
