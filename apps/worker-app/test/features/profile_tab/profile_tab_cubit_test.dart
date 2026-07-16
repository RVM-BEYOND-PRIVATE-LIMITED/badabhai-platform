import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/cubit/profile_tab_cubit.dart';

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

class MockApiClient extends Mock implements ApiClient {}

const ProfileSummary _summary = ProfileSummary(
  initials: 'RK',
  displayName: 'Ramesh Kumar',
  tradeLabel: 'CNC Operator',
  city: 'Pune',
  strengthSignals: 7,
);

void main() {
  late MockProfileSummaryRepository repo;
  setUp(() => repo = MockProfileSummaryRepository());

  blocTest<ProfileTabCubit, ProfileTabState>(
    'load -> loading then ready with the summary',
    build: () {
      when(() => repo.summary()).thenAnswer((_) async => _summary);
      return ProfileTabCubit(repo);
    },
    act: (ProfileTabCubit c) => c.load(),
    expect: () => const <ProfileTabState>[
      ProfileTabState(status: ProfileTabStatus.loading),
      ProfileTabState(status: ProfileTabStatus.ready, summary: _summary),
    ],
  );

  blocTest<ProfileTabCubit, ProfileTabState>(
    'load failure -> loading then failed',
    build: () {
      when(() => repo.summary()).thenThrow(const NetworkFailure());
      return ProfileTabCubit(repo);
    },
    act: (ProfileTabCubit c) => c.load(),
    expect: () => const <ProfileTabState>[
      ProfileTabState(status: ProfileTabStatus.loading),
      ProfileTabState(
          status: ProfileTabStatus.failed, failure: NetworkFailure()),
    ],
  );

  group('logout', () {
    late MockApiClient api;
    late SessionRepository session;

    setUp(() {
      api = MockApiClient();
      session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 't1')
        ..setProfile('p1')
        ..setResume('r1');
    });

    test('best-effort: calls logout with the token, then clears the session',
        () async {
      when(() => api.logout(authToken: any(named: 'authToken')))
          .thenAnswer((_) async {});
      final ProfileTabCubit cubit =
          ProfileTabCubit(repo, api: api, session: session);

      await cubit.logout();

      verify(() => api.logout(authToken: 't1')).called(1);
      expect(session.sessionToken, isNull);
      expect(session.workerId, isNull);
      expect(session.profileId, isNull);
      expect(session.resumeId, isNull);
    });

    test('offline-safe: a failed logout still clears the session', () async {
      when(() => api.logout(authToken: any(named: 'authToken')))
          .thenThrow(const NetworkFailure());
      final ProfileTabCubit cubit =
          ProfileTabCubit(repo, api: api, session: session);

      await cubit.logout(); // must not throw

      verify(() => api.logout(authToken: 't1')).called(1);
      expect(session.sessionToken, isNull);
      expect(session.workerId, isNull);
    });

    test('no token: skips the network call but still clears', () async {
      final SessionRepository empty = SessionRepository();
      final ProfileTabCubit cubit =
          ProfileTabCubit(repo, api: api, session: empty);

      await cubit.logout();

      verifyNever(() => api.logout(authToken: any(named: 'authToken')));
      expect(empty.sessionToken, isNull);
    });
  });
}
