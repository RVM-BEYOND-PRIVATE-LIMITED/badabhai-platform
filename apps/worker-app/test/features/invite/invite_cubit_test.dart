import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/invite/domain/invite_repository.dart';
import 'package:badabhai_worker_app/features/invite/presentation/cubit/invite_cubit.dart';

class MockInviteRepository extends Mock implements InviteRepository {}

const InviteLink _link =
    InviteLink(code: 'abc', url: 'https://app.badabhai.in/i/abc');

void main() {
  late MockInviteRepository repo;
  setUp(() => repo = MockInviteRepository());

  blocTest<InviteCubit, InviteState>(
    'load -> loading then ready with the composed link',
    build: () {
      when(() => repo.createInvite(campaign: any(named: 'campaign')))
          .thenAnswer((_) async => _link);
      return InviteCubit(repo, share: (_) async {});
    },
    act: (InviteCubit c) => c.load(),
    expect: () => const <InviteState>[
      InviteState(status: InviteStatus.loading),
      InviteState(status: InviteStatus.ready, link: _link),
    ],
  );

  blocTest<InviteCubit, InviteState>(
    'load failure -> error',
    build: () {
      when(() => repo.createInvite(campaign: any(named: 'campaign')))
          .thenThrow(const NetworkFailure());
      return InviteCubit(repo, share: (_) async {});
    },
    act: (InviteCubit c) => c.load(),
    expect: () => <Matcher>[
      isA<InviteState>()
          .having((InviteState s) => s.status, 'status', InviteStatus.loading),
      isA<InviteState>()
          .having((InviteState s) => s.status, 'status', InviteStatus.error)
          .having((InviteState s) => s.failure, 'failure', isA<NetworkFailure>()),
    ],
  );

  test('shareInvite hands the URL to the injected share fn', () async {
    String? shared;
    when(() => repo.createInvite(campaign: any(named: 'campaign')))
        .thenAnswer((_) async => _link);
    final InviteCubit cubit =
        InviteCubit(repo, share: (String text) async => shared = text);

    await cubit.load();
    await cubit.shareInvite();

    expect(shared, isNotNull);
    expect(shared, contains('https://app.badabhai.in/i/abc'));
  });

  test('shareInvite before load is a no-op (nothing shared)', () async {
    bool called = false;
    final InviteCubit cubit =
        InviteCubit(repo, share: (_) async => called = true);

    await cubit.shareInvite();

    expect(called, isFalse);
  });
}
