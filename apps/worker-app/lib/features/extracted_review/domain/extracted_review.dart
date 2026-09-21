import 'package:equatable/equatable.dart';

import '../../../core/api/api_models.dart'
    show
        CertificateEntryDto,
        EducationEntryDto,
        kMaxCorrectionsPerProfile;

/// The extracted profile under review (#1595): what the interview extraction
/// made of the worker's answers, read back from the stores that own each
/// fact — never a local cache, so a corrected value that survives here
/// survived on the server.
class ExtractedReview extends Equatable {
  const ExtractedReview({
    this.skills = const <String>[],
    this.machines = const <String>[],
    this.experienceYears,
    this.educations = const <EducationEntryDto>[],
    this.certificates = const <CertificateEntryDto>[],
    this.profileId,
    this.sessionId,
    this.correctionCount = 0,
  });

  /// Extracted skill labels, as printed. Labels only: the canonical ids a
  /// skills correction needs have no worker-facing read yet (see the
  /// catalogue note on `ExtractedCorrection`), so this section is
  /// review-only — shown, never an id-inventing affordance.
  final List<String> skills;

  /// Extracted machine labels — same review-only rule as [skills].
  final List<String> machines;

  /// Worker-stated total years, or null when extraction recorded none.
  final int? experienceYears;

  /// Stored education rows (full-list replace source for corrections).
  final List<EducationEntryDto> educations;

  /// Stored certificate rows (same full-list rule).
  final List<CertificateEntryDto> certificates;

  /// Anchor for POST /profile/corrections. Null profile/session means the
  /// worker has no correctable anchor (form-road, pre-interview) — the cubit
  /// shows that honestly and never POSTs.
  final String? profileId;
  final String? sessionId;

  /// Lifetime corrections used, when the server has reported it (every
  /// corrections response carries it). Null-unknown reads as 0 uses here:
  /// the SERVER enforces the cap either way; the client affordance is a
  /// courtesy, the 409 is the guarantee.
  final int correctionCount;

  /// True once the lifetime budget is spent — the cubit disables every
  /// correction affordance and says so.
  bool get capReached => correctionCount >= kMaxCorrectionsPerProfile;

  ExtractedReview copyWith({
    List<String>? skills,
    List<String>? machines,
    int? Function()? experienceYears,
    List<EducationEntryDto>? educations,
    List<CertificateEntryDto>? certificates,
    String? Function()? profileId,
    String? Function()? sessionId,
    int? correctionCount,
  }) {
    return ExtractedReview(
      skills: skills ?? this.skills,
      machines: machines ?? this.machines,
      experienceYears:
          experienceYears != null ? experienceYears() : this.experienceYears,
      educations: educations ?? this.educations,
      certificates: certificates ?? this.certificates,
      profileId: profileId != null ? profileId() : this.profileId,
      sessionId: sessionId != null ? sessionId() : this.sessionId,
      correctionCount: correctionCount ?? this.correctionCount,
    );
  }

  /// True when a correction POST has somewhere to go.
  bool get canCorrect =>
      profileId != null &&
      profileId!.isNotEmpty &&
      sessionId != null &&
      sessionId!.isNotEmpty &&
      !capReached;

  @override
  List<Object?> get props => <Object?>[
        skills,
        machines,
        experienceYears,
        educations,
        certificates,
        profileId,
        sessionId,
        correctionCount,
      ];
}
