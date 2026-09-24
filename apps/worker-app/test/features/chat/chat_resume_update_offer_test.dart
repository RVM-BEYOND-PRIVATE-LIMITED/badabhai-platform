// #1689 — "Aapki nayi jaankari se resume update kar doon?" [Haan] / [Abhi nahi].
//
// On Haan the SERVER does the whole update (extract, auto-confirm, generate)
// and says so with `resume_update: "queued"`. The app's job is the opposite of
// its usual one: do LESS. No profile preview, no confirm screen, and no
// client-side extract/confirm/generate — a call on this path would mint a
// SECOND resume for the same acceptance.
//
// This pins the whole chain: JSON -> ChatReply -> ChatTurn -> ChatState -> the
// navigation, plus the two chips going out as ordinary answers.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class _MockChatRepository extends Mock implements ChatRepository {}

/// The two option keys the offer turn carries. SOURCE OF TRUTH:
/// `apps/api/src/profiling/resume-update-offer.ts` (ADR-0043).
const String kUpdateOfferYesKey = 'update_offer_yes';
const String kUpdateOfferNoKey = 'update_offer_no';

const String kYesLabel = 'Haan';
const String kNoLabel = 'Abhi nahi';

const String kResumeTabMarker = 'RESUME-TAB';
const String kProfilePreviewMarker = 'PROFILE-PREVIEW';

void main() {
  late _MockChatRepository repo;

  setUp(() async {
    repo = _MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
  });

  tearDown(() async => locator.reset());

  // ------------------------------------------------------------------- wire

  group('ChatReply.resume_update — the three server generations', () {
    ChatReply parse(Map<String, dynamic> extra) =>
        ChatReply.fromJson(<String, dynamic>{'reply': 'ok', ...extra});

    test('"queued" is the one value that changes what the app does', () {
      final ChatReply r = parse(<String, dynamic>{'resume_update': 'queued'});
      expect(r.resumeUpdate, 'queued');
      expect(r.resumeUpdateQueued, isTrue);
    });

    test('ABSENT (an older server) reads as not queued', () {
      expect(parse(<String, dynamic>{}).resumeUpdate, isNull);
      expect(parse(<String, dynamic>{}).resumeUpdateQueued, isFalse);
    });

    test(
      'an explicit null (an "Abhi nahi" / any ordinary turn) is not queued',
      () {
        final ChatReply r = parse(<String, dynamic>{'resume_update': null});
        expect(r.resumeUpdateQueued, isFalse);
      },
    );

    test('an UNKNOWN value keeps today\'s flow and never throws', () {
      final ChatReply r = parse(<String, dynamic>{'resume_update': 'started'});
      expect(r.resumeUpdate, 'started');
      expect(r.resumeUpdateQueued, isFalse);
    });

    test('a NON-STRING value is dropped rather than thrown out of the whole '
        'reply (#371)', () {
      final ChatReply r = parse(<String, dynamic>{
        'resume_update': 1,
        'suggested_followups': <dynamic>['a'],
      });
      expect(r.resumeUpdate, isNull);
      expect(r.reply, 'ok', reason: 'the reply itself must survive');
      expect(r.suggestedFollowups, <String>['a']);
    });
  });

  // ------------------------------------------------------------------- bloc

  group('ChatState.resumeUpdateQueued', () {
    test('a queued turn sets it', () async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(
          reply: 'Theek hai! Aapka resume update ho raha hai.',
          resumeUpdate: 'queued',
        ),
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      expect(bloc.state.resumeUpdateQueued, isFalse);
      bloc.add(const ChatMessageSent(kYesLabel));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.resumeUpdateQueued, isTrue);
    });

    test(
      'an "Abhi nahi" turn leaves it false — today\'s flow, untouched',
      () async {
        when(
          () =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
        ).thenAnswer((_) async => const ChatTurn(reply: 'Theek hai.'));
        final ChatBloc bloc = ChatBloc(repo);
        addTearDown(bloc.close);

        bloc.add(const ChatMessageSent(kNoLabel));
        await Future<void>.delayed(const Duration(milliseconds: 50));

        expect(bloc.state.resumeUpdateQueued, isFalse);
      },
    );

    test('an UNKNOWN resume_update value does not queue anything', () async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(reply: 'r', resumeUpdate: 'in_flight'),
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('x'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.resumeUpdateQueued, isFalse);
    });

    test('TURN-SCOPED: a later ordinary turn clears it', () async {
      int calls = 0;
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async {
        calls++;
        return calls == 1
            ? const ChatTurn(reply: 'r1', resumeUpdate: 'queued')
            : const ChatTurn(reply: 'r2');
      });
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('one'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.resumeUpdateQueued, isTrue);

      bloc.add(const ChatMessageSent('two'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.resumeUpdateQueued, isFalse);
    });
  });

  // ------------------------------------------------------------------- keys

  group('the two offer keys are ordinary answers', () {
    test('neither collides with a resume-menu key, nor with the section '
        'prefix', () {
      const List<String> menuKeys = <String>[
        kResumeMenuEditKey,
        kResumeMenuRedoKey,
        kResumeMenuUploadKey,
        kResumeMenuChatCreateKey,
        kResumeMenuTechnicalSkillsKey,
      ];
      expect(menuKeys, isNot(contains(kUpdateOfferYesKey)));
      expect(menuKeys, isNot(contains(kUpdateOfferNoKey)));
      expect(kUpdateOfferYesKey.startsWith(kResumeMenuSectionPrefix), isFalse);
      expect(kUpdateOfferNoKey.startsWith(kResumeMenuSectionPrefix), isFalse);
    });

    test('neither is routed client-side: both go to the server', () {
      expect(
        resumeMenuActionFor(kUpdateOfferYesKey),
        ResumeMenuAction.sendToServer,
      );
      expect(
        resumeMenuActionFor(kUpdateOfferNoKey),
        ResumeMenuAction.sendToServer,
      );
    });
  });

  // ----------------------------------------------------------------- screen

  group('after Haan the worker lands on the Resume tab, not the preview', () {
    Future<void> pumpChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(500, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: Routes.chatProfiling,
        routes: <RouteBase>[
          GoRoute(
            path: Routes.chatProfiling,
            builder: (_, __) => const ChatProfilingScreen(),
          ),
          GoRoute(
            path: Routes.resume,
            builder: (_, __) => const Scaffold(body: Text(kResumeTabMarker)),
          ),
          GoRoute(
            path: Routes.profilePreview,
            builder: (_, __) =>
                const Scaffold(body: Text(kProfilePreviewMarker)),
          ),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();
      await tester.pumpAndSettle();
    }

    Future<void> tapChip(WidgetTester tester, String label) async {
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
    }

    testWidgets('tapping the Haan chip submits the LABEL, never the key', (
      WidgetTester tester,
    ) async {
      final List<String> sent = <String>[];
      // The offer turn, served as the session OPENING so the two chips are on
      // screen to tap. It is an ordinary chips turn — that is the whole point
      // of #1689's first half.
      when(() => repo.ensureSession()).thenAnswer(
        (_) async => const ChatSessionOpening(
          text: 'Aapki nayi jaankari se resume update kar doon?',
          options: <ChatOption>[
            ChatOption(optionKey: kUpdateOfferYesKey, labelText: kYesLabel),
            ChatOption(optionKey: kUpdateOfferNoKey, labelText: kNoLabel),
          ],
        ),
      );
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((Invocation i) async {
        sent.add(i.positionalArguments.first as String);
        return const ChatTurn(reply: 'Theek hai!', resumeUpdate: 'queued');
      });

      await pumpChat(tester);
      await tapChip(tester, kYesLabel);

      expect(sent, <String>[kYesLabel]);
      expect(sent, isNot(contains(kUpdateOfferYesKey)));
    });

    testWidgets('a queued reply goes to the Resume tab and NEVER opens the '
        'profile preview', (WidgetTester tester) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(
          reply: 'Theek hai! Aapka resume update ho raha hai.',
          resumeUpdate: 'queued',
        ),
      );

      await pumpChat(tester);
      await tester.enterText(find.byType(TextField), kYesLabel);
      await tester.pump();
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();

      expect(find.text(kResumeTabMarker), findsOneWidget);
      expect(find.text(kProfilePreviewMarker), findsNothing);
    });

    testWidgets('the queued path makes NO client-side extract / confirm / '
        'generate call — the server already did all three', (
      WidgetTester tester,
    ) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async =>
            const ChatTurn(reply: 'Theek hai!', resumeUpdate: 'queued'),
      );

      await pumpChat(tester);
      await tester.enterText(find.byType(TextField), kYesLabel);
      await tester.pump();
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();

      // The chat repository is the ONLY collaborator this screen has. Nothing
      // beyond the message it already sent may have been asked of it — and the
      // profile-preview route, which is what would mint an extract + confirm,
      // was never opened (asserted above and again here).
      expect(find.text(kProfilePreviewMarker), findsNothing);
      verify(() => repo.ensureSession()).called(1);
      verify(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).called(1);
      // `loadHistory` is the #502 transcript redraw every chat open does; it
      // reads, it never writes. Nothing else was asked of the repository.
      verify(() => repo.loadHistory()).called(greaterThanOrEqualTo(0));
      verifyNoMoreInteractions(repo);
    });

    testWidgets('an ordinary (not queued) turn stays in the chat', (
      WidgetTester tester,
    ) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));

      await pumpChat(tester);
      await tester.enterText(find.byType(TextField), kNoLabel);
      await tester.pump();
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();

      expect(find.text(kResumeTabMarker), findsNothing);
      expect(find.text('Aur bataiye.'), findsOneWidget);
    });
  });
}
