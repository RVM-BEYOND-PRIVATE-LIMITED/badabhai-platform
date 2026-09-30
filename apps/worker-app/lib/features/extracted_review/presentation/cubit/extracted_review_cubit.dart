import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart'
    show
        ApiException,
        CatalogueOptionDto,
        CertificateEntryDto,
        CertificatesCorrection,
        CorrectionRejected,
        EducationCorrection,
        EducationEntryDto,
        ExperienceCorrection,
        ExtractedCorrection,
        MachinesCorrection,
        QualificationOptionsDto,
        SkillsCorrection,
        correctionRejectedOf,
        kMaxCorrectionMachines,
        kMaxCorrectionSkills,
        kMaxCorrectionsPerProfile;
import '../../../../core/error/failure.dart';
import '../../domain/extracted_review.dart';
import '../../domain/extracted_review_repository.dart';

enum ExtractedReviewStatus { loading, ready, failed }

/// Which section a send is in flight for — one correction POST at a time,
/// so a double-tap can never burn the lifetime cap twice.
enum ExtractedSection { skills, machines, experience, education, certificates }

/// Where a correction catalogue read (#1596) stands. `idle` = never asked:
/// the review has no correctable anchor, so there is nothing to pick into.
enum CatalogueStatus { idle, loading, ready, failed }

/// One id-list correction section — skills or machines (#1596): the
/// catalogue read, the ids the extracted labels pre-ticked, the worker's
/// current ticks, and the labels no option matched (a save drops them —
/// skills/machines corrections replace the whole list).
class CataloguePick extends Equatable {
  const CataloguePick({
    this.status = CatalogueStatus.idle,
    this.failure,
    this.options = const <CatalogueOptionDto>[],
    this.seededIds = const <String>[],
    this.selectedIds = const <String>[],
    this.unmatchedLabels = const <String>[],
  });

  /// A ready pick over [options], pre-ticked from the extracted [labels] by
  /// exact match ([matchCatalogueLabels]) — never a guessed id.
  factory CataloguePick.seeded(
    List<CatalogueOptionDto> options,
    List<String> labels,
  ) {
    final ({List<String> ids, List<String> unmatched}) match =
        matchCatalogueLabels(labels, options);
    return CataloguePick(
      status: CatalogueStatus.ready,
      options: options,
      seededIds: match.ids,
      selectedIds: match.ids,
      unmatchedLabels: match.unmatched,
    );
  }

  final CatalogueStatus status;

  /// The typed cause when [status] is `failed` — rendered via the app's
  /// Failure→reason map, never a generic line.
  final Failure? failure;
  final List<CatalogueOptionDto> options;

  /// Pre-ticked from the extracted labels (the "unchanged" baseline).
  final List<String> seededIds;

  /// The worker's ticks, in catalogue order — ids only ever come from
  /// [options].
  final List<String> selectedIds;

  /// Extracted labels with no single exact catalogue match.
  final List<String> unmatchedLabels;

  bool isSelected(String id) => selectedIds.contains(id);

  /// True only once the worker moved a tick — like every other card, an
  /// untouched section never offers a save. Unmatched labels alone do NOT
  /// make it dirty: the save is a full-list replace that would drop them
  /// (and burn a lifetime correction) on a tap that changed nothing.
  bool get dirty =>
      status == CatalogueStatus.ready && !_sameIds(selectedIds, seededIds);

  /// [id] flipped. An id outside [options] is ignored — never sent.
  CataloguePick toggled(String id) {
    if (!options.any((CatalogueOptionDto o) => o.id == id)) return this;
    final Set<String> next = selectedIds.toSet();
    if (!next.remove(id)) next.add(id);
    return CataloguePick(
      status: status,
      failure: failure,
      options: options,
      seededIds: seededIds,
      selectedIds: List<String>.unmodifiable(<String>[
        for (final CatalogueOptionDto o in options)
          if (next.contains(o.id)) o.id,
      ]),
      unmatchedLabels: unmatchedLabels,
    );
  }

  static bool _sameIds(List<String> a, List<String> b) =>
      a.length == b.length && a.toSet().containsAll(b);

  @override
  List<Object?> get props => <Object?>[
        status,
        failure,
        options,
        seededIds,
        selectedIds,
        unmatchedLabels,
      ];
}

/// Credential years the correction editors accept (the trade form's UI rule:
/// no future year, nothing before 1950 — the server's own `credentialYear`
/// check is the backstop, this keeps a worker from waiting on a 400).
const int kCorrectionYearMin = 1950;

int _currentYear() => DateTime.now().year;

class ExtractedReviewState extends Equatable {
  const ExtractedReviewState({
    this.status = ExtractedReviewStatus.loading,
    this.failure,
    this.review,
    this.expYears,
    this.eduRows = const <EducationEntryDto>[],
    this.certRows = const <CertificateEntryDto>[],
    this.options,
    this.validationError,
    this.sendingSection,
    this.lastSent,
    this.rejected = CorrectionRejected.other,
    this.deferralMessage,
    this.confirming = false,
    this.confirmed = false,
    this.confirmNext,
    this.skillPick = const CataloguePick(),
    this.machinePick = const CataloguePick(),
  });

  final ExtractedReviewStatus status;
  final Failure? failure;
  final ExtractedReview? review;

  /// Experience draft (years). Null = untouched since load.
  final int? expYears;

  /// Education / certificate drafts, seeded from the server rows on load.
  final List<EducationEntryDto> eduRows;
  final List<CertificateEntryDto> certRows;

  /// Credential/council slug→label maps for the education add-form.
  final QualificationOptionsDto? options;

  /// Client-side validation message — shown inline, never POSTed past.
  final String? validationError;

  final ExtractedSection? sendingSection;

  /// The last accepted batch, for the confirmation line.
  final ({String field, int applied})? lastSent;

  /// The stable 409 reason of the last rejected POST (`other` = none).
  /// `capReached` disables every affordance; `unpinnedRoadDeferred` shows
  /// the deferral banner (surfaced, never retried).
  final CorrectionRejected rejected;
  final String? deferralMessage;

  final bool confirming;
  final bool confirmed;
  final String? confirmNext;

  /// Skills / machines pickers (#1596).
  final CataloguePick skillPick;
  final CataloguePick machinePick;

  /// No anchor (form-road / pre-interview) or budget spent: saves disabled.
  bool get correctionsLocked =>
      review == null || !review!.canCorrect || rejected == CorrectionRejected.capReached;

  bool get skillsDirty => review != null && skillPick.dirty;
  bool get machinesDirty => review != null && machinePick.dirty;

  bool get expDirty =>
      review != null && expYears != null && expYears != review!.experienceYears;
  bool get eduDirty =>
      review != null && !_eduEquals(eduRows, review!.educations);
  bool get certDirty =>
      review != null && !_certEquals(certRows, review!.certificates);

  static bool _eduEquals(List<EducationEntryDto> a, List<EducationEntryDto> b) {
    if (a.length != b.length) return false;
    for (int i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  static bool _certEquals(
      List<CertificateEntryDto> a, List<CertificateEntryDto> b) {
    if (a.length != b.length) return false;
    for (int i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }

  ExtractedReviewState copyWith({
    ExtractedReviewStatus? status,
    Failure? Function()? failure,
    ExtractedReview? Function()? review,
    int? Function()? expYears,
    List<EducationEntryDto>? eduRows,
    List<CertificateEntryDto>? certRows,
    QualificationOptionsDto? Function()? options,
    String? Function()? validationError,
    ExtractedSection? Function()? sendingSection,
    ({String field, int applied})? Function()? lastSent,
    CorrectionRejected? rejected,
    String? Function()? deferralMessage,
    bool? confirming,
    bool? confirmed,
    String? Function()? confirmNext,
    CataloguePick? skillPick,
    CataloguePick? machinePick,
  }) {
    return ExtractedReviewState(
      status: status ?? this.status,
      failure: failure != null ? failure() : this.failure,
      review: review != null ? review() : this.review,
      expYears: expYears != null ? expYears() : this.expYears,
      eduRows: eduRows ?? this.eduRows,
      certRows: certRows ?? this.certRows,
      options: options != null ? options() : this.options,
      validationError:
          validationError != null ? validationError() : this.validationError,
      sendingSection:
          sendingSection != null ? sendingSection() : this.sendingSection,
      lastSent: lastSent != null ? lastSent() : this.lastSent,
      rejected: rejected ?? this.rejected,
      deferralMessage:
          deferralMessage != null ? deferralMessage() : this.deferralMessage,
      confirming: confirming ?? this.confirming,
      confirmed: confirmed ?? this.confirmed,
      confirmNext: confirmNext != null ? confirmNext() : this.confirmNext,
      skillPick: skillPick ?? this.skillPick,
      machinePick: machinePick ?? this.machinePick,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        failure,
        review,
        expYears,
        eduRows,
        certRows,
        options,
        validationError,
        sendingSection,
        lastSent,
        rejected,
        deferralMessage,
        confirming,
        confirmed,
        confirmNext,
        skillPick,
        machinePick,
      ];
}

/// Review-then-correct for the extracted profile (#1595, §8.4).
///
/// Posture: validate client-side (never burn the lifetime cap or the
/// worker's wait on a 400 for a client bug), send one section per POST
/// (unique-field rule + per-section confirmation), re-read after every
/// accepted batch (corrected values survive only if the server says so),
/// and surface 409s honestly — deferral shown, never retried; cap
/// disables, never spins.
class ExtractedReviewCubit extends Cubit<ExtractedReviewState> {
  ExtractedReviewCubit(this._repo) : super(const ExtractedReviewState());

  final ExtractedReviewRepository _repo;
  bool _loading = false;

  /// Lifetime corrections the client has SEEN (responses + cap 409s). The
  /// load read carries no count, so reloads would otherwise forget it —
  /// the server enforces the cap regardless; this keeps the affordance
  /// honest between reloads.
  int _knownCorrectionCount = 0;

  Future<void> load() async {
    if (_loading) return;
    _loading = true;
    emit(state.copyWith(
      status: ExtractedReviewStatus.loading,
      failure: () => null,
      validationError: () => null,
    ));
    try {
      final ExtractedReview review = await _repo.load();
      if (isClosed) return;
      final ExtractedReview withCount = review.copyWith(
        correctionCount: review.correctionCount > _knownCorrectionCount
            ? review.correctionCount
            : _knownCorrectionCount,
      );
      // The correction catalogues (#1596) load alongside the qualification
      // maps. Static vocabulary, so fetched once and then only RE-SEEDED from
      // each re-read — after a save the ticks re-derive from what the server
      // now stores. A catalogue miss fails its own card, never the review.
      final Future<List<CataloguePick>> picks =
          Future.wait<CataloguePick>(<Future<CataloguePick>>[
        _pickFor(state.skillPick, withCount.skills, withCount,
            _repo.loadSkillOptions),
        _pickFor(state.machinePick, withCount.machines, withCount,
            _repo.loadMachineOptions),
      ]);
      QualificationOptionsDto? options;
      try {
        options = await _repo.loadQualificationOptions();
      } catch (_) {
        // Optional garnish: without the slug maps the add-form falls back
        // to the stored slugs. Never costs the review underneath.
        options = null;
      }
      final List<CataloguePick> seeded = await picks;
      if (isClosed) return;
      emit(state.copyWith(
        status: ExtractedReviewStatus.ready,
        review: () => withCount,
        expYears: () => withCount.experienceYears,
        eduRows: List<EducationEntryDto>.unmodifiable(withCount.educations),
        certRows:
            List<CertificateEntryDto>.unmodifiable(withCount.certificates),
        options: () => options,
        lastSent: () => null,
        skillPick: seeded[0],
        machinePick: seeded[1],
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(state.copyWith(
        status: ExtractedReviewStatus.failed,
        failure: () => f,
      ));
    } finally {
      _loading = false;
    }
  }

  /// One catalogue's pick for a (re-)read [review]: a loaded catalogue is
  /// only re-seeded; a locked review asks for nothing (`idle`); otherwise
  /// [fetch] runs and a miss becomes `failed` with its typed cause. Never
  /// throws — the review underneath must survive a catalogue miss.
  Future<CataloguePick> _pickFor(
    CataloguePick current,
    List<String> labels,
    ExtractedReview review,
    Future<List<CatalogueOptionDto>> Function() fetch,
  ) async {
    if (current.status == CatalogueStatus.ready) {
      return CataloguePick.seeded(current.options, labels);
    }
    if (!review.canCorrect) return const CataloguePick();
    try {
      return CataloguePick.seeded(await fetch(), labels);
    } on Failure catch (f) {
      return CataloguePick(status: CatalogueStatus.failed, failure: f);
    } catch (_) {
      return const CataloguePick(
        status: CatalogueStatus.failed,
        failure: UnknownFailure(),
      );
    }
  }

  /// The catalogue card's retry: re-fetches whichever catalogue failed,
  /// showing that card's own loader. The rest of the review is untouched.
  Future<void> retryCatalogues() async {
    final ExtractedReview? review = state.review;
    if (review == null) return;
    final bool skills = state.skillPick.status == CatalogueStatus.failed;
    final bool machines = state.machinePick.status == CatalogueStatus.failed;
    if (!skills && !machines) return;
    const CataloguePick loading = CataloguePick(status: CatalogueStatus.loading);
    emit(state.copyWith(
      skillPick: skills ? loading : null,
      machinePick: machines ? loading : null,
    ));
    final List<CataloguePick> picks =
        await Future.wait<CataloguePick>(<Future<CataloguePick>>[
      if (skills)
        _pickFor(const CataloguePick(), review.skills, review,
            _repo.loadSkillOptions)
      else
        Future<CataloguePick>.value(state.skillPick),
      if (machines)
        _pickFor(const CataloguePick(), review.machines, review,
            _repo.loadMachineOptions)
      else
        Future<CataloguePick>.value(state.machinePick),
    ]);
    if (isClosed) return;
    emit(state.copyWith(
      skillPick: skills ? picks[0] : null,
      machinePick: machines ? picks[1] : null,
    ));
  }

  // ---- drafts ----

  /// Ticks/unticks one catalogue skill. Refuses a tick past the server cap
  /// with the reason, instead of letting a save 400.
  void toggleSkill(String skillId) {
    final CataloguePick pick = state.skillPick;
    if (!pick.isSelected(skillId) &&
        pick.selectedIds.length >= kMaxCorrectionSkills) {
      emit(state.copyWith(validationError: () => _skillsCapMessage));
      return;
    }
    emit(state.copyWith(
      skillPick: pick.toggled(skillId),
      validationError: () => null,
      lastSent: () => null,
    ));
  }

  /// Same as [toggleSkill], for machines.
  void toggleMachine(String machineId) {
    final CataloguePick pick = state.machinePick;
    if (!pick.isSelected(machineId) &&
        pick.selectedIds.length >= kMaxCorrectionMachines) {
      emit(state.copyWith(validationError: () => _machinesCapMessage));
      return;
    }
    emit(state.copyWith(
      machinePick: pick.toggled(machineId),
      validationError: () => null,
      lastSent: () => null,
    ));
  }

  static const String _skillsCapMessage =
      'Zyada se zyada $kMaxCorrectionSkills hunar chun sakte hain.';
  static const String _machinesCapMessage =
      'Zyada se zyada $kMaxCorrectionMachines machine chun sakte hain.';

  void setExperience(int? years) {
    emit(state.copyWith(
      expYears: () => years,
      validationError: () => null,
      lastSent: () => null,
    ));
  }

  void setEducationRows(List<EducationEntryDto> rows) {
    emit(state.copyWith(
      eduRows: List<EducationEntryDto>.unmodifiable(rows),
      validationError: () => null,
      lastSent: () => null,
    ));
  }

  void setCertificateRows(List<CertificateEntryDto> rows) {
    emit(state.copyWith(
      certRows: List<CertificateEntryDto>.unmodifiable(rows),
      validationError: () => null,
      lastSent: () => null,
    ));
  }

  // ---- submits ----

  /// The ticked skills as ONE full-list correction (replace semantics —
  /// unmatched extracted labels are dropped, which the card says up front).
  Future<void> submitSkills() async {
    final CataloguePick pick = state.skillPick;
    final String? error = _pickError(
      pick,
      max: kMaxCorrectionSkills,
      notReady: 'Hunar ki list abhi load nahi hui.',
      empty: 'Kam se kam ek hunar chunein — khaali list nahi bheji ja sakti.',
      overCap: _skillsCapMessage,
    );
    if (error != null) {
      emit(state.copyWith(validationError: () => error));
      return;
    }
    await _submit(
      ExtractedSection.skills,
      'skills',
      <ExtractedCorrection>[SkillsCorrection(pick.selectedIds)],
    );
  }

  /// Same as [submitSkills], for machines.
  Future<void> submitMachines() async {
    final CataloguePick pick = state.machinePick;
    final String? error = _pickError(
      pick,
      max: kMaxCorrectionMachines,
      notReady: 'Machine ki list abhi load nahi hui.',
      empty:
          'Kam se kam ek machine chunein — khaali list nahi bheji ja sakti.',
      overCap: _machinesCapMessage,
    );
    if (error != null) {
      emit(state.copyWith(validationError: () => error));
      return;
    }
    await _submit(
      ExtractedSection.machines,
      'machines',
      <ExtractedCorrection>[MachinesCorrection(pick.selectedIds)],
    );
  }

  /// Client mirror of the id-list DTO (`min(1).max(cap)`): never burn the
  /// lifetime cap or the worker's wait on a 400 we can see coming.
  static String? _pickError(
    CataloguePick pick, {
    required int max,
    required String notReady,
    required String empty,
    required String overCap,
  }) {
    if (pick.status != CatalogueStatus.ready) return notReady;
    if (pick.selectedIds.isEmpty) return empty;
    if (pick.selectedIds.length > max) return overCap;
    return null;
  }

  Future<void> submitExperience() async {
    final int? years = state.expYears;
    if (years == null || years < 0 || years > 60) {
      emit(state.copyWith(
          validationError: () =>
              'Sahi saal likhein — 0 se 60 ke beech.'));
      return;
    }
    await _submit(
      ExtractedSection.experience,
      'experience',
      <ExtractedCorrection>[ExperienceCorrection(years)],
    );
  }

  Future<void> submitEducation() async {
    final List<EducationEntryDto> rows =
        state.eduRows.where((e) => !_eduBlank(e)).toList();
    if (rows.isEmpty) {
      emit(state.copyWith(
          validationError: () =>
              'Kam se kam ek taleem likhein — khaali list nahi bheji ja sakti.'));
      return;
    }
    for (final EducationEntryDto e in rows) {
      final String? yearError = _yearError(e.year);
      if (yearError != null) {
        emit(state.copyWith(validationError: () => yearError));
        return;
      }
    }
    await _submit(
      ExtractedSection.education,
      'education',
      <ExtractedCorrection>[EducationCorrection(rows)],
    );
  }

  Future<void> submitCertificates() async {
    final List<CertificateEntryDto> rows =
        state.certRows.where((c) => !_certBlank(c)).toList();
    if (rows.isEmpty) {
      emit(state.copyWith(
          validationError: () =>
              'Kam se kam ek certificate likhein — khaali list nahi bheji ja sakti.'));
      return;
    }
    for (final CertificateEntryDto c in rows) {
      if (c.name.trim().isEmpty) {
        emit(state.copyWith(
            validationError: () => 'Har certificate ka naam likhein.'));
        return;
      }
      if ((c.issuer ?? '').trim().isEmpty) {
        emit(state.copyWith(
            validationError: () => 'Kisne diya — har certificate ke liye likhein.'));
        return;
      }
      final String? yearError = _yearError(c.year);
      if (yearError != null) {
        emit(state.copyWith(validationError: () => yearError));
        return;
      }
    }
    await _submit(
      ExtractedSection.certificates,
      'certificates',
      <ExtractedCorrection>[CertificatesCorrection(rows)],
    );
  }

  Future<void> confirm() async {
    if (state.confirming || state.confirmed) return;
    emit(state.copyWith(confirming: true));
    try {
      final String? next = await _repo.confirm();
      if (isClosed) return;
      emit(state.copyWith(confirming: false, confirmed: true, confirmNext: () => next));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(state.copyWith(
        confirming: false,
        failure: () => f,
        status: ExtractedReviewStatus.failed,
      ));
    }
  }

  Future<void> _submit(
    ExtractedSection section,
    String field,
    List<ExtractedCorrection> corrections,
  ) async {
    if (state.sendingSection != null) return;
    if (state.correctionsLocked) {
      // Unreachable from the UI (locked disables every save), but a locked
      // cubit must still answer honestly: cap and no-anchor are different
      // facts and must never share a message.
      final ExtractedReview? review = state.review;
      final bool capped = (review?.correctionCount ?? 0) >=
              kMaxCorrectionsPerProfile ||
          state.rejected == CorrectionRejected.capReached;
      if (capped) {
        emit(state.copyWith(
          rejected: CorrectionRejected.capReached,
          deferralMessage: () =>
              'Sudhaar ki seema poori ho gayi (20). Naye sudhaar band hain.',
        ));
      } else {
        emit(state.copyWith(
          validationError: () =>
              'Interview record nahi mila — sudhaar ke liye poora interview hona chahiye.',
        ));
      }
      return;
    }
    emit(state.copyWith(
      sendingSection: () => section,
      validationError: () => null,
      lastSent: () => null,
      rejected: CorrectionRejected.other,
      deferralMessage: () => null,
    ));
    try {
      final ({int applied, int correctionCount}) result =
          await _repo.submit(corrections);
      if (isClosed) return;
      if (result.correctionCount > _knownCorrectionCount) {
        _knownCorrectionCount = result.correctionCount;
      }
      emit(state.copyWith(
        sendingSection: () => null,
        lastSent: () => (field: field, applied: result.applied),
      ));
      // Re-read from the server: corrected values survive a reload only if
      // the stores say so — never trust the POST echo (there is none; the
      // response carries counts, never values). The reload clears the
      // confirmation, so it is restored after — the worker must see WHAT
      // landed, on top of the re-read values.
      await load();
      if (isClosed) return;
      emit(state.copyWith(
        lastSent: () => (field: field, applied: result.applied),
      ));
    } on ApiException catch (e) {
      if (isClosed) return;
      final CorrectionRejected rejected = correctionRejectedOf(e);
      if (rejected == CorrectionRejected.capReached &&
          _knownCorrectionCount < kMaxCorrectionsPerProfile) {
        _knownCorrectionCount = kMaxCorrectionsPerProfile;
      }
      emit(state.copyWith(
        sendingSection: () => null,
        rejected: rejected,
        deferralMessage: () => _rejectedMessage(rejected),
      ));
      if (rejected == CorrectionRejected.capReached) {
        await load();
      }
    } on Failure catch (f) {
      if (isClosed) return;
      emit(state.copyWith(
        sendingSection: () => null,
        failure: () => f,
        status: ExtractedReviewStatus.failed,
      ));
    }
  }

  static String _rejectedMessage(CorrectionRejected rejected) {
    switch (rejected) {
      case CorrectionRejected.unpinnedRoadDeferred:
        // Stable server reason, worker words: no retry loop — the session
        // has no durable pin (in-progress, abandoned, form-road).
        return 'Yeh interview abhi poora nahi hua, isliye sudhaar abhi nahi ho sakta. Interview poora karke dobara koshish karein.';
      case CorrectionRejected.capReached:
        return 'Sudhaar ki seema poori ho gayi (20). Naye sudhaar band hain.';
      case CorrectionRejected.other:
        return 'Sudhaar nahi ho paya. Thodi der baad koshish karein.';
    }
  }

  static bool _eduBlank(EducationEntryDto e) =>
      (e.credential ?? '').trim().isEmpty &&
      (e.field ?? '').trim().isEmpty &&
      (e.council ?? '').trim().isEmpty &&
      (e.institute ?? '').trim().isEmpty &&
      e.year == null;

  static bool _certBlank(CertificateEntryDto c) =>
      c.name.trim().isEmpty &&
      (c.issuer ?? '').trim().isEmpty &&
      c.year == null &&
      (c.licenceNumber ?? '').trim().isEmpty &&
      (c.licenceExpiry ?? '').trim().isEmpty;

  static String? _yearError(int? year) {
    if (year == null) return null;
    if (year < kCorrectionYearMin || year > _currentYear()) {
      return 'Sahi saal likhein — $kCorrectionYearMin se ${_currentYear()} ke beech.';
    }
    return null;
  }
}
