import 'package:badabhai_worker_app/core/api/api_client.dart'
    show
        LanguageAbilityDto,
        MyLanguagesDto,
        MyOccupationsDto,
        MyPortfolioDto,
        MyQualificationsDto,
        MyWhatsappDto,
        PortfolioItemDto,
        PortfolioUploadTicket,
        WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_models.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';
import 'package:badabhai_worker_app/features/profile_edit/presentation/cubit/profile_edit_cubit.dart';
import 'package:badabhai_worker_app/features/profile_edit/presentation/profile_edit_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

class _FakeRepo implements ProfileEditRepository {
  final List<String?> whatsappSaves = <String?>[];

  @override
  Future<MyWhatsappDto> loadWhatsapp() async =>
      const MyWhatsappDto(whatsapp: '+919876543210', hasWhatsapp: true);

  @override
  Future<void> saveWhatsapp(String? whatsapp) async =>
      whatsappSaves.add(whatsapp);

  @override
  Future<MyLanguagesDto> loadLanguages() async => const MyLanguagesDto();

  @override
  Future<void> saveLanguages(List<LanguageAbilityDto> languages) async {}

  @override
  Future<MyOccupationsDto> loadOccupations() async =>
      const MyOccupationsDto();

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
        storagePath: 'portfolio/w1/a.jpg',
        uploadUrl: 'https://signed',
        expiresInSeconds: 60,
      );

  @override
  Future<void> uploadPortfolioBytes({
    required PortfolioUploadTicket ticket,
    required PickedPortfolioMedia media,
  }) async {}

  @override
  Future<WorkPrefOptionsDto> loadWorkPreferenceOptions() async =>
      const WorkPrefOptionsDto(
        languages: <String, String>{'hindi': 'Hindi'},
        documentsReady: <String, String>{},
        jobType: <String, String>{'permanent': 'Permanent'},
        shift: <String, String>{},
      );

  @override
  Future<void> saveWorkPreferences(Map<String, dynamic> fields) async {}
}

Future<void> _pump(WidgetTester tester, _FakeRepo repo) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  locator.registerFactory<ProfileEditCubit>(() => ProfileEditCubit(repo));

  tester.view.physicalSize = const Size(1000, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light(), home: const ProfileEditScreen()),
  );
  await tester.pump(); // loading
  await tester.pump(); // all reads resolve
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets('renders every Layer A section once loaded', (tester) async {
    await _pump(tester, _FakeRepo());
    expect(find.text('WhatsApp number'), findsOneWidget);
    expect(find.text('Bhashayein'), findsOneWidget);
    expect(find.text('Kaam ki jaankari'), findsOneWidget);
    expect(find.text('Training aur licence'), findsOneWidget);
    expect(find.text('Portfolio'), findsOneWidget);
    expect(find.text('Aur kaam (occupation)'), findsOneWidget);
  });

  testWidgets('saving the WhatsApp field writes the E.164 value', (tester) async {
    final _FakeRepo repo = _FakeRepo();
    await _pump(tester, repo);
    await tester.enterText(find.byType(TextField).first, '+919812345678');
    await tester.tap(find.text('Save number'));
    await tester.pump();
    await tester.pump();
    expect(repo.whatsappSaves, <String?>['+919812345678']);
  });
}
