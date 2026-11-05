import '../../../core/data/models.dart';

/// What the Reveal screen is opened with. A sum type over the feeds:
///
///  - [RevealArgs.mock] — the MOCK rich candidate (real name + phone in the kit).
///  - [RevealArgs.real] — the REAL faceless per-job applicant + the granted
///    `unlockId` (+ optional owning `jobId`).
///  - [RevealArgs.relay] — the REAL faceless ALL-CANDIDATES row + its granted
///    `unlockId`. No [Applicant] and no job: a search unlock has no posting
///    context, so the masked résumé goes out with no posting id.
///
/// Both real shapes render the SAME reveal: the in-app relay handle + a MASKED
/// résumé, read through [workerId] / [title] / [facets] — never a fabricated
/// name/phone (the backend returns none).
class RevealArgs {
  const RevealArgs.mock(Candidate this.candidate, {this.justUnlocked = false})
      : applicant = null,
        unlockId = null,
        jobId = null,
        _workerId = null,
        _title = null,
        _facets = const <String>[];

  const RevealArgs.real({
    required Applicant this.applicant,
    required String this.unlockId,
    this.jobId,
    this.justUnlocked = false,
  })  : candidate = null,
        _workerId = null,
        _title = null,
        _facets = const <String>[];

  /// The all-candidates card's reveal. [title] is the masked handle the card
  /// and the unlock dialog showed ("Worker ••3f9a"); [facets] the coarse
  /// non-identifying lines (role · years · city).
  const RevealArgs.relay({
    required String workerId,
    required String this.unlockId,
    required String title,
    List<String> facets = const <String>[],
    this.justUnlocked = false,
  })  : candidate = null,
        applicant = null,
        jobId = null,
        _workerId = workerId,
        _title = title,
        _facets = facets;

  final Candidate? candidate;

  /// The per-job applicant that opened the reveal; null on the mock and the
  /// all-candidates paths. Read [workerId] / [title] / [facets] instead.
  final Applicant? applicant;
  final String? unlockId;

  /// The owning job/posting, or null (always null for a search row).
  final String? jobId;

  /// True ONLY when the unlock that granted this reveal has just happened —
  /// the reveal then plays its one-shot success stamp (#2596). A "View" of an
  /// earlier unlock leaves it false, so the stamp never replays for it.
  final bool justUnlocked;

  final String? _workerId;
  final String? _title;
  final List<String> _facets;

  /// True for a REAL relay/masked reveal; false for the MOCK candidate reveal.
  bool get isReal => candidate == null;

  /// The opaque worker id the masked résumé is requested for.
  String get workerId => applicant?.workerId ?? _workerId ?? '';

  /// The masked handle shown big on the reveal ("Worker ••3f9a").
  String get title => applicant?.maskedLabel ?? _title ?? '';

  /// Coarse facets under the title — trade · experience · city for an applicant
  /// (unknown ones dropped), the card's own lines for a search row.
  List<String> get facets {
    final Applicant? a = applicant;
    if (a == null) return _facets;
    return <String>[
      if ((a.tradeLabel ?? '').isNotEmpty) a.tradeLabel!,
      if ((a.experienceBand ?? '').isNotEmpty) a.experienceBand!,
      if ((a.cityLabel ?? '').isNotEmpty) a.cityLabel!,
    ];
  }
}
