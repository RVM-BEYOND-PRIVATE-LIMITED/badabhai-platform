import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/data/profile_summary_repository_impl.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';

class MockApiClient extends Mock implements ApiClient {}

void main() {
  late MockApiClient api;
  late SessionRepository session;

  setUp(() {
    api = MockApiClient();
    session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 't1');
  });

  test('maps the NAMELESS confirmed summary — name never fabricated, strength '
      'passed through as the raw signal COUNT, bearer from session', () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'confirmed',
              confirmedAt: '2026-06-01T00:00:00.000Z',
              tradeDisplayName: 'CNC Operator',
              canonicalTradeId: 'dom_cnc_machining',
              canonicalRoleId: 'role_cnc_turner_operator',
              city: 'Pune',
              strength: 8,
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();

    // The wire carries no name → displayName/initials stay null (never faked).
    expect(s.displayName, isNull);
    expect(s.initials, isNull);
    expect(s.tradeLabel, 'CNC Operator');
    expect(s.city, 'Pune');
    expect(s.verified, isTrue);
    // WA-4: the raw backend count, NOT divided by a client-side magic target;
    // no denominator on the wire → strengthMax stays null (nothing fabricated).
    expect(s.strengthSignals, 8);
    expect(s.strengthMax, isNull);
    // Worker is derived from the session token, never a param.
    verify(() => api.getProfileSummary(authToken: 't1')).called(1);
  });

  test('unconfirmed / empty profile → not verified, null trade/city, 0 strength',
      () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'none',
              confirmedAt: null,
              tradeDisplayName: null,
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: null,
              strength: 0,
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();

    expect(s.verified, isFalse);
    expect(s.tradeLabel, isNull);
    expect(s.city, isNull);
    expect(s.strengthSignals, 0);
  });

  test('a large signal count passes through UNCLAMPED (it is a count, not a '
      'fraction — nothing here invents a ceiling)', () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'confirmed',
              confirmedAt: '2026-06-01T00:00:00.000Z',
              tradeDisplayName: 'Fitter',
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: null,
              strength: 25,
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();
    expect(s.strengthSignals, 25);
  });

  test('a server-shipped strength_max flows into strengthMax (the WA-4 seam)',
      () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'confirmed',
              confirmedAt: '2026-06-01T00:00:00.000Z',
              tradeDisplayName: 'Fitter',
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: null,
              strength: 6,
              strengthMax: 12,
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();
    expect(s.strengthSignals, 6);
    expect(s.strengthMax, 12);
  });

  test('missing_fields flows through in ORDER (the nudge reads .first); absent '
      '⇒ empty', () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'draft',
              confirmedAt: null,
              tradeDisplayName: 'Fitter',
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: null,
              strength: 3,
              strengthMax: 9,
              missingFields: <String>['skills', 'salary', 'photo'],
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();
    expect(s.missingFields, <String>['skills', 'salary', 'photo']);
    expect(s.missingFields.first, 'skills');
  });

  test('skills / machines / experience years flow through to the domain summary',
      () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'confirmed',
              confirmedAt: '2026-06-01T00:00:00.000Z',
              tradeDisplayName: 'VMC Operator',
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: 'Pune',
              strength: 9,
              skills: <String>['CNC operating', 'GD&T'],
              machines: <String>['VMC'],
              experienceYears: 4,
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();
    expect(s.skills, <String>['CNC operating', 'GD&T']);
    expect(s.machines, <String>['VMC']);
    expect(s.experienceYears, 4.0);
  });

  test('no skills/experience → empty lists + null years (honest empty state)',
      () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'none',
              confirmedAt: null,
              tradeDisplayName: null,
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: null,
              strength: 0,
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();
    expect(s.skills, isEmpty);
    expect(s.machines, isEmpty);
    expect(s.experienceYears, isNull);
  });

  // #1524 — the road that produced the profile flows through; a DTO without a
  // source (the old-server / pre-migration shape) stays null, so the screens
  // keep today's rendering and never guess.
  test('source flows through from the DTO', () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'confirmed',
              confirmedAt: '2026-06-01T00:00:00.000Z',
              tradeDisplayName: 'Welder',
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: null,
              strength: 4,
              source: 'chat',
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();
    expect(s.source, 'chat');
    expect(s.isChatSourced, isTrue);
    expect(s.isFormSourced, isFalse);
  });

  test('an absent source maps to null — today\'s rendering, no crash',
      () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenAnswer((_) async => const ProfileSummaryDto(
              profileStatus: 'confirmed',
              confirmedAt: '2026-06-01T00:00:00.000Z',
              tradeDisplayName: 'Welder',
              canonicalTradeId: null,
              canonicalRoleId: null,
              city: null,
              strength: 4,
            ));

    final ProfileSummary s =
        await ProfileSummaryRepositoryImpl(api, session).summary();
    expect(s.source, isNull);
    expect(s.isChatSourced, isFalse);
    expect(s.isFormSourced, isFalse);
  });

  test('a 401 surfaces a typed Failure (real reason, not a silent spinner)',
      () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenThrow(ApiException(401, 'Unauthorized'));

    expect(
      () => ProfileSummaryRepositoryImpl(api, session).summary(),
      throwsA(isA<UnauthorizedFailure>()),
    );
  });

  group('#1586 attested follows the server badge, never confirmation', () {
    void stubSummary() {
      when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const ProfileSummaryDto(
                profileStatus: 'confirmed',
                confirmedAt: '2026-06-01T00:00:00.000Z',
                tradeDisplayName: 'Fitter',
                canonicalTradeId: null,
                canonicalRoleId: null,
                city: null,
                strength: 4,
              ));
      when(() => api.getWorkPreferences(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const WorkPreferencesDto());
      when(() => api.getWorkPreferenceOptions(
              authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const WorkPrefOptionsDto(
                languages: <String, String>{},
                documentsReady: <String, String>{},
                jobType: <String, String>{},
                shift: <String, String>{},
              ));
      when(() => api.getMyQualifications(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyQualificationsDto());
      when(() => api.getMyOccupations(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyOccupationsDto());
    }

    void stubDocument({String? trustBadge, bool throws = false}) {
      if (throws) {
        when(() => api.getResumeDocument(authToken: any(named: 'authToken')))
            .thenThrow(ApiException(404, 'no resume row'));
        return;
      }
      when(() => api.getResumeDocument(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => ResumeDocumentResponse(
                resumeId: 'r1',
                version: 1,
                document: TradeSheetResumeDocument(
                  header: ResumeDocumentHeaderDto(trustBadge: trustBadge),
                  trade: 'cnc_turner',
                ),
              ));
    }

    test('server label present → summary attested on FIRST paint', () async {
      stubSummary();
      stubDocument(trustBadge: 'BadaBhai Verified');

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session)
              .summary(includeDisplayExtras: true);
      expect(s.verified, isTrue);
      expect(s.attested, isTrue);
    });

    test('null badge → unattested (self-declared, pre-render, unknown)',
        () async {
      stubSummary();
      stubDocument(trustBadge: null);

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session)
              .summary(includeDisplayExtras: true);
      expect(s.attested, isFalse);
    });

    test('document read failure reads as unattested, never throws', () async {
      stubSummary();
      stubDocument(throws: true);

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session)
              .summary(includeDisplayExtras: true);
      expect(s.attested, isFalse);
    });

    test('lean callers never pay for the badge read', () async {
      stubSummary();

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session).summary();
      expect(s.verified, isTrue);
      expect(s.attested, isFalse);
      verifyNever(
          () => api.getResumeDocument(authToken: any(named: 'authToken')));
    });
  });

  group('#1587 v4 facts resolve to printable display values', () {
    void stubSummary() {
      when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const ProfileSummaryDto(
                profileStatus: 'confirmed',
                confirmedAt: '2026-06-01T00:00:00.000Z',
                tradeDisplayName: 'Fitter',
                canonicalTradeId: null,
                canonicalRoleId: null,
                city: null,
                strength: 4,
              ));
      when(() => api.getWorkPreferenceOptions(
              authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const WorkPrefOptionsDto(
                languages: <String, String>{},
                documentsReady: <String, String>{},
                jobType: <String, String>{},
                shift: <String, String>{},
              ));
      when(() => api.getResumeDocument(authToken: any(named: 'authToken')))
          .thenThrow(ApiException(404, 'no resume row'));
    }

    test('commute, travel, period, availability map with labels', () async {
      stubSummary();
      when(() => api.getWorkPreferences(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const WorkPreferencesDto(
                commuteKm: 20,
                willingToTravel: true,
                salaryPeriod: 'day',
                availability: WorkAvailabilityDto(
                  status: 'serving_notice',
                  availableFrom: '2026-10-01',
                  noticeDays: 15,
                ),
              ));
      when(() => api.getMyQualifications(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyQualificationsDto());
      when(() => api.getMyOccupations(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyOccupationsDto());

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session).summary(includeDisplayExtras: true);
      expect(s.commuteKm, 20);
      expect(s.willingToTravel, isTrue);
      expect(s.salaryPeriod, 'Din');
      expect(s.availabilityStatus, 'Notice period mein');
      expect(s.availableFrom, '2026-10-01');
      expect(s.noticeDays, 15);
    });

    test('trainings compose name · provider · year, dropping absent parts',
        () async {
      stubSummary();
      when(() => api.getWorkPreferences(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const WorkPreferencesDto());
      when(() => api.getMyQualifications(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyQualificationsDto(
                trainings: <TrainingEntryDto>[
                  TrainingEntryDto(
                      name: 'CNC Programming',
                      provider: 'ITI Pune',
                      year: 2019),
                  TrainingEntryDto(name: '  ', provider: null, year: null),
                ],
              ));
      when(() => api.getMyOccupations(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyOccupationsDto());

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session).summary(includeDisplayExtras: true);
      expect(s.trainings, <String>['CNC Programming · ITI Pune · 2019']);
    });

    test('occupations keep server labels; label-less rows are dropped',
        () async {
      stubSummary();
      when(() => api.getWorkPreferences(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const WorkPreferencesDto());
      when(() => api.getMyQualifications(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyQualificationsDto());
      when(() => api.getMyOccupations(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const MyOccupationsDto(
                occupations: <MyOccupationDto>[
                  MyOccupationDto(roleId: 'role_welder', label: 'Welder'),
                  MyOccupationDto(roleId: 'role_nope', label: '   '),
                ],
              ));

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session).summary(includeDisplayExtras: true);
      expect(s.occupations, hasLength(1));
      expect(s.occupations.single.roleId, 'role_welder');
      expect(s.occupations.single.label, 'Welder');
    });

    test('unknown slugs humanise, v4 read failures read as absent', () async {
      stubSummary();
      when(() => api.getWorkPreferences(authToken: any(named: 'authToken')))
          .thenAnswer((_) async => const WorkPreferencesDto(
                salaryPeriod: 'fortnight',
              ));
      when(() => api.getMyQualifications(authToken: any(named: 'authToken')))
          .thenThrow(ApiException(500, 'boom'));
      when(() => api.getMyOccupations(authToken: any(named: 'authToken')))
          .thenThrow(ApiException(500, 'boom'));

      final ProfileSummary s =
          await ProfileSummaryRepositoryImpl(api, session).summary(includeDisplayExtras: true);
      expect(s.salaryPeriod, 'Fortnight');
      expect(s.trainings, isEmpty);
      expect(s.occupations, isEmpty);
      expect(s.commuteKm, isNull);
      expect(s.willingToTravel, isFalse);
    });
  });
}
