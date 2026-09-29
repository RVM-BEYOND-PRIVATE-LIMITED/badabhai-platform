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
        WorkAvailabilityDto,
        WorkPrefOptionsDto,
        WorkPreferencesDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_select_chip.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_models.dart';
import 'package:badabhai_worker_app/features/profile_edit/domain/profile_edit_repository.dart';
import 'package:badabhai_worker_app/features/profile_edit/presentation/cubit/profile_edit_cubit.dart';
import 'package:badabhai_worker_app/features/profile_edit/presentation/profile_edit_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

class _FakeRepo implements ProfileEditRepository {
  final List<String?> whatsappSaves = <String?>[];

  /// When set, the mint probe/upload throws it. Null means success.
  Failure? mintError;
  Failure? failPutWith;
  List<PortfolioItemDto> portfolioItems = const <PortfolioItemDto>[];

  /// The served `availability_status` (#1541); empty = an older server.
  Map<String, String> availabilityStatus = const <String, String>{};

  /// GET /workers/me/work-preferences (#1541 prefill).
  WorkPreferencesDto stored = const WorkPreferencesDto();
  Map<String, dynamic>? savedPrefs;

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
  Future<MyPortfolioDto> loadPortfolio() async =>
      MyPortfolioDto(items: portfolioItems);

  @override
  Future<void> savePortfolio(List<PortfolioItemDto> items) async {}

  @override
  @override
  Future<PortfolioUploadTicket> requestPortfolioUploadUrl({
    required String kind,
    required String contentType,
  }) async {
    final Failure? error = mintError;
    if (error != null) throw error;
    return const PortfolioUploadTicket(
      storagePath: 'portfolio/w1/a.jpg',
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
      WorkPrefOptionsDto(
        languages: const <String, String>{'hindi': 'Hindi'},
        documentsReady: const <String, String>{},
        jobType: const <String, String>{
          'permanent': 'Permanent',
          'contract': 'Contract',
        },
        shift: const <String, String>{},
        availabilityStatus: availabilityStatus,
      );

  @override
  Future<WorkPreferencesDto> loadWorkPreferences() async => stored;

  @override
  Future<void> saveWorkPreferences(Map<String, dynamic> fields) async {
    savedPrefs = fields;
  }
}

/// The server's `AVAILABILITY_STATUSES`, verbatim (`worker-preferences.vocabulary.ts`).
const Map<String, String> _servedStatuses = <String, String>{
  'immediate': 'Immediately',
  'within_week': 'Within a week',
  'within_month': 'Within a month',
  'serving_notice': 'Serving notice',
};

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

  /// #1578 — explicit portfolio page states.
  group('portfolio page states', () {
    const PickedPortfolioMedia photo = PickedPortfolioMedia(
      kind: 'photo',
      contentType: 'image/jpeg',
      bytes: <int>[1, 2, 3],
      sizeBytes: 3,
    );

    /// The screen's own cubit (it reloads whatever the locator hands it, so
    /// pre-seeding outside is wiped — drive it through the real wiring).
    ProfileEditCubit cubitOf(WidgetTester tester) =>
        BlocProvider.of<ProfileEditCubit>(
          tester.element(find.text('Portfolio')),
        );

    testWidgets('empty portfolio shows one clear CTA, not two buttons',
        (tester) async {
      await _pump(tester, _FakeRepo());

      expect(find.text('Pehla sample jodein'), findsOneWidget);
      // The inline Link / Photo-Video buttons only appear once items exist.
      expect(find.widgetWithText(TextButton, 'Link'), findsNothing);

      await tester.tap(find.text('Pehla sample jodein'));
      await tester.pumpAndSettle();
      expect(find.text('Sample jodein'), findsOneWidget);
      expect(find.widgetWithText(ListTile, 'Link'), findsOneWidget);
      expect(find.widgetWithText(ListTile, 'Photo/Video'), findsOneWidget);
    });

    testWidgets('dormant bucket shows the honest copy; the CTA repeats it',
        (tester) async {
      final _FakeRepo repo = _FakeRepo()
        ..mintError = const ServerFailure(503);
      await _pump(tester, repo);

      // Static, no spinner left running, no toast on open.
      expect(find.text(kPortfolioDormantCopy), findsOneWidget);

      await tester.tap(find.text('Pehla sample jodein'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ListTile, 'Photo/Video'));
      await tester.pump();

      // Repeats the honest copy; nothing picked, nothing sent.
      expect(find.text(kPortfolioDormantCopy), findsWidgets);
      expect(find.text('Portfolio'), findsOneWidget);
    });

    testWidgets('a failed upload shows retry + remove; retry lands it',
        (tester) async {
      final _FakeRepo repo = _FakeRepo()
        ..failPutWith = const InvalidRequestFailure('bad type');
      await _pump(tester, repo);

      await cubitOf(tester).uploadPortfolioMedia(photo);
      await tester.pump();

      expect(find.text('bad type'), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);

      repo.failPutWith = null;
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await tester.pump();

      expect(find.text('Retry'), findsNothing);
      expect(find.text('Photo'), findsOneWidget);
    });

    testWidgets('a failed upload is removable', (tester) async {
      final _FakeRepo repo = _FakeRepo()
        ..failPutWith = const InvalidRequestFailure('bad type');
      await _pump(tester, repo);

      await cubitOf(tester).uploadPortfolioMedia(photo);
      await tester.pump();
      expect(find.text('bad type'), findsOneWidget);

      await tester.tap(find.byIcon(Icons.close));
      await tester.pump();

      expect(find.text('bad type'), findsNothing);
      expect(find.text('Retry'), findsNothing);
    });

    testWidgets('at-cap names the bound and hides the add buttons',
        (tester) async {
      final _FakeRepo repo = _FakeRepo()
        ..portfolioItems = <PortfolioItemDto>[
          for (int i = 0; i < 12; i++)
            PortfolioItemDto(kind: 'link', url: 'https://x.example/$i'),
        ];
      await _pump(tester, repo);

      expect(find.text('Zyaada se zyaada 12 items.'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Link'), findsNothing);
      expect(find.text('Pehla sample jodein'), findsNothing);
    });
  });

  /// #1541 — the "Kaam ki jaankari" card: prefilled, server-slug chips, and a
  /// save that keeps the saved parts the worker did not touch.
  group('Kaam ki jaankari (#1541)', () {
    const WorkPreferencesDto saved = WorkPreferencesDto(
      workTypes: <String>['contract'],
      salaryPeriod: 'day',
      commuteKm: 25,
      willingToTravel: true,
      availability: WorkAvailabilityDto(
        status: 'serving_notice',
        availableFrom: '2026-10-01',
        noticeDays: 30,
      ),
    );

    bool chipSelected(WidgetTester tester, String label) => tester
        .widget<KitSelectChip>(find.widgetWithText(KitSelectChip, label))
        .selected;

    testWidgets('opens on the saved answers, not blank', (tester) async {
      final _FakeRepo repo = _FakeRepo()
        ..availabilityStatus = _servedStatuses
        ..stored = saved;
      await _pump(tester, repo);

      expect(chipSelected(tester, 'Contract'), isTrue);
      expect(chipSelected(tester, 'Permanent'), isFalse);
      expect(chipSelected(tester, 'Din'), isTrue);
      expect(find.widgetWithText(TextField, '25'), findsOneWidget);
      expect(
        tester
            .widget<SwitchListTile>(find.byType(SwitchListTile))
            .value,
        isTrue,
      );
      expect(chipSelected(tester, 'Serving notice'), isTrue);
      expect(find.widgetWithText(TextField, '2026-10-01'), findsOneWidget);
      expect(find.widgetWithText(TextField, '30'), findsOneWidget);
    });

    testWidgets(
        'a served status chip saves its server slug and keeps the saved '
        'date + notice days', (tester) async {
      final _FakeRepo repo = _FakeRepo()
        ..availabilityStatus = _servedStatuses
        ..stored = saved;
      await _pump(tester, repo);

      await tester.ensureVisible(find.text('Immediately'));
      await tester.tap(find.text('Immediately'));
      await tester.pump();
      await tester.ensureVisible(find.text('Save kaam ki jaankari'));
      await tester.tap(find.text('Save kaam ki jaankari'));
      await tester.pump();
      await tester.pump();

      expect(repo.savedPrefs, <String, dynamic>{
        'touched_only': true,
        'availability': <String, dynamic>{
          'status': 'immediate',
          'available_from': '2026-10-01',
          'notice_period_days': 30,
        },
      });
    });

    testWidgets(
        'an older server gets the Hinglish fallback chips, which still send '
        'serving_notice — never a raw slug on screen', (tester) async {
      final _FakeRepo repo = _FakeRepo();
      await _pump(tester, repo);

      expect(find.text('Notice period ke baad'), findsOneWidget);
      expect(find.text('serving_notice'), findsNothing);
      expect(find.text('notice_period'), findsNothing);

      await tester.ensureVisible(find.text('Notice period ke baad'));
      await tester.tap(find.text('Notice period ke baad'));
      await tester.pump();
      await tester.ensureVisible(find.text('Save kaam ki jaankari'));
      await tester.tap(find.text('Save kaam ki jaankari'));
      await tester.pump();
      await tester.pump();

      expect(
        (repo.savedPrefs!['availability'] as Map<String, dynamic>)['status'],
        'serving_notice',
      );
    });
  });
}
