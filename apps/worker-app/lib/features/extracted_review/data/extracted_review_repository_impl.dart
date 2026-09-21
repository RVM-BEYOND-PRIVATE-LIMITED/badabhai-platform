import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/extracted_review.dart';
import '../domain/extracted_review_repository.dart';

/// Live extracted-review source (#1595): the stores that own each fact —
/// `GET /workers/me/profile-summary` for the extracted skills/machines/
/// experience labels, `GET /workers/me/qualifications` for the education +
/// certificate rows, `GET /workers/me/profile` for the correction anchor —
/// and the audited `POST /profile/corrections` writer.
///
/// PII posture (§2): names/cities flow through only as display strings the
/// server already shaped for this worker's own eyes; nothing here is logged,
/// and error bodies (which may echo request fields) never leave
/// [ApiException.body] for the UI — the cubit reads only the stable 409
/// codes off it.
class ExtractedReviewRepositoryImpl implements ExtractedReviewRepository {
  const ExtractedReviewRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String get _token => _session.sessionToken ?? '';

  @override
  Future<ExtractedReview> load() async {
    try {
      final String? workerId = _session.workerId;
      if (workerId == null || workerId.isEmpty) {
        throw const UnauthorizedFailure();
      }
      String? profileId = _session.profileId;
      final List<Object?> reads = await Future.wait<Object?>([
        _api.getProfileSummary(authToken: _token),
        _api.getMyQualifications(authToken: _token),
        if (profileId == null || profileId.isEmpty)
          _api.getWorkerProfile(workerId: workerId, authToken: _token),
      ]);
      final ProfileSummaryDto summary = reads[0]! as ProfileSummaryDto;
      final MyQualificationsDto qualifications =
          reads[1]! as MyQualificationsDto;
      if (profileId == null || profileId.isEmpty) {
        final WorkerProfileBundle bundle = reads[2]! as WorkerProfileBundle;
        profileId = bundle.profileId;
        if (profileId != null && profileId.isNotEmpty) {
          _session.setProfile(profileId);
        }
      }
      return ExtractedReview(
        skills: summary.skills,
        machines: summary.machines,
        experienceYears: summary.experienceYears?.round(),
        educations: qualifications.educations,
        certificates: qualifications.certificates,
        profileId: (profileId == null || profileId.isEmpty) ? null : profileId,
        sessionId: _session.sessionId,
        // No lifetime-count read exists: the client learns the count from
        // each POST response (the 409 is the guarantee, the affordance a
        // courtesy — see [ExtractedReview.correctionCount]).
        correctionCount: 0,
      );
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<({int applied, int correctionCount})> submit(
    List<ExtractedCorrection> corrections,
  ) async {
    final String? profileId = _session.profileId;
    final String? sessionId = _session.sessionId;
    // Programmer-gated, not worker-gated: the cubit checks `canCorrect`
    // before calling, so a missing anchor here is a client bug, not a state
    // to render. Fail LOUD in dev, never POST anchor-less in prod.
    assert(
      profileId != null &&
          profileId.isNotEmpty &&
          sessionId != null &&
          sessionId.isNotEmpty,
      'submit() without a correction anchor — the cubit must gate on canCorrect',
    );
    if (profileId == null ||
        profileId.isEmpty ||
        sessionId == null ||
        sessionId.isEmpty) {
      throw const UnknownFailure();
    }
    try {
      final CorrectionsApplied applied = await _api.postProfileCorrections(
        authToken: _token,
        profileId: profileId,
        sessionId: sessionId,
        corrections: corrections,
      );
      return (
        applied: applied.correctionsApplied,
        correctionCount: applied.correctionCount,
      );
    } on ApiException {
      // Deliberately UNMAPPED: `mapError` would flatten the 409 into a
      // generic ServerFailure and destroy the stable reason codes the cubit
      // needs (`unpinned_road_deferred` / `correction_cap_reached` — see
      // [correctionRejectedOf]). Every other throw maps as usual.
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<QualificationOptionsDto> loadQualificationOptions() async {
    try {
      return await _api.getQualificationOptions(authToken: _token);
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<String?> confirm() async {
    try {
      final String? profileId = _session.profileId;
      if (profileId == null || profileId.isEmpty) {
        throw const UnauthorizedFailure();
      }
      return await _api.confirmProfile(
        authToken: _token,
        profileId: profileId,
      );
    } on Failure {
      rethrow;
    } catch (error) {
      throw mapError(error);
    }
  }
}
