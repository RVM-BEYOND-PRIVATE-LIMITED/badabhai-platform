import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_client.dart'
    show
        CertificateEntryDto,
        EducationEntryDto,
        LanguageAbilityDto,
        MyLanguagesDto,
        MyOccupationsDto,
        MyPortfolioDto,
        MyQualificationsDto,
        MyWhatsappDto,
        PortfolioItemDto,
        TrainingEntryDto,
        WorkAvailabilityDto,
        WorkPrefOptionsDto,
        WorkPreferencesDto;
import '../../../../core/error/failure.dart';
import '../../domain/profile_edit_models.dart';
import '../../domain/profile_edit_repository.dart';

enum ProfileEditStatus { loading, ready, failed }

/// The independently-saveable sections of the Layer A edit surface.
enum ProfileEditSection {
  whatsapp,
  languages,
  attributes,
  qualifications,
  portfolio,
  occupations,
}

class ProfileEditState extends Equatable {
  const ProfileEditState({
    this.status = ProfileEditStatus.loading,
    this.failure,
    this.whatsapp,
    this.languages = const <LanguageAbilityDto>[],
    this.languageLabels = const <String, String>{},
    this.occupations = const <String>[],
    this.occupationLabels = const <String, String>{},
    this.certificates = const <CertificateEntryDto>[],
    this.educations = const <EducationEntryDto>[],
    this.trainings = const <TrainingEntryDto>[],
    this.portfolio = const <PortfolioItemDto>[],
    this.mediaUploadsDormant = false,
    this.pendingUploads = const <PendingPortfolioUpload>[],
    this.options,
    this.workTypes = const <String>{},
    this.salaryPeriod,
    this.commuteMaxKm,
    this.willingToTravel = false,
    this.availability = const AvailabilityDraft(),
    this.saving = const <ProfileEditSection>{},
    this.error,
    this.notice,
  });

  final ProfileEditStatus status;

  /// The typed cause when [status] is `failed`.
  final Failure? failure;

  /// The stored number, or null when none is on file. PII — never logged.
  final String? whatsapp;

  final List<LanguageAbilityDto> languages;

  /// slug → English label from the shared preferences vocabulary; the picker
  /// renders chips from THIS, never a hard-coded copy.
  final Map<String, String> languageLabels;

  /// The worker's selected secondary `role_*` ids.
  final List<String> occupations;

  /// role id → server-resolved label (saved rows only).
  final Map<String, String> occupationLabels;

  final List<CertificateEntryDto> certificates;
  final List<EducationEntryDto> educations;
  final List<TrainingEntryDto> trainings;
  final List<PortfolioItemDto> portfolio;

  /// True once a mint answered 503: the media bucket is dormant, so photo/video
  /// upload is honestly unavailable while links keep working (#1578). Latched
  /// from the mint response only — never from a timeout or a guess.
  final bool mediaUploadsDormant;

  /// Uploads the worker started but that have not landed yet (#1578).
  final List<PendingPortfolioUpload> pendingUploads;

  final WorkPrefOptionsDto? options;

  // Extended work preferences (Layer A (c)).
  final Set<String> workTypes;
  final String? salaryPeriod;
  final int? commuteMaxKm;
  final bool willingToTravel;
  final AvailabilityDraft availability;

  /// Sections with an in-flight save — the UI disables only that section's
  /// button, so a slow portfolio upload never blocks a WhatsApp edit.
  final Set<ProfileEditSection> saving;

  /// The last FAILED save's reason (shown inline), and the last success notice.
  final String? error;
  final String? notice;

  bool get isReady => status == ProfileEditStatus.ready;

  /// The "Kab se available" chips (#1541): the server's own
  /// `availability_status` dictionary when it serves one — the set the PUT
  /// validates against — else the static copy that uses the same slugs.
  Map<String, String> get availabilityStatusOptions {
    final Map<String, String>? served = options?.availabilityStatus;
    return (served == null || served.isEmpty) ? kAvailabilityStatuses : served;
  }

  ProfileEditState copyWith({
    ProfileEditStatus? status,
    Failure? failure,
    Object? whatsapp = _sentinel,
    List<LanguageAbilityDto>? languages,
    Map<String, String>? languageLabels,
    List<String>? occupations,
    Map<String, String>? occupationLabels,
    List<CertificateEntryDto>? certificates,
    List<EducationEntryDto>? educations,
    List<TrainingEntryDto>? trainings,
    List<PortfolioItemDto>? portfolio,
    bool? mediaUploadsDormant,
    List<PendingPortfolioUpload>? pendingUploads,
    Object? options = _sentinel,
    Set<String>? workTypes,
    Object? salaryPeriod = _sentinel,
    Object? commuteMaxKm = _sentinel,
    bool? willingToTravel,
    AvailabilityDraft? availability,
    Set<ProfileEditSection>? saving,
    Object? error = _sentinel,
    Object? notice = _sentinel,
  }) {
    return ProfileEditState(
      status: status ?? this.status,
      failure: failure ?? this.failure,
      whatsapp: whatsapp == _sentinel ? this.whatsapp : whatsapp as String?,
      languages: languages ?? this.languages,
      languageLabels: languageLabels ?? this.languageLabels,
      occupations: occupations ?? this.occupations,
      occupationLabels: occupationLabels ?? this.occupationLabels,
      certificates: certificates ?? this.certificates,
      educations: educations ?? this.educations,
      trainings: trainings ?? this.trainings,
      portfolio: portfolio ?? this.portfolio,
      mediaUploadsDormant: mediaUploadsDormant ?? this.mediaUploadsDormant,
      pendingUploads: pendingUploads ?? this.pendingUploads,
      options: options == _sentinel ? this.options : options as WorkPrefOptionsDto?,
      workTypes: workTypes ?? this.workTypes,
      salaryPeriod:
          salaryPeriod == _sentinel ? this.salaryPeriod : salaryPeriod as String?,
      commuteMaxKm:
          commuteMaxKm == _sentinel ? this.commuteMaxKm : commuteMaxKm as int?,
      willingToTravel: willingToTravel ?? this.willingToTravel,
      availability: availability ?? this.availability,
      saving: saving ?? this.saving,
      error: error == _sentinel ? this.error : error as String?,
      notice: notice == _sentinel ? this.notice : notice as String?,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        failure,
        whatsapp,
        languages,
        languageLabels,
        occupations,
        occupationLabels,
        certificates,
        educations,
        trainings,
        portfolio,
        mediaUploadsDormant,
        pendingUploads,
        options,
        workTypes,
        salaryPeriod,
        commuteMaxKm,
        willingToTravel,
        availability,
        saving,
        error,
        notice,
      ];
}

/// Loads every Layer A surface and owns each section's save.
///
/// DELIBERATELY ONE CUBIT, MANY SAVES: each surface is its own PUT endpoint, so
/// a failure or a slow upload in one must not block or roll back another. The
/// [saving] set lets the UI disable only the section in flight.
class ProfileEditCubit extends Cubit<ProfileEditState> {
  ProfileEditCubit(this._repo) : super(const ProfileEditState());

  final ProfileEditRepository _repo;

  bool _loading = false;

  /// The stored legacy single `job_type` while the card shows its chip ticked
  /// (#1541) — as the fallback prefill, or inside the saved multi — else null.
  /// Kept so un-ticking down to none can actually withdraw it on save.
  String? _shownJobType;

  Future<void> load() async {
    if (_loading) return;
    _loading = true;
    _shownJobType = null;
    emit(const ProfileEditState(status: ProfileEditStatus.loading));
    try {
      // One round of parallel reads; every surface is independent but the
      // screen is one page, so a failure anywhere fails the load closed with a
      // retry rather than rendering a half-parsed profile.
      final List<Object?> results = await Future.wait<Object?>(<Future<Object?>>[
        _repo.loadWhatsapp(),
        _repo.loadLanguages(),
        _repo.loadOccupations(),
        _repo.loadQualifications(),
        _repo.loadPortfolio(),
        _repo.loadWorkPreferenceOptions(),
        // #1541 — the extended fields' PREFILL. It fails the load closed like
        // every other read: a card that opened blank is exactly what let a
        // save overwrite a saved part with an empty default.
        _repo.loadWorkPreferences(),
      ]);
      if (isClosed) return;
      final MyWhatsappDto whatsapp = results[0]! as MyWhatsappDto;
      final MyLanguagesDto languages = results[1]! as MyLanguagesDto;
      final MyOccupationsDto occupations = results[2]! as MyOccupationsDto;
      final MyQualificationsDto qualifications = results[3]! as MyQualificationsDto;
      final MyPortfolioDto portfolio = results[4]! as MyPortfolioDto;
      final WorkPrefOptionsDto options = results[5]! as WorkPrefOptionsDto;
      final WorkPreferencesDto prefs = results[6]! as WorkPreferencesDto;
      final Set<String> workTypes = _storedWorkTypes(prefs);
      final String? jobType = prefs.jobType;
      _shownJobType =
          (jobType != null && workTypes.contains(jobType)) ? jobType : null;
      emit(
        ProfileEditState(
          status: ProfileEditStatus.ready,
          whatsapp: whatsapp.whatsapp,
          languages: languages.languages,
          languageLabels: options.languages,
          occupations: occupations.occupations
              .map((o) => o.roleId)
              .toList(growable: false),
          occupationLabels: <String, String>{
            for (final o in occupations.occupations) o.roleId: o.label,
          },
          certificates: qualifications.certificates,
          educations: qualifications.educations,
          trainings: qualifications.trainings,
          portfolio: portfolio.items,
          options: options,
          workTypes: workTypes,
          salaryPeriod: prefs.salaryPeriod,
          commuteMaxKm: prefs.commuteKm,
          willingToTravel: prefs.willingToTravel ?? false,
          availability: _storedAvailability(prefs.availability),
        ),
      );
      // The dormancy probe runs AFTER the ready emit on purpose: the page must
      // paint immediately, and the probe only refines the media-upload section
      // when it answers. It never fails the load.
      await _probeMediaUploads();
      if (isClosed) return;
    } on Failure catch (f) {
      if (isClosed) return;
      emit(ProfileEditState(status: ProfileEditStatus.failed, failure: f));
    } catch (_) {
      if (isClosed) return;
      emit(const ProfileEditState(status: ProfileEditStatus.failed));
    } finally {
      _loading = false;
    }
  }

  // ---- Draft mutations (screen-bound) --------------------------------------

  void toggleWorkType(String slug) {
    final Set<String> next = <String>{...state.workTypes};
    next.contains(slug) ? next.remove(slug) : next.add(slug);
    emit(state.copyWith(workTypes: next, notice: null, error: null));
  }

  void setSalaryPeriod(String? slug) =>
      emit(state.copyWith(salaryPeriod: slug, error: null, notice: null));

  void setCommuteMaxKm(int? km) =>
      emit(state.copyWith(commuteMaxKm: km, error: null, notice: null));

  void setWillingToTravel(bool value) =>
      emit(state.copyWith(willingToTravel: value, error: null, notice: null));

  void setAvailability(AvailabilityDraft draft) =>
      emit(state.copyWith(availability: draft, error: null, notice: null));

  void toggleOccupation(String roleId) {
    final List<String> next = <String>[...state.occupations];
    if (next.contains(roleId)) {
      next.remove(roleId);
    } else if (next.length < kMaxSecondaryOccupations) {
      next.add(roleId);
    }
    emit(state.copyWith(occupations: next, error: null, notice: null));
  }

  // ---- Saves ---------------------------------------------------------------

  Future<void> saveWhatsapp(String? whatsapp) async {
    final String? normalised =
        (whatsapp == null || whatsapp.trim().isEmpty) ? null : whatsapp.trim();
    await _save(
      ProfileEditSection.whatsapp,
      () => _repo.saveWhatsapp(normalised),
      onSuccess: () => state.copyWith(
        whatsapp: normalised,
        notice: normalised == null ? 'WhatsApp number hata diya.' : 'WhatsApp number save ho gaya.',
      ),
    );
  }

  Future<void> saveLanguages(List<LanguageAbilityDto> languages) async {
    await _save(
      ProfileEditSection.languages,
      () => _repo.saveLanguages(languages),
      onSuccess: () =>
          state.copyWith(languages: languages, notice: 'Bhashayein save ho gayi.'),
    );
  }

  Future<void> saveOccupations(List<String> roleIds) async {
    await _save(
      ProfileEditSection.occupations,
      () => _repo.saveOccupations(roleIds),
      onSuccess: () => state.copyWith(
        occupations: roleIds,
        notice: 'Kaam save ho gaye.',
      ),
    );
  }

  Future<void> saveQualifications(Map<String, dynamic> fields) async {
    await _save(
      ProfileEditSection.qualifications,
      () => _repo.saveQualifications(fields),
      onSuccess: () => state.copyWith(notice: 'Training aur licence save ho gaye.'),
    );
  }

  Future<void> savePortfolio(List<PortfolioItemDto> items) async {
    await _save(
      ProfileEditSection.portfolio,
      () => _repo.savePortfolio(items),
      onSuccess: () => state.copyWith(portfolio: items, notice: 'Portfolio save ho gaya.'),
    );
  }

  /// One mint probe per page open: the ONLY dormancy detector (#1578). A 503
  /// latches [ProfileEditState.mediaUploadsDormant] so the media section shows
  /// its honest state; anything else (live bucket, network blip, old server)
  /// leaves uploads enabled and the upload path surfaces its own errors.
  /// Never throws, never blocks the ready emit — it runs after it.
  Future<void> _probeMediaUploads() async {
    try {
      await _repo.requestPortfolioUploadUrl(
        kind: 'photo',
        contentType: 'image/jpeg',
      );
      if (isClosed) return;
    } on Failure catch (f) {
      if (isClosed) return;
      if (_isDormant(f)) emit(state.copyWith(mediaUploadsDormant: true));
    } catch (_) {
      // Not a mint answer (timeout, socket): not dormancy, say nothing.
    }
  }

  /// True only for the dormant-bucket answer: the 503 the mint route fails
  /// closed with when `WORKER_PORTFOLIO_BUCKET` is unset. Never inferred from
  /// a timeout or any other status.
  bool _isDormant(Failure f) =>
      f is ServerFailure && f.statusCode == 503;

  /// Starts a media upload as a VISIBLE pending row (#1578): mint → PUT bytes
  /// → re-save the list with the new item. The row is there from the tap, so
  /// there is no spinner-to-nowhere; on failure it keeps its reason, a retry
  /// and a remove.
  Future<void> uploadPortfolioMedia(
    PickedPortfolioMedia media, {
    String? caption,
  }) async {
    if (state.mediaUploadsDormant) {
      emit(state.copyWith(error: kPortfolioDormantCopy));
      return;
    }
    if (state.saving.contains(ProfileEditSection.portfolio)) return;
    final String id =
        '${DateTime.now().microsecondsSinceEpoch}-${state.pendingUploads.length}';
    final PendingPortfolioUpload pending = PendingPortfolioUpload(
      id: id,
      media: media,
      caption:
          (caption == null || caption.trim().isEmpty) ? null : caption.trim(),
      status: PendingPortfolioUploadStatus.uploading,
    );
    _markSaving(ProfileEditSection.portfolio, true, clearFeedback: true);
    emit(state.copyWith(
      pendingUploads: <PendingPortfolioUpload>[...state.pendingUploads, pending],
    ));
    await _runPendingUpload(pending);
  }

  /// Re-runs a failed upload with the bytes it already holds — no re-pick.
  Future<void> retryPortfolioUpload(String id) async {
    final int index =
        state.pendingUploads.indexWhere((PendingPortfolioUpload p) => p.id == id);
    if (index < 0) return;
    final PendingPortfolioUpload pending = state.pendingUploads[index];
    if (pending.status != PendingPortfolioUploadStatus.failed) return;
    if (state.saving.contains(ProfileEditSection.portfolio)) return;
    if (state.mediaUploadsDormant) {
      emit(state.copyWith(error: kPortfolioDormantCopy));
      return;
    }
    _markSaving(ProfileEditSection.portfolio, true, clearFeedback: true);
    emit(state.copyWith(
      pendingUploads: <PendingPortfolioUpload>[
        for (int i = 0; i < state.pendingUploads.length; i++)
          if (i == index)
            pending.copyWith(
              status: PendingPortfolioUploadStatus.uploading,
              error: null,
            )
          else
            state.pendingUploads[i],
      ],
    ));
    await _runPendingUpload(
      state.pendingUploads[index],
    );
  }

  /// Drops a failed upload row. Uploading rows are not removable — the mint →
  /// PUT → save dance is seconds-long and idempotent on retry, so there is no
  /// stuck state worth cancelling into.
  void removePendingUpload(String id) {
    emit(state.copyWith(
      pendingUploads: <PendingPortfolioUpload>[
        for (final PendingPortfolioUpload p in state.pendingUploads)
          if (p.id != id) p,
      ],
      error: null,
      notice: null,
    ));
  }

  Future<void> _runPendingUpload(PendingPortfolioUpload pending) async {
    try {
      final ticket = await _repo.requestPortfolioUploadUrl(
        kind: pending.media.kind,
        contentType: pending.media.contentType,
      );
      await _repo.uploadPortfolioBytes(ticket: ticket, media: pending.media);
      if (isClosed) return;
      final List<PortfolioItemDto> next = <PortfolioItemDto>[
        ...state.portfolio,
        PortfolioItemDto(
          kind: pending.media.kind,
          storageKey: ticket.storagePath,
          caption: pending.caption,
        ),
      ];
      await _repo.savePortfolio(next);
      if (isClosed) return;
      emit(state.copyWith(
        portfolio: next,
        pendingUploads: <PendingPortfolioUpload>[
          for (final PendingPortfolioUpload p in state.pendingUploads)
            if (p.id != pending.id) p,
        ],
        notice: 'Portfolio update ho gaya.',
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      if (_isDormant(f)) {
        // The bucket went dark between the probe and this mint: latch the
        // honest state AND keep the row, so the worker sees both what happened
        // and that media upload itself is unavailable.
        emit(state.copyWith(
          mediaUploadsDormant: true,
          pendingUploads: <PendingPortfolioUpload>[
            for (final PendingPortfolioUpload p in state.pendingUploads)
              if (p.id == pending.id)
                p.copyWith(
                  status: PendingPortfolioUploadStatus.failed,
                  error: kPortfolioDormantCopy,
                )
              else
                p,
          ],
        ));
        return;
      }
      emit(state.copyWith(
        pendingUploads: <PendingPortfolioUpload>[
          for (final PendingPortfolioUpload p in state.pendingUploads)
            if (p.id == pending.id)
              p.copyWith(
                status: PendingPortfolioUploadStatus.failed,
                // At-cap / invalid-type answers name themselves (a 400); the
                // message is the worker's own input echoed back, same rule as
                // the city-400 the finishing form surfaces.
                error: _reason(f),
              )
            else
              p,
        ],
      ));
    } catch (_) {
      if (isClosed) return;
      emit(state.copyWith(
        pendingUploads: <PendingPortfolioUpload>[
          for (final PendingPortfolioUpload p in state.pendingUploads)
            if (p.id == pending.id)
              p.copyWith(
                status: PendingPortfolioUploadStatus.failed,
                error: 'Portfolio upload nahi hua.',
              )
            else
              p,
        ],
      ));
    } finally {
      _markSaving(ProfileEditSection.portfolio, false);
    }
  }

  /// Builds the tri-state preferences body for the extended attributes only,
  /// with `touched_only: true` so the server keeps the #1504 strict contract.
  /// Absent keys are left alone; a touched empty list / false is a real
  /// withdrawal. A touched key carries its FULL current value, which [load]
  /// prefilled from the stored answers (#1541) — so a one-chip edit re-sends
  /// the rest of that saved list or availability object rather than wiping it.
  Future<void> saveExtendedAttributes({
    required bool workTypesTouched,
    required bool salaryPeriodTouched,
    required bool commuteTouched,
    required bool travelTouched,
    required bool availabilityTouched,
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{'touched_only': true};
    final Set<String> sentWorkTypes = state.workTypes;
    if (workTypesTouched) {
      body['work_types'] = sentWorkTypes.toList();
      // #1541 — the card showed the legacy `job_type` chip ticked and the
      // worker un-ticked down to none. `work_types: []` alone cannot withdraw
      // it: the server clears only the multi and its precedence then falls
      // back to `job_type`, so the chip would come straight back. Clearing it
      // here removes only the value this card SHOWED — never a hidden one.
      if (_shownJobType != null && sentWorkTypes.isEmpty) {
        body['job_type'] = null;
      }
    }
    if (salaryPeriodTouched) body['salary_period'] = state.salaryPeriod;
    if (commuteTouched) body['commute_max_km'] = state.commuteMaxKm;
    if (travelTouched) body['willing_to_travel'] = state.willingToTravel;
    if (availabilityTouched) {
      body['availability'] = state.availability.isEmpty
          ? null
          : state.availability.toJson();
    }
    await _save(
      ProfileEditSection.attributes,
      () => _repo.saveWorkPreferences(body),
      onSuccess: () {
        // Once a work-types save lands, the legacy value is still "shown" only
        // if its chip is in the set just saved — what a fresh [load] would see.
        if (workTypesTouched && !sentWorkTypes.contains(_shownJobType)) {
          _shownJobType = null;
        }
        return state.copyWith(notice: 'Kaam ki jaankari save ho gayi.');
      },
    );
  }

  void clearFeedback() => emit(state.copyWith(error: null, notice: null));

  // ---- Internals -----------------------------------------------------------

  Future<void> _save(
    ProfileEditSection section,
    Future<void> Function() write, {
    required ProfileEditState Function() onSuccess,
  }) async {
    if (state.saving.contains(section)) return;
    _markSaving(section, true, clearFeedback: true);
    try {
      await write();
      if (isClosed) return;
      emit(onSuccess());
    } on Failure catch (f) {
      if (isClosed) return;
      emit(state.copyWith(error: _reason(f)));
    } catch (_) {
      if (isClosed) return;
      emit(state.copyWith(error: 'Save nahi hua. Dobara koshish karein.'));
    } finally {
      _markSaving(section, false);
    }
  }

  /// Toggles a section's in-flight flag. [clearFeedback] is passed only on the
  /// way IN, so the `finally`'s clear cannot wipe the notice the save just set.
  void _markSaving(
    ProfileEditSection section,
    bool on, {
    bool clearFeedback = false,
  }) {
    final Set<ProfileEditSection> next = <ProfileEditSection>{...state.saving};
    on ? next.add(section) : next.remove(section);
    if (clearFeedback) {
      emit(state.copyWith(saving: next, error: null, notice: null));
    } else {
      emit(state.copyWith(saving: next));
    }
  }

  /// The stored work types the chips start from (#1541), by the server's own
  /// precedence (`worker-field-precedence.ts`): a non-empty `work_types` wins,
  /// else the legacy single `job_type` — the same rule the Profile tab prints
  /// by, so the card shows what the worker already sees as saved. A touched
  /// save then sends that set plus the change, never the change alone.
  static Set<String> _storedWorkTypes(WorkPreferencesDto prefs) {
    final List<String> multi = prefs.workTypes ?? const <String>[];
    if (multi.isNotEmpty) return multi.toSet();
    // A multi withheld in `partial` is still stored and still wins
    // server-side, so falling back to `job_type` there would offer a set the
    // server does not resolve to — the chips start blank instead.
    if (prefs.partial.contains('work_types')) return <String>{};
    final String? single = prefs.jobType;
    return (single == null || single.isEmpty) ? <String>{} : <String>{single};
  }

  /// The stored availability object as the editable draft (#1541). The PUT
  /// REPLACES the whole object, so the draft must carry every stored part: a
  /// status-only edit then re-sends the saved date and notice days instead of
  /// nulling them.
  static AvailabilityDraft _storedAvailability(WorkAvailabilityDto? stored) {
    if (stored == null) return const AvailabilityDraft();
    return AvailabilityDraft(
      status: stored.status,
      availableFrom: stored.availableFrom,
      noticePeriodDays: stored.noticeDays,
    );
  }

  String _reason(Failure f) {
    // A 400 from these endpoints NAMES the offending input (a duplicate
    // language, a bad licence number) — that message is more useful than the
    // generic failure copy, and the input is the worker's own.
    if (f is InvalidRequestFailure && f.message.trim().isNotEmpty) {
      return f.message;
    }
    return 'Save nahi hua. Dobara koshish karein.';
  }
}

const Object _sentinel = Object();
