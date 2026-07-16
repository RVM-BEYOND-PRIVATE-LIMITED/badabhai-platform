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

  test('a 401 surfaces a typed Failure (real reason, not a silent spinner)',
      () async {
    when(() => api.getProfileSummary(authToken: any(named: 'authToken')))
        .thenThrow(ApiException(401, 'Unauthorized'));

    expect(
      () => ProfileSummaryRepositoryImpl(api, session).summary(),
      throwsA(isA<UnauthorizedFailure>()),
    );
  });
}
