import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind, ResumeHistory, ResumeHistoryItem;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/util/pdf_downloader.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_download.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';

class MockChatRepository extends Mock implements ChatRepository {}

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

const String _resumeId = '33333333-3333-4333-8333-333333333333';
const String _recap = 'Namaste. Aapki profile taiyaar hai.';
const String _ask = 'mujhe mera resume download karna hai';

const List<ChatOption> _recapOptions = <ChatOption>[
  ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
];

ChatTurn _companion(String reply) => ChatTurn(
  reply: reply,
  followups: <String>[for (final ChatOption o in _recapOptions) o.labelText],
  suggestedOptions: _recapOptions,
  questionKind: ChatQuestionKind.disambiguate,
  companion: true,
  digestKey: 'k1',
);

ResumeHistory _history() => const ResumeHistory(
  items: <ResumeHistoryItem>[
    ResumeHistoryItem(
      resumeId: _resumeId,
      renderStatus: 'rendered',
      isCurrent: true,
    ),
  ],
);

/// Owner ask (2026-10-14) — the Bada Bhai TAB's "Resume download" tile, end to
/// end on the screen: offered on open, put away by the next message, brought
/// back by "resume download karna hai" (which is never posted), and a tap saves
/// the PDF without leaving the chat.
void main() {
  const MethodChannel channel = MethodChannel('badabhai.workerapp/downloads');

  late MockChatRepository repo;
  late MockResumeRepository resumes;
  late List<MethodCall> channelCalls;

  setUp(() async {
    repo = MockChatRepository();
    resumes = MockResumeRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(
      () => ChatBloc(repo, resumeRepository: resumes),
    );
    final MockResumeEditRepository edit = MockResumeEditRepository();
    when(() => edit.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Ram Kumar',
        showPhoto: false,
        nightShiftReady: false,
      ),
    );
    locator.registerFactory<ResumeEditRepository>(() => edit);

    when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap)),
    );
    when(
      () => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer((_) async => _companion('Kisi job par dabakar poori jaankari dekhein.'));
    when(() => resumes.loadResumeHistory()).thenAnswer((_) async => _history());
    when(
      () => resumes.resumeDownloadUrlFor(_resumeId),
    ).thenAnswer((_) async => 'mock://downloads/resume/mock-resume-0001.pdf');
    BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
      BbRemoteConfig.kKeyChatCompanionEnabled: true,
    });
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  Future<void> pumpTab(WidgetTester tester, {bool assistantTab = true}) async {
    tester.view.physicalSize = const Size(400, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    channelCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      MethodCall call,
    ) async {
      channelCalls.add(call);
      if (call.method == 'saveToDownloads') {
        final Map<dynamic, dynamic> args = call.arguments as Map<dynamic, dynamic>;
        return <String, Object>{
          'location': 'content://downloads/7',
          'displayName': args['fileName'] as String,
          'public': true,
        };
      }
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null),
    );
    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: GoRouter(
          initialLocation: '/bada-bhai',
          routes: <RouteBase>[
            GoRoute(
              path: '/bada-bhai',
              builder: (_, __) => ChatProfilingScreen(assistantTab: assistantTab),
            ),
          ],
        ),
      ),
    );
    await tester.pump();
    await tester.pumpAndSettle();
  }

  Future<void> send(WidgetTester tester, String text) async {
    await tester.enterText(find.byType(TextField), text);
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
  }

  final Finder tileButton = find.text(kChatResumeDownloadButtonLabel);

  testWidgets('the tab opens with the "Resume download" tile under the recap', (
    WidgetTester tester,
  ) async {
    await pumpTab(tester);

    expect(find.text(_recap), findsOneWidget);
    expect(find.text(kChatResumeDownloadTileText), findsOneWidget);
    expect(tileButton, findsOneWidget);
  });

  testWidgets('no résumé to download: no tile', (WidgetTester tester) async {
    when(() => resumes.loadResumeHistory()).thenAnswer((_) async => ResumeHistory.empty);
    await pumpTab(tester);

    expect(find.text(_recap), findsOneWidget);
    expect(tileButton, findsNothing);
  });

  testWidgets('the onboarding chat (not the tab) never offers it', (
    WidgetTester tester,
  ) async {
    await pumpTab(tester, assistantTab: false);

    expect(tileButton, findsNothing);
    verifyNever(() => resumes.loadResumeHistory());
  });

  testWidgets(
    'the next message puts the tile away; a typed download ask goes to the '
    'server (#2302) and its reply and chip are drawn',
    (WidgetTester tester) async {
      const String serverLine = 'Aapka resume taiyaar hai. Neeche button dabakar download karein.';
      await pumpTab(tester);

      await send(tester, 'naye jobs dikhao');
      expect(tileButton, findsNothing);

      when(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(
          reply: serverLine,
          companion: true,
          suggestedOptions: <ChatOption>[
            ChatOption(optionKey: 'companion_resume_download', labelText: 'Resume download karein'),
          ],
        ),
      );
      await send(tester, _ask);

      expect(find.text(_ask), findsOneWidget);
      expect(find.text(serverLine), findsOneWidget);
      expect(find.text(kChatResumeDownloadReply), findsNothing);
      expect(find.text('Resume download karein'), findsOneWidget);
      verify(
        () => repo.sendCompanionMessage(_ask, submissionId: any(named: 'submissionId')),
      ).called(1);
    },
  );

  testWidgets(
    'tapping "Resume download" saves the PDF into Downloads without leaving the chat',
    (WidgetTester tester) async {
      await pumpTab(tester);

      await tester.tap(tileButton);
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.text(kDownloadCompleteNotice), findsOneWidget);
      verify(() => resumes.resumeDownloadUrlFor(_resumeId)).called(1);
      final MethodCall save = channelCalls.singleWhere(
        (MethodCall c) => c.method == 'saveToDownloads',
      );
      expect(
        (save.arguments as Map<dynamic, dynamic>)['fileName'],
        'RAM_KUMAR_RESUME.pdf',
      );
      // Still on the chat.
      expect(find.text(_recap), findsOneWidget);
    },
  );
}
