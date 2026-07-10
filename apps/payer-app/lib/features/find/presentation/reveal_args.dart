import '../../../core/data/models.dart';

/// What the Reveal screen is opened with. A sum type over the two feeds:
///
///  - [RevealArgs.mock] — the MOCK rich candidate (real name + phone in the kit).
///  - [RevealArgs.real] — the REAL faceless applicant + the granted `unlockId`
///    (+ optional owning `jobId`). The real reveal shows only the in-app relay
///    handle + a MASKED résumé — never a fabricated name/phone (the backend
///    returns none).
class RevealArgs {
  const RevealArgs.mock(Candidate this.candidate)
      : applicant = null,
        unlockId = null,
        jobId = null;

  const RevealArgs.real({
    required Applicant this.applicant,
    required String this.unlockId,
    this.jobId,
  }) : candidate = null;

  final Candidate? candidate;
  final Applicant? applicant;
  final String? unlockId;
  final String? jobId;

  /// True for the REAL relay/masked reveal; false for the MOCK candidate reveal.
  bool get isReal => applicant != null;
}
