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
        WorkPrefOptionsDto;
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

  Future<void> load() async {
    if (_loading) return;
    _loading = true;
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
      ]);
      if (isClosed) return;
      final MyWhatsappDto whatsapp = results[0]! as MyWhatsappDto;
      final MyLanguagesDto languages = results[1]! as MyLanguagesDto;
      final MyOccupationsDto occupations = results[2]! as MyOccupationsDto;
      final MyQualificationsDto qualifications = results[3]! as MyQualificationsDto;
      final MyPortfolioDto portfolio = results[4]! as MyPortfolioDto;
      final WorkPrefOptionsDto options = results[5]! as WorkPrefOptionsDto;
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
        ),
      );
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

  /// Mints a slot, PUTs the bytes, then re-saves the list with the new item.
  /// A 503 (bucket dormant) surfaces its honest reason; nothing is added to the
  /// draft on failure, so the UI never shows an upload that did not happen.
  Future<void> uploadPortfolioMedia(
    PickedPortfolioMedia media, {
    String? caption,
  }) async {
    if (state.saving.contains(ProfileEditSection.portfolio)) return;
    _markSaving(ProfileEditSection.portfolio, true, clearFeedback: true);
    try {
      final ticket = await _repo.requestPortfolioUploadUrl(
        kind: media.kind,
        contentType: media.contentType,
      );
      await _repo.uploadPortfolioBytes(ticket: ticket, media: media);
      if (isClosed) return;
      final List<PortfolioItemDto> next = <PortfolioItemDto>[
        ...state.portfolio,
        PortfolioItemDto(
          kind: media.kind,
          storageKey: ticket.storagePath,
          caption: (caption == null || caption.trim().isEmpty) ? null : caption.trim(),
        ),
      ];
      await _repo.savePortfolio(next);
      if (isClosed) return;
      emit(state.copyWith(
        portfolio: next,
        notice: 'Portfolio update ho gaya.',
      ));
    } on Failure catch (f) {
      if (isClosed) return;
      emit(state.copyWith(error: _reason(f)));
    } catch (_) {
      if (isClosed) return;
      emit(state.copyWith(error: 'Portfolio upload nahi hua.'));
    } finally {
      _markSaving(ProfileEditSection.portfolio, false);
    }
  }

  /// Builds the tri-state preferences body for the extended attributes only,
  /// with `touched_only: true` so the server keeps the #1504 strict contract.
  /// Absent keys are left alone; a touched empty list / false is a real
  /// withdrawal.
  Future<void> saveExtendedAttributes({
    required bool workTypesTouched,
    required bool salaryPeriodTouched,
    required bool commuteTouched,
    required bool travelTouched,
    required bool availabilityTouched,
  }) async {
    final Map<String, dynamic> body = <String, dynamic>{'touched_only': true};
    if (workTypesTouched) body['work_types'] = state.workTypes.toList();
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
      onSuccess: () => state.copyWith(notice: 'Kaam ki jaankari save ho gayi.'),
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
