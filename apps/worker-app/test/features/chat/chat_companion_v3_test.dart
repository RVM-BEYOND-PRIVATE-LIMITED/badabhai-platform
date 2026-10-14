import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ResumeHistory, ResumeHistoryItem;
import 'package:badabhai_worker_app/features/chat/domain/chat_news_link.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_companion_v3_keys.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_download.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_args.dart';
import 'package:badabhai_worker_app/router.dart';

class MockChatRepository extends Mock implements ChatRepository {}

class MockResumeRepository extends Mock implements ResumeRepository {}

const String _resumeId = '22222222-2222-4222-8222-222222222222';

ResumeHistory _rendered() => const ResumeHistory(
      items: <ResumeHistoryItem>[
        ResumeHistoryItem(
          resumeId: _resumeId,
          renderStatus: 'rendered',
          isCurrent: true,
        ),
      ],
    );

/// ── #2276 (ADR-0055): the Bada Bhai chat's two new chips ──────────────────
void main() {
  // NO PARITY PAIR YET, ON PURPOSE. The server's `companion-v3-keys.ts` lands
  // with backend #2279, and the TD144 guard (`worker-app-parity-filter.guard
  // .test.ts`) requires every server file a worker-app test reads to EXIST and
  // to sit in CI's `worker-app-parity` filter. The two key values were checked
  // byte-for-byte against #2279's file; the parity pair and its filter entry go
  // in once that file is on `main`.
  test('the v3 keys are the server literal strings', () {
    expect(kResumeMenuFormCreateKey, 'resume_form_create');
    expect(kCompanionResumeDownloadKey, 'companion_resume_download');
  });

  group('the chips on the real screen', () {
    late MockChatRepository repo;
    Object? tradeFormExtra;

    setUp(() async {
      repo = MockChatRepository();
      tradeFormExtra = null;
      await locator.reset();
      locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
      when(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).thenAnswer(
        (_) async => const ChatTurn(
          reply: 'Naya resume kaise banana chahenge?',
          suggestedOptions: <ChatOption>[
            ChatOption(
              optionKey: kResumeMenuFormCreateKey,
              labelText: 'Form se resume banayein',
            ),
          ],
        ),
      );
    });

    tearDown(() async => locator.reset());

    testWidgets(
        '"Form se resume banayein" opens the FULL form walk and posts nothing',
        (WidgetTester tester) async {
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
            path: Routes.tradeForm,
            builder: (_, GoRouterState state) {
              tradeFormExtra = state.extra;
              return const Scaffold(body: Text('TRADE FORM'));
            },
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'naya resume banana hai');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Form se resume banayein'));
      await tester.pumpAndSettle();

      expect(find.text('TRADE FORM'), findsOneWidget);
      final TradeFormArgs args = tradeFormExtra! as TradeFormArgs;
      expect(args.fromStart, isTrue, reason: 'a new résumé walks every step');
      expect(args.sectionKey, isNull, reason: 'no section filter');
      verify(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).called(1); // only the typed ask — the chip itself is never posted
    });
  });

  group('the download chip', () {
    late MockChatRepository repo;
    late MockResumeRepository resumes;

    setUp(() {
      repo = MockChatRepository();
      resumes = MockResumeRepository();
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
      when(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).thenAnswer((_) async => const ChatTurn(reply: 'Server ka jawab.'));
      when(
        () => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => const ChatTurn(reply: 'Server ka jawab.'));
    });

    Future<void> settle() =>
        Future<void>.delayed(const Duration(milliseconds: 30));

    test('answered ON THE PHONE: local reply + the tile, nothing posted',
        () async {
      when(() => resumes.loadResumeHistory()).thenAnswer((_) async => _rendered());
      final ChatBloc bloc = ChatBloc(repo, resumeRepository: resumes);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      bloc.add(const ChatResumeDownloadChipTapped('Resume download karein'));
      await settle();

      final List<ChatMessage> m = bloc.state.messages;
      expect(m[m.length - 2].text, 'Resume download karein');
      expect(m[m.length - 2].fromWorker, isTrue);
      expect(m.last.text, kChatResumeDownloadReply);
      expect(bloc.state.resumeDownloadTile, isTrue);
      expect(bloc.state.downloadableResumeId, _resumeId);
      verifyNever(() => repo.sendMessage(any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource')));
      verifyNever(() => repo.sendCompanionMessage(any(),
          submissionId: any(named: 'submissionId')));
    });

    test('no résumé after all: the words go to the server, never lost',
        () async {
      when(() => resumes.loadResumeHistory())
          .thenAnswer((_) async => const ResumeHistory(items: <ResumeHistoryItem>[]));
      final ChatBloc bloc = ChatBloc(repo, resumeRepository: resumes);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      bloc.add(const ChatResumeDownloadChipTapped('Resume download karein'));
      await settle();

      expect(bloc.state.resumeDownloadTile, isFalse);
      verify(() => repo.sendMessage('Resume download karein',
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'))).called(1);
    });
  });

  // Item 3 — the companion turn's model lines and news tiles ride the same
  // bubble path as the interview's.
  group('companion turns keep news tiles and the read-aloud rule', () {
    test('news_links are drawn, and read_aloud: false offers no speaker',
        () async {
      final MockChatRepository repo = MockChatRepository();
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
      final ChatTurn turn = ChatTurn(
        reply: 'Aaj ki khabar.',
        companion: true,
        readAloud: false,
        newsLinks: <ChatNewsLink>[
          ChatNewsLink(
            title: 'Manufacturing PMI up',
            url: Uri.parse('https://example.com/a'),
            site: 'example.com',
          ),
        ],
      );
      when(() => repo.openCompanion()).thenAnswer(
        (_) async => const CompanionOpening(CompanionOpenOutcome.companion,
            ChatTurn(reply: 'Namaste.', companion: true)),
      );
      when(() => repo.sendCompanionMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => turn);
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatCompanionStarted());
      await Future<void>.delayed(const Duration(milliseconds: 30));
      bloc.add(const ChatMessageSent('aaj ki khabar'));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      final ChatMessage last = bloc.state.messages.last;
      expect(last.text, 'Aaj ki khabar.');
      expect(last.newsLinks, hasLength(1));
      expect(last.canReadAloud, isFalse, reason: 'model-written: no speaker');
    });
  });
}
