import 'package:bloc_test/bloc_test.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/selection_cards.dart';
import 'package:badabhai_worker_app/router.dart';

/// ── THE POST-COMPLETION RÉSUMÉ MENU (#1566) ─────────────────────────────────
///
/// An ended session serves the menu on `suggested_options` with
/// `question_kind: disambiguate`. The client must:
///   1. draw it as the VERTICAL single-select (2-option and 6-option alike);
///   2. route on `option_key`, never on the label copy:
///      - `resume_edit` / `resume_redo` ask the SERVER for the next menu;
///      - `resume_upload` opens the résumé-import screen (never submitted);
///      - `section_*` opens the Resume tab's Edit (never submitted);
///      - `resume_chat_create` mints a NEW session and resets the transcript.
class MockChatRepository extends Mock implements ChatRepository {}

const String _rootReply = 'Aap kya karna chahte hain. Neeche se chunein.';
const String _redoReply = 'Naya resume kaise banana chahte hain. Neeche se chunein.';
const String _editReply = 'Resume ka kaun sa hissa theek karna hai. Neeche se chunein.';

const List<ChatOption> _rootOptions = <ChatOption>[
  ChatOption(optionKey: kResumeMenuEditKey, labelText: 'Apna resume edit karein'),
  ChatOption(optionKey: kResumeMenuRedoKey, labelText: 'Apna resume dobara banayein'),
];

const List<ChatOption> _redoOptions = <ChatOption>[
  ChatOption(optionKey: kResumeMenuUploadKey, labelText: 'Resume upload karein'),
  ChatOption(optionKey: kResumeMenuChatCreateKey, labelText: 'Chat se resume banayein'),
];

const List<ChatOption> _sectionOptions = <ChatOption>[
  ChatOption(optionKey: 'section_general_info', labelText: 'General Info'),
  ChatOption(optionKey: 'section_technical_skills', labelText: 'Technical Skills'),
  ChatOption(optionKey: 'section_work_history', labelText: 'Work History'),
  ChatOption(
      optionKey: 'section_education', labelText: 'Education & Certifications'),
  ChatOption(optionKey: 'section_location', labelText: 'Location'),
  ChatOption(
      optionKey: 'section_availability_salary', labelText: 'Availability & Salary'),
];

ChatTurn _turn(String reply, List<ChatOption> options) => ChatTurn(
      reply: reply,
      followups: <String>[for (final ChatOption o in options) o.labelText],
      suggestedOptions: options,
      questionKind: ChatQuestionKind.disambiguate,
    );

void main() {
  group('ChatBloc ChatSessionRestarted (#1566)', () {
    late MockChatRepository repo;
    setUp(() {
      repo = MockChatRepository();
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
    });

    blocTest<ChatBloc, ChatState>(
      'resets the transcript and clears every latched turn field',
      build: () {
        when(() => repo.startNewSession()).thenAnswer(
            (_) async => const ChatSessionOpening(text: 'Naya sawaal'));
        return ChatBloc(repo);
      },
      seed: () => const ChatState(
        messages: <ChatMessage>[ChatMessage(text: 'purana', fromWorker: false)],
        initializing: false,
        extractionReady: true,
        occupationLabel: 'welder',
        followups: <String>['purana chip'],
        suggestedOptions: <ChatOption>[
          ChatOption(optionKey: 'x', labelText: 'X'),
        ],
      ),
      act: (ChatBloc b) => b.add(const ChatSessionRestarted()),
      expect: () => const <ChatState>[
        // The whole state is rebuilt: no copyWith means the latched readiness,
        // occupation and chips cannot survive.
        ChatState(messages: <ChatMessage>[kChatOpeningMessage]),
        ChatState(
          messages: <ChatMessage>[ChatMessage(text: 'Naya sawaal', fromWorker: false)],
          initializing: false,
        ),
      ],
      verify: (ChatBloc b) {
        expect(b.state.extractionReady, isFalse);
        expect(b.state.occupationLabel, isNull);
        expect(b.state.followups, isEmpty);
        expect(b.state.suggestedOptions, isEmpty);
      },
    );

    blocTest<ChatBloc, ChatState>(
      'a failed fresh open surfaces the session banner, transcript still reset',
      build: () {
        when(() => repo.startNewSession())
            .thenThrow(const NetworkFailure());
        return ChatBloc(repo);
      },
      seed: () => const ChatState(
        messages: <ChatMessage>[ChatMessage(text: 'purana', fromWorker: false)],
        initializing: false,
      ),
      act: (ChatBloc b) => b.add(const ChatSessionRestarted()),
      expect: () => const <ChatState>[
        ChatState(messages: <ChatMessage>[kChatOpeningMessage]),
        ChatState(
          messages: <ChatMessage>[kChatOpeningMessage],
          initializing: false,
          sessionFailed: true,
        ),
      ],
    );
  });

  group('ChatProfilingScreen menu routing (#1566)', () {
    late MockChatRepository repo;

    setUp(() async {
      repo = MockChatRepository();
      await locator.reset();
      locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
    });

    tearDown(() async => locator.reset());

    GoRouter router() => GoRouter(
          initialLocation: '/bada-bhai',
          routes: <RouteBase>[
            GoRoute(
              path: '/bada-bhai',
              builder: (_, __) => const ChatProfilingScreen(),
            ),
            GoRoute(
              path: Routes.resumeUpload,
              builder: (_, __) => const Scaffold(
                body: Center(child: Text('UPLOAD TARGET')),
              ),
            ),
            GoRoute(
              path: Routes.resumeEdit,
              builder: (_, GoRouterState s) => Scaffold(
                body: Center(child: Text('EDIT TARGET ${s.extra}')),
              ),
            ),
          ],
        );

    Future<void> pumpChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(400, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp.router(routerConfig: router()));
      await tester.pump();
      await tester.pumpAndSettle();
    }

    Future<void> triggerMenu(WidgetTester tester) async {
      await tester.enterText(find.byType(TextField), 'kuch bhi');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
    }

    testWidgets('the 2-option root menu draws as a vertical single-select',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_rootReply, _rootOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      expect(find.byType(SingleSelectQuestionCard), findsNWidgets(2));
      expect(find.text('Apna resume edit karein'), findsOneWidget);
      expect(find.text('Apna resume dobara banayein'), findsOneWidget);
    });

    testWidgets('the 6-option section menu draws as a vertical single-select',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_editReply, _sectionOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      expect(find.byType(SingleSelectQuestionCard), findsNWidgets(6));
      expect(find.text('General Info'), findsOneWidget);
      expect(find.text('Availability & Salary'), findsOneWidget);
    });

    testWidgets('resume_edit is submitted to the server for the next menu',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_rootReply, _rootOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      await tester.tap(find.text('Apna resume edit karein'));
      await tester.pumpAndSettle();

      verify(() => repo.sendMessage('Apna resume edit karein',
          submissionId: any(named: 'submissionId'))).called(1);
    });

    testWidgets('resume_upload opens the import screen and is NOT submitted',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_redoReply, _redoOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      await tester.tap(find.text('Resume upload karein'));
      await tester.pumpAndSettle();

      expect(find.text('UPLOAD TARGET'), findsOneWidget);
      verifyNever(() => repo.sendMessage('Resume upload karein',
          submissionId: any(named: 'submissionId')));
    });

    testWidgets('a section key opens the Resume Edit surface, never submitted',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_editReply, _sectionOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      await tester.tap(find.text('General Info'));
      await tester.pumpAndSettle();

      expect(find.text('EDIT TARGET section_general_info'), findsOneWidget);
      verifyNever(() => repo.sendMessage('General Info',
          submissionId: any(named: 'submissionId')));
    });

    testWidgets('resume_chat_create mints a new session and resets the thread',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_redoReply, _redoOptions));
      when(() => repo.startNewSession()).thenAnswer(
          (_) async => const ChatSessionOpening(text: 'Naya sawaal'));
      await pumpChat(tester);
      await triggerMenu(tester);
      expect(find.text(_redoReply), findsOneWidget);

      await tester.tap(find.text('Chat se resume banayein'));
      await tester.pumpAndSettle();

      verify(() => repo.startNewSession()).called(1);
      expect(find.text('Naya sawaal'), findsOneWidget);
      expect(find.text(_redoReply), findsNothing,
          reason: 'the ended session\'s menu must not survive the new session');
      verifyNever(() => repo.sendMessage('Chat se resume banayein',
          submissionId: any(named: 'submissionId')));
    });
  });
}
