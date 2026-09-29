import 'package:badabhai_worker_app/core/api/api_client.dart'
    show
        LanguageAbilityDto,
        MyLanguagesDto,
        MyOccupationDto,
        MyOccupationsDto,
        MyPortfolioDto,
        MyQualificationsDto,
        MyWhatsappDto,
        PortfolioItemDto,
        PortfolioUploadTicket,
        WorkAvailabilityDto,
        WorkPrefOptionsDto,
        WorkPreferencesDto;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_models.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';
import 'package:badabhai_worker_app/features/profile_edit/presentation/cubit/profile_edit_cubit.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeRepo implements ProfileEditRepository {
  _FakeRepo({
    this.failLoad = false,
    this.stored = const WorkPreferencesDto(),
    this.storedError,
    this.options = const WorkPrefOptionsDto(
      languages: <String, String>{'hindi': 'Hindi', 'english': 'English'},
      documentsReady: <String, String>{},
      jobType: <String, String>{'permanent': 'Permanent'},
      shift: <String, String>{},
    ),
  });

  final bool failLoad;

  /// What GET /workers/me/work-preferences answers (#1541 prefill).
  final WorkPreferencesDto stored;

  /// When set, the prefill read throws it.
  final Failure? storedError;
  final WorkPrefOptionsDto options;
  bool uploaded = false;
  Map<String, dynamic>? savedPrefs;

  @override
  Future<MyWhatsappDto> loadWhatsapp() async {
    if (failLoad) throw const NetworkFailure();
    return const MyWhatsappDto(whatsapp: '+919876543210', hasWhatsapp: true);
  }

  @override
  Future<void> saveWhatsapp(String? whatsapp) async {}

  @override
  Future<MyLanguagesDto> loadLanguages() async => const MyLanguagesDto(
        languages: <LanguageAbilityDto>[
          LanguageAbilityDto(language: 'hindi', canSpeak: true),
        ],
      );

  @override
  Future<void> saveLanguages(List<LanguageAbilityDto> languages) async {}

  @override
  Future<MyOccupationsDto> loadOccupations() async => const MyOccupationsDto(
        occupations: <MyOccupationDto>[
          MyOccupationDto(roleId: 'role_welder', label: 'Welder'),
        ],
      );

  @override
  Future<void> saveOccupations(List<String> roleIds) async {}

  @override
  Future<MyQualificationsDto> loadQualifications() async =>
      const MyQualificationsDto();

  @override
  Future<void> saveQualifications(Map<String, dynamic> fields) async {}

  @override
  Future<MyPortfolioDto> loadPortfolio() async => const MyPortfolioDto();

  @override
  Future<void> savePortfolio(List<PortfolioItemDto> items) async {}

  @override
  Future<PortfolioUploadTicket> requestPortfolioUploadUrl({
    required String kind,
    required String contentType,
  }) async =>
      const PortfolioUploadTicket(
        storagePath: 'portfolio/w1/abc.jpg',
        uploadUrl: 'https://signed',
        expiresInSeconds: 60,
      );

  @override
  Future<void> uploadPortfolioBytes({
    required PortfolioUploadTicket ticket,
    required PickedPortfolioMedia media,
  }) async {
    uploaded = true;
  }

  @override
  Future<WorkPrefOptionsDto> loadWorkPreferenceOptions() async => options;

  @override
  Future<WorkPreferencesDto> loadWorkPreferences() async {
    final Failure? error = storedError;
    if (error != null) throw error;
    return stored;
  }

  @override
  Future<void> saveWorkPreferences(Map<String, dynamic> fields) async {
    savedPrefs = fields;
  }
}

/// A worker who saved every extended part from an earlier visit (#1541).
const WorkPreferencesDto _savedEverything = WorkPreferencesDto(
  workTypes: <String>['permanent', 'contract'],
  jobType: 'temporary',
  salaryPeriod: 'day',
  commuteKm: 25,
  willingToTravel: true,
  availability: WorkAvailabilityDto(
    status: 'serving_notice',
    availableFrom: '2026-10-01',
    noticeDays: 30,
  ),
);

/// The server's closed `AVAILABILITY_STATUSES` slugs, exactly
/// (`worker-preferences.vocabulary.ts`).
const Set<String> _serverStatusSlugs = <String>{
  'immediate',
  'within_week',
  'within_month',
  'serving_notice',
};

void main() {
  group('ProfileEditCubit.load', () {
    test('loads every surface into one ready state', () async {
      final ProfileEditCubit cubit = ProfileEditCubit(_FakeRepo());
      await cubit.load();
      expect(cubit.state.status, ProfileEditStatus.ready);
      expect(cubit.state.whatsapp, '+919876543210');
      expect(cubit.state.languages.single.language, 'hindi');
      expect(cubit.state.occupations, <String>['role_welder']);
      expect(cubit.state.occupationLabels['role_welder'], 'Welder');
      expect(cubit.state.languageLabels['hindi'], 'Hindi');
    });

    test('a failure anywhere fails the load closed', () async {
      final ProfileEditCubit cubit = ProfileEditCubit(_FakeRepo(failLoad: true));
      await cubit.load();
      expect(cubit.state.status, ProfileEditStatus.failed);
      expect(cubit.state.failure, isA<NetworkFailure>());
    });
  });

  group('ProfileEditCubit saves', () {
    test('saveWhatsapp treats a blank as a clear', () async {
      final ProfileEditCubit cubit = ProfileEditCubit(_FakeRepo());
      await cubit.load();
      await cubit.saveWhatsapp('   ');
      expect(cubit.state.whatsapp, isNull);
      expect(cubit.state.notice, isNotNull);
    });

    test('toggleOccupation refuses a fifth role', () async {
      final ProfileEditCubit cubit = ProfileEditCubit(_FakeRepo());
      await cubit.load();
      cubit.toggleOccupation('role_cnc_operator');
      cubit.toggleOccupation('role_plumber');
      cubit.toggleOccupation('role_carpenter');
      cubit.toggleOccupation('role_designer');
      // 1 loaded + 4 toggled = 5, but the cap is 4, so the last is refused.
      expect(cubit.state.occupations.length, kMaxSecondaryOccupations);
    });

    test('saveExtendedAttributes only sends touched keys, with touched_only',
        () async {
      final _FakeRepo repo = _FakeRepo();
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();
      cubit.toggleWorkType('permanent');
      cubit.setCommuteMaxKm(20);
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: true,
        travelTouched: false,
        availabilityTouched: false,
      );
      expect(repo.savedPrefs!['touched_only'], isTrue);
      expect(repo.savedPrefs!['work_types'], <String>['permanent']);
      expect(repo.savedPrefs!['commute_max_km'], 20);
      expect(repo.savedPrefs!.containsKey('salary_period'), isFalse);
      expect(repo.savedPrefs!.containsKey('willing_to_travel'), isFalse);
      expect(repo.savedPrefs!.containsKey('availability'), isFalse);
    });

    test('uploadPortfolioMedia mints, uploads, then saves the item', () async {
      final _FakeRepo repo = _FakeRepo();
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();
      await cubit.uploadPortfolioMedia(
        const PickedPortfolioMedia(
          kind: 'photo',
          contentType: 'image/jpeg',
          bytes: <int>[1, 2, 3],
          sizeBytes: 3,
        ),
      );
      expect(repo.uploaded, isTrue);
      expect(cubit.state.portfolio.single.kind, 'photo');
      expect(cubit.state.portfolio.single.storageKey, 'portfolio/w1/abc.jpg');
      expect(cubit.state.error, isNull);
    });
  });

  /// #1541 — the "Kaam ki jaankari" card opens on the worker's SAVED answers,
  /// and a save never overwrites a saved part the worker did not touch.
  group('ProfileEditCubit work-preferences prefill (#1541)', () {
    test('load prefills every extended field from the stored answers',
        () async {
      final ProfileEditCubit cubit =
          ProfileEditCubit(_FakeRepo(stored: _savedEverything));
      await cubit.load();

      expect(cubit.state.status, ProfileEditStatus.ready);
      // A non-empty multi wins over the legacy single job_type.
      expect(cubit.state.workTypes, <String>{'permanent', 'contract'});
      expect(cubit.state.salaryPeriod, 'day');
      expect(cubit.state.commuteMaxKm, 25);
      expect(cubit.state.willingToTravel, isTrue);
      expect(
        cubit.state.availability,
        const AvailabilityDraft(
          status: 'serving_notice',
          availableFrom: '2026-10-01',
          noticePeriodDays: 30,
        ),
      );
    });

    test('no stored rows (all null) leaves the card at its blank defaults',
        () async {
      final ProfileEditCubit cubit = ProfileEditCubit(_FakeRepo());
      await cubit.load();

      expect(cubit.state.workTypes, isEmpty);
      expect(cubit.state.salaryPeriod, isNull);
      expect(cubit.state.commuteMaxKm, isNull);
      expect(cubit.state.willingToTravel, isFalse);
      expect(cubit.state.availability.isEmpty, isTrue);
    });

    test('with no work_types stored, the legacy job_type is the prefill',
        () async {
      for (final List<String>? multi in <List<String>?>[null, <String>[]]) {
        final ProfileEditCubit cubit = ProfileEditCubit(
          _FakeRepo(
            stored: WorkPreferencesDto(workTypes: multi, jobType: 'contract'),
          ),
        );
        await cubit.load();
        expect(cubit.state.workTypes, <String>{'contract'}, reason: '$multi');
      }
    });

    test('a work_types withheld in partial does not fall back to job_type',
        () async {
      final _FakeRepo repo = _FakeRepo(
        stored: const WorkPreferencesDto(
          jobType: 'contract',
          partial: <String>['work_types'],
        ),
      );
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      // The stored multi still wins server-side, so the legacy value is NOT
      // what this worker's work types resolve to: the chips start blank.
      expect(cubit.state.workTypes, isEmpty);

      cubit.toggleWorkType('daily_wage');
      cubit.toggleWorkType('daily_wage');
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );
      expect(repo.savedPrefs!.containsKey('job_type'), isFalse);
    });

    test('un-ticking the legacy job_type chip down to none clears job_type too',
        () async {
      final _FakeRepo repo = _FakeRepo(
        stored: const WorkPreferencesDto(jobType: 'contract'),
      );
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      cubit.toggleWorkType('contract');
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );

      // `work_types: []` alone would leave job_type as the server's fallback.
      expect(repo.savedPrefs, <String, dynamic>{
        'touched_only': true,
        'work_types': <String>[],
        'job_type': null,
      });
      expect(cubit.state.notice, 'Kaam ki jaankari save ho gayi.');
    });

    test('the legacy clear is sent once; a later empty save omits job_type',
        () async {
      final _FakeRepo repo = _FakeRepo(
        stored: const WorkPreferencesDto(jobType: 'contract'),
      );
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();
      cubit.toggleWorkType('contract');
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );
      expect(repo.savedPrefs!.containsKey('job_type'), isTrue);

      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );
      expect(repo.savedPrefs!.containsKey('job_type'), isFalse);
    });

    test('swapping the legacy chip for another leaves job_type absent',
        () async {
      final _FakeRepo repo = _FakeRepo(
        stored: const WorkPreferencesDto(jobType: 'contract'),
      );
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      cubit.toggleWorkType('contract');
      cubit.toggleWorkType('daily_wage');
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );

      // A non-empty multi wins over job_type server-side; the single is left
      // alone (the multi sits beside it, never replaces it).
      expect(repo.savedPrefs!['work_types'], <String>['daily_wage']);
      expect(repo.savedPrefs!.containsKey('job_type'), isFalse);
    });

    test('job_type shown inside the saved multi is cleared when all go',
        () async {
      final _FakeRepo repo = _FakeRepo(
        stored: const WorkPreferencesDto(
          workTypes: <String>['contract', 'daily_wage'],
          jobType: 'contract',
        ),
      );
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      cubit.toggleWorkType('contract');
      cubit.toggleWorkType('daily_wage');
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );

      expect(repo.savedPrefs!['work_types'], isEmpty);
      expect(repo.savedPrefs!.containsKey('job_type'), isTrue);
      expect(repo.savedPrefs!['job_type'], isNull);
    });

    test('un-ticking a work_types-backed set never touches the hidden job_type',
        () async {
      final _FakeRepo repo = _FakeRepo(stored: _savedEverything);
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      cubit.toggleWorkType('permanent');
      cubit.toggleWorkType('contract');
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );

      expect(repo.savedPrefs!['work_types'], isEmpty);
      expect(repo.savedPrefs!.containsKey('job_type'), isFalse);
    });

    test('a failed prefill read fails the load closed with its typed cause',
        () async {
      final ProfileEditCubit cubit = ProfileEditCubit(
        _FakeRepo(storedError: const ServerFailure(500)),
      );
      await cubit.load();

      expect(cubit.state.status, ProfileEditStatus.failed);
      expect(cubit.state.failure, isA<ServerFailure>());
    });

    test('a status-only edit re-sends the saved date and notice days',
        () async {
      final _FakeRepo repo = _FakeRepo(stored: _savedEverything);
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      cubit.setAvailability(
        cubit.state.availability.copyWith(status: 'immediate'),
      );
      await cubit.saveExtendedAttributes(
        workTypesTouched: false,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: true,
      );

      expect(repo.savedPrefs!['availability'], <String, dynamic>{
        'status': 'immediate',
        'available_from': '2026-10-01',
        'notice_period_days': 30,
      });
      // Untouched parts stay ABSENT — the server leaves them alone.
      expect(repo.savedPrefs!.keys.toSet(),
          <String>{'touched_only', 'availability'});
    });

    test('one extra work-type chip re-sends the saved list plus the new one',
        () async {
      final _FakeRepo repo = _FakeRepo(stored: _savedEverything);
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      cubit.toggleWorkType('daily_wage');
      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: false,
        commuteTouched: false,
        travelTouched: false,
        availabilityTouched: false,
      );

      expect(
        (repo.savedPrefs!['work_types'] as List<String>).toSet(),
        <String>{'permanent', 'contract', 'daily_wage'},
      );
      expect(repo.savedPrefs!.containsKey('availability'), isFalse);
      expect(repo.savedPrefs!.containsKey('salary_period'), isFalse);
      expect(repo.savedPrefs!.containsKey('commute_max_km'), isFalse);
      expect(repo.savedPrefs!.containsKey('willing_to_travel'), isFalse);
    });

    test('touching a prefilled field without changing it re-sends the saved value',
        () async {
      final _FakeRepo repo = _FakeRepo(stored: _savedEverything);
      final ProfileEditCubit cubit = ProfileEditCubit(repo);
      await cubit.load();

      await cubit.saveExtendedAttributes(
        workTypesTouched: true,
        salaryPeriodTouched: true,
        commuteTouched: true,
        travelTouched: true,
        availabilityTouched: true,
      );

      expect(repo.savedPrefs!['salary_period'], 'day');
      expect(repo.savedPrefs!['commute_max_km'], 25);
      expect(repo.savedPrefs!['willing_to_travel'], isTrue);
      expect(repo.savedPrefs!['availability'], <String, dynamic>{
        'status': 'serving_notice',
        'available_from': '2026-10-01',
        'notice_period_days': 30,
      });
    });
  });

  /// #1541 — the "Kab se available" chips never offer a slug the PUT rejects.
  group('ProfileEditState.availabilityStatusOptions (#1541)', () {
    test('uses the server-served dictionary, in server order', () async {
      final ProfileEditCubit cubit = ProfileEditCubit(
        _FakeRepo(
          options: const WorkPrefOptionsDto(
            languages: <String, String>{},
            documentsReady: <String, String>{},
            jobType: <String, String>{},
            shift: <String, String>{},
            availabilityStatus: <String, String>{
              'immediate': 'Immediately',
              'within_week': 'Within a week',
              'within_month': 'Within a month',
              'serving_notice': 'Serving notice',
            },
          ),
        ),
      );
      await cubit.load();

      expect(cubit.state.availabilityStatusOptions.keys.toList(), <String>[
        'immediate',
        'within_week',
        'within_month',
        'serving_notice',
      ]);
      expect(cubit.state.availabilityStatusOptions['serving_notice'],
          'Serving notice');
    });

    test('an older server without the key falls back to the static copy',
        () async {
      final ProfileEditCubit cubit = ProfileEditCubit(_FakeRepo());
      await cubit.load();

      expect(cubit.state.availabilityStatusOptions, kAvailabilityStatuses);
    });

    test('the static fallback uses the server slugs EXACTLY', () {
      expect(kAvailabilityStatuses.keys.toSet(), _serverStatusSlugs);
      expect(kAvailabilityStatuses.containsKey('notice_period'), isFalse);
    });
  });

  /// #1578 — explicit portfolio page states.
  group('ProfileEditCubit portfolio states', () {
  ProfileEditCubit buildWith(_PortfolioKnobRepo repo) =>
      ProfileEditCubit(repo);

  const PickedPortfolioMedia photo = PickedPortfolioMedia(
    kind: 'photo',
    contentType: 'image/jpeg',
    bytes: <int>[1, 2, 3],
    sizeBytes: 3,
  );

  test('a 503 probe latches dormant; a live probe does not', () async {
    final ProfileEditCubit dormant =
        buildWith(_PortfolioKnobRepo(mintError: const ServerFailure(503)));
    await dormant.load();
    expect(dormant.state.status, ProfileEditStatus.ready);
    expect(dormant.state.mediaUploadsDormant, isTrue);

    final ProfileEditCubit live = buildWith(_PortfolioKnobRepo());
    await live.load();
    expect(live.state.mediaUploadsDormant, isFalse);
  });

  test('upload while dormant makes no network call and repeats the copy',
      () async {
    final _PortfolioKnobRepo repo =
        _PortfolioKnobRepo(mintError: const ServerFailure(503));
    final ProfileEditCubit cubit = buildWith(repo);
    await cubit.load();
    expect(cubit.state.mediaUploadsDormant, isTrue);

    final int callsBefore = repo.mintCalls;
    await cubit.uploadPortfolioMedia(photo);

    expect(repo.mintCalls, callsBefore);
    expect(cubit.state.error, kPortfolioDormantCopy);
    expect(cubit.state.pendingUploads, isEmpty);
  });

  test('a 503 mid-upload latches dormant and keeps the failed row', () async {
    final _PortfolioKnobRepo repo =
        _PortfolioKnobRepo(failUploadMintWith: const ServerFailure(503));
    final ProfileEditCubit cubit = buildWith(repo);
    await cubit.load();
    expect(cubit.state.mediaUploadsDormant, isFalse);

    await cubit.uploadPortfolioMedia(photo);

    expect(cubit.state.mediaUploadsDormant, isTrue);
    expect(cubit.state.pendingUploads, hasLength(1));
    expect(cubit.state.pendingUploads.single.status,
        PendingPortfolioUploadStatus.failed);
    expect(cubit.state.pendingUploads.single.error, kPortfolioDormantCopy);
    expect(cubit.state.portfolio, isEmpty);
  });

  test('a named 400 fails the row with the server reason', () async {
    final _PortfolioKnobRepo repo = _PortfolioKnobRepo(
      failPutWith: const InvalidRequestFailure('remove contact details'),
    );
    final ProfileEditCubit cubit = buildWith(repo);
    await cubit.load();

    await cubit.uploadPortfolioMedia(photo);

    expect(cubit.state.pendingUploads, hasLength(1));
    expect(cubit.state.pendingUploads.single.error, 'remove contact details');
    expect(cubit.state.portfolio, isEmpty);
  });

  test('retry reuses the held bytes and lands the item', () async {
    final _PortfolioKnobRepo repo = _PortfolioKnobRepo(
      failPutWith: const InvalidRequestFailure('remove contact details'),
    );
    final ProfileEditCubit cubit = buildWith(repo);
    await cubit.load();
    await cubit.uploadPortfolioMedia(photo);
    expect(cubit.state.pendingUploads, hasLength(1));

    repo.failPutWith = null;
    await cubit.retryPortfolioUpload(cubit.state.pendingUploads.single.id);

    expect(cubit.state.pendingUploads, isEmpty);
    expect(cubit.state.portfolio.single.kind, 'photo');
  });

  test('removePendingUpload drops the failed row', () async {
    final _PortfolioKnobRepo repo = _PortfolioKnobRepo(
      failPutWith: const InvalidRequestFailure('remove contact details'),
    );
    final ProfileEditCubit cubit = buildWith(repo);
    await cubit.load();
    await cubit.uploadPortfolioMedia(photo);
    expect(cubit.state.pendingUploads, hasLength(1));

    cubit.removePendingUpload(cubit.state.pendingUploads.single.id);
    expect(cubit.state.pendingUploads, isEmpty);
    expect(cubit.state.portfolio, isEmpty);
  });
});
}

/// Configurable portfolio double: [mintError] fails the PROBE mint (load),
/// [failUploadMintWith] fails the upload mint only, [failPutWith] fails the
/// byte PUT. Null anywhere means success on that leg.
class _PortfolioKnobRepo implements ProfileEditRepository {
  _PortfolioKnobRepo({
    this.mintError,
    this.failUploadMintWith,
    this.failPutWith,
  });

  final Failure? mintError;
  final Failure? failUploadMintWith;
  Failure? failPutWith;
  int mintCalls = 0;
  bool _probed = false;

  @override
  Future<MyWhatsappDto> loadWhatsapp() async => const MyWhatsappDto();

  @override
  Future<void> saveWhatsapp(String? whatsapp) async {}

  @override
  Future<MyLanguagesDto> loadLanguages() async => const MyLanguagesDto();

  @override
  Future<void> saveLanguages(List<LanguageAbilityDto> languages) async {}

  @override
  Future<MyOccupationsDto> loadOccupations() async => const MyOccupationsDto();

  @override
  Future<void> saveOccupations(List<String> roleIds) async {}

  @override
  Future<MyQualificationsDto> loadQualifications() async =>
      const MyQualificationsDto();

  @override
  Future<void> saveQualifications(Map<String, dynamic> fields) async {}

  @override
  Future<MyPortfolioDto> loadPortfolio() async => const MyPortfolioDto();

  @override
  Future<void> savePortfolio(List<PortfolioItemDto> items) async {}

  @override
  Future<PortfolioUploadTicket> requestPortfolioUploadUrl({
    required String kind,
    required String contentType,
  }) async {
    mintCalls++;
    // The first mint is the dormancy probe; only it sees [mintError].
    if (!_probed) {
      _probed = true;
      final Failure? error = mintError;
      if (error != null) throw error;
    } else if (failUploadMintWith != null) {
      throw failUploadMintWith!;
    }
    return const PortfolioUploadTicket(
      storagePath: 'portfolio/w1/abc.jpg',
      uploadUrl: 'https://signed',
      expiresInSeconds: 60,
    );
  }

  @override
  Future<void> uploadPortfolioBytes({
    required PortfolioUploadTicket ticket,
    required PickedPortfolioMedia media,
  }) async {
    final Failure? error = failPutWith;
    if (error != null) throw error;
  }

  @override
  Future<WorkPrefOptionsDto> loadWorkPreferenceOptions() async =>
      const WorkPrefOptionsDto(
        languages: <String, String>{},
        documentsReady: <String, String>{},
        jobType: <String, String>{},
        shift: <String, String>{},
      );

  @override
  Future<WorkPreferencesDto> loadWorkPreferences() async =>
      const WorkPreferencesDto();

  @override
  Future<void> saveWorkPreferences(Map<String, dynamic> fields) async {}
}

