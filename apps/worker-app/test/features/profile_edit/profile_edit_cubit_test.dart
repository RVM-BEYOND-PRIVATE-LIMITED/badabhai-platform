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
        WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_models.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';
import 'package:badabhai_worker_app/features/profile_edit/presentation/cubit/profile_edit_cubit.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeRepo implements ProfileEditRepository {
  _FakeRepo({this.failLoad = false});

  final bool failLoad;
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
  Future<WorkPrefOptionsDto> loadWorkPreferenceOptions() async =>
      const WorkPrefOptionsDto(
        languages: <String, String>{'hindi': 'Hindi', 'english': 'English'},
        documentsReady: <String, String>{},
        jobType: <String, String>{'permanent': 'Permanent'},
        shift: <String, String>{},
      );

  @override
  Future<void> saveWorkPreferences(Map<String, dynamic> fields) async {
    savedPrefs = fields;
  }
}

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
}
