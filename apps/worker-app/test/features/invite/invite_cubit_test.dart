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

  group('whatsAppShareUri', () {
    test('is the contact-picker form — no phone number in the path', () {
      final Uri uri = whatsAppShareUri('aaiye https://app.badabhai.in/i/abc');
      expect(uri.scheme, 'https');
      expect(uri.host, 'wa.me');
      // A number here would open a chat with THAT number instead of letting the
      // worker choose who to invite.
      expect(uri.path, '/');
      expect(uri.queryParameters['text'], 'aaiye https://app.badabhai.in/i/abc');
    });

    test('percent-encodes so the link survives the query string', () {
      final Uri uri = whatsAppShareUri('a&b#c?d https://x.test/i/1');
      expect(uri.queryParameters['text'], 'a&b#c?d https://x.test/i/1');
      expect(uri.toString(), contains('%26'));
    });

    test('does not mangle Devanagari', () {
      final Uri uri = whatsAppShareUri('नौकरी https://x.test/i/1');
      expect(uri.queryParameters['text'], 'नौकरी https://x.test/i/1');
    });
  });

  group('shareInviteOnWhatsApp', () {
    test('launches wa.me carrying the invite link, and does NOT open the sheet',
        () async {
      when(() => repo.createInvite(campaign: any(named: 'campaign')))
          .thenAnswer((_) async => _link);
      Uri? launched;
      bool sheetOpened = false;
      final InviteCubit cubit = InviteCubit(
        repo,
        share: (_) async => sheetOpened = true,
        launch: (Uri url) async {
          launched = url;
          return true;
        },
      );

      await cubit.load();
      await cubit.shareInviteOnWhatsApp();

      expect(launched?.host, 'wa.me');
      expect(
        launched?.queryParameters['text'],
        contains('https://app.badabhai.in/i/abc'),
      );
      // The button used to call the generic sheet — the label promised WhatsApp
      // and the code did not deliver. This is the assertion that pins the fix.
      expect(sheetOpened, isFalse);
    });

    test('FALLS BACK to the share sheet when WhatsApp cannot be opened',
        () async {
      when(() => repo.createInvite(campaign: any(named: 'campaign')))
          .thenAnswer((_) async => _link);
      String? shared;
      final InviteCubit cubit = InviteCubit(
        repo,
        share: (String text) async => shared = text,
        launch: (_) async => false,
      );

      await cubit.load();
      await cubit.shareInviteOnWhatsApp();

      expect(shared, contains('https://app.badabhai.in/i/abc'));
    });

    test('falls back when the launcher THROWS, not just when it returns false',
        () async {
      when(() => repo.createInvite(campaign: any(named: 'campaign')))
          .thenAnswer((_) async => _link);
      String? shared;
      final InviteCubit cubit = InviteCubit(
        repo,
        share: (String text) async => shared = text,
        // launchUrl raises MissingPluginException/PlatformException in the wild.
        launch: (_) async => throw Exception('no activity found'),
      );

      await cubit.load();
      await cubit.shareInviteOnWhatsApp();

      expect(shared, contains('https://app.badabhai.in/i/abc'));
    });

    test('before load is a no-op — neither WhatsApp nor the sheet opens',
        () async {
      bool any = false;
      final InviteCubit cubit = InviteCubit(
        repo,
        share: (_) async => any = true,
        launch: (_) async {
          any = true;
          return true;
        },
      );

      await cubit.shareInviteOnWhatsApp();

      expect(any, isFalse);
    });
  });

  group('copyInviteLink', () {
    test('copies the RAW URL, not the wrapped share message', () async {
      when(() => repo.createInvite(campaign: any(named: 'campaign')))
          .thenAnswer((_) async => _link);
      String? copied;
      final InviteCubit cubit = InviteCubit(
        repo,
        share: (_) async {},
        copy: (String text) async => copied = text,
      );

      await cubit.load();
      expect(await cubit.copyInviteLink(), isTrue);

      // Exactly the url — a worker pasting into a half-written message does not
      // want our paragraph in the middle of their sentence.
      expect(copied, 'https://app.badabhai.in/i/abc');
    });

    test('reports false when the clipboard refuses, so the UI can stay honest',
        () async {
      when(() => repo.createInvite(campaign: any(named: 'campaign')))
          .thenAnswer((_) async => _link);
      final InviteCubit cubit = InviteCubit(
        repo,
        share: (_) async {},
        copy: (_) async => throw Exception('clipboard unavailable'),
      );

      await cubit.load();
      expect(await cubit.copyInviteLink(), isFalse);
    });

    test('before load returns false and copies nothing', () async {
      bool called = false;
      final InviteCubit cubit = InviteCubit(
        repo,
        share: (_) async {},
        copy: (_) async => called = true,
      );

      expect(await cubit.copyInviteLink(), isFalse);
      expect(called, isFalse);
    });
  });
}
