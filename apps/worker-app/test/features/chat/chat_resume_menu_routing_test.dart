import 'dart:typed_data';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document_picker.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_upload_intent.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_screen.dart';
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
///      - `section_technical_skills` + `section_availability_salary` +
///        `section_work_history` open their filtered trade-form walks (never
///        submitted); every OTHER `section_*` opens the Resume tab's Edit
///        (never submitted) until its own walk lands;
///      - `resume_chat_create` mints a NEW session and resets the transcript.
class MockChatRepository extends Mock implements ChatRepository {}

class _FakePicker implements ResumeDocumentPicker {
  @override
  Future<ResumePickResult> pickResume() async => ResumePickResult.picked(
        PickedResumeDocument(
          kind: ResumeDocumentKind.pdf,
          bytes: Uint8List(1024),
        ),
      );
}

class _FakeImporter implements ResumeImporter {
  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument document) async =>
      const ResumeImportRoutedToChat();
}

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
      optionKey: 'section_availability_salary',
      labelText: 'Availability, Terms & Salary'),
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
          // "Chat se resume banayein" is the only dispatcher of this event, so
          // the session it mints is a résumé RE-DO: its form opens from the
          // first question with nothing selected.
          redoSession: true,
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

    /// What the upload route was pushed with — the marker decides whether the
    /// screen asks again and where a completed import lands.
    Object? uploadExtra;

    setUp(() async {
      uploadExtra = null;
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
              builder: (_, GoRouterState state) {
                uploadExtra = state.extra;
                return const Scaffold(
                  body: Center(child: Text('UPLOAD TARGET')),
                );
              },
            ),
            GoRoute(
              path: Routes.resumeEdit,
              builder: (_, GoRouterState s) => Scaffold(
                body: Center(child: Text('EDIT TARGET ${s.extra}')),
              ),
            ),
            GoRoute(
              path: Routes.tradeForm,
              builder: (_, GoRouterState s) => Scaffold(
                body: Center(child: Text('SECTION FORM TARGET ${s.extra}')),
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
      expect(find.text('Availability, Terms & Salary'), findsOneWidget);
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
      // Not the name-intake prompt (its client-only `no_resume` chip is absent
      // here), so the screen must auto-open the picker instead of drawing the
      // doors a second time — and must pop back to this tab, not `go` to it.
      expect(uploadExtra, isA<ResumeUploadChatIntent>());
      expect(uploadExtra, isNot(isA<ResumeUploadAutoIntent>()));
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

    testWidgets(
        'Technical Skills opens its filtered trade-form walk, never submitted',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_editReply, _sectionOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      await tester.tap(find.text('Technical Skills'));
      await tester.pumpAndSettle();

      expect(
          find.text('SECTION FORM TARGET section_technical_skills'),
          findsOneWidget);
      verifyNever(() => repo.sendMessage('Technical Skills',
          submissionId: any(named: 'submissionId')));
    });

    testWidgets(
        'Availability, Terms & Salary opens its filtered trade-form walk, never submitted',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_editReply, _sectionOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      await tester.tap(find.text('Availability, Terms & Salary'));
      await tester.pumpAndSettle();

      expect(
          find.text('SECTION FORM TARGET section_availability_salary'),
          findsOneWidget);
      verifyNever(() => repo.sendMessage('Availability, Terms & Salary',
          submissionId: any(named: 'submissionId')));
    });

    testWidgets(
        'Work History opens its filtered trade-form walk, never submitted',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_editReply, _sectionOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      await tester.tap(find.text('Work History'));
      await tester.pumpAndSettle();

      expect(
          find.text('SECTION FORM TARGET section_work_history'), findsOneWidget);
      verifyNever(() => repo.sendMessage('Work History',
          submissionId: any(named: 'submissionId')));
    });

    testWidgets(
        'Education & Certifications opens its filtered trade-form walk, never submitted',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _turn(_editReply, _sectionOptions));
      await pumpChat(tester);
      await triggerMenu(tester);

      await tester.tap(find.text('Education & Certifications'));
      await tester.pumpAndSettle();

      expect(
          find.text('SECTION FORM TARGET section_education'), findsOneWidget);
      verifyNever(() => repo.sendMessage('Education & Certifications',
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

    // The upload was PUSHED on this tab, so returning to it does not change
    // `TabFocus` and `_CompanionRefocus` never runs. The screen pops (never
    // `go`), and the chat's push continuation must do what a refocus would:
    // re-read the companion so the parsed-résumé turn shows on the same visit.
    testWidgets('a returned upload shows the parsed resume as a chat message', (
      WidgetTester tester,
    ) async {
      BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
        BbRemoteConfig.kKeyChatCompanionEnabled: true,
      });
      addTearDown(BbRemoteConfig.instance.debugReset);

      const ChatTurn recap = ChatTurn(
        reply: 'Aapka resume tayyar hai.',
        suggestedOptions: <ChatOption>[
          ChatOption(
            optionKey: kResumeMenuUploadKey,
            labelText: 'Resume upload karein',
          ),
        ],
        questionKind: ChatQuestionKind.disambiguate,
        companion: true,
        digestKey: 'k1',
      );
      when(() => repo.openCompanion()).thenAnswer(
        (_) async => const CompanionOpening(
          CompanionOpenOutcome.companion,
          recap,
        ),
      );
      // The OLD, ended session's transcript must not survive the re-open:
      // appending it after the confirm is what pushed the chips away from the
      // parsed information in the reported screenshot.
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Purana chat message', fromWorker: false),
        ],
      );
      when(() => repo.reopenSessionForResumeImport()).thenAnswer(
        (_) async => const ChatSessionOpening(
          text: 'Resume se ye mila: Fitter, 3 saal. Kya ye aap hi hain?',
          resumePending: true,
          options: <ChatOption>[
            ChatOption(
              optionKey: 'resume_identity_yes',
              labelText: 'Haan, ye main hoon',
            ),
            ChatOption(
              optionKey: 'resume_identity_no',
              labelText: 'Nahi, ye main nahi hoon',
            ),
          ],
        ),
      );
      locator.registerLazySingleton<ResumeDocumentPicker>(_FakePicker.new);
      locator.registerLazySingleton<ResumeImporter>(_FakeImporter.new);

      final GoRouter router = GoRouter(
        initialLocation: Routes.badaBhai,
        routes: <RouteBase>[
          GoRoute(
            path: Routes.badaBhai,
            builder: (_, __) => const ChatProfilingScreen(assistantTab: true),
          ),
          GoRoute(
            path: Routes.resumeUpload,
            builder: (_, GoRouterState state) => ResumeUploadScreen(
              autoUpload: state.extra is ResumeUploadAutoIntent,
              directUpload: state.extra is ResumeUploadDirectIntent,
              chatMenuUpload: state.extra is ResumeUploadChatIntent,
            ),
          ),
        ],
      );
      addTearDown(router.dispose);
      tester.view.physicalSize = const Size(400, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();
      expect(find.text('Resume upload karein'), findsOneWidget);

      await tester.tap(find.text('Resume upload karein'));
      await tester.pumpAndSettle();

      expect(find.byType(ChatProfilingScreen), findsOneWidget);
      expect(find.byType(ResumeUploadScreen), findsNothing);
      expect(
        router.routerDelegate.currentConfiguration.lastOrNull?.matchedLocation,
        Routes.badaBhai,
      );
      // The parsed-résumé confirm is now the chat's message, on the SAME visit,
      // with its chips directly beneath it.
      expect(
        find.text('Resume se ye mila: Fitter, 3 saal. Kya ye aap hi hain?'),
        findsOneWidget,
      );
      expect(find.text('Haan, ye main hoon'), findsOneWidget);
      expect(find.text('Nahi, ye main nahi hoon'), findsOneWidget);
      // The old ended session's bubbles are gone — they used to be appended
      // after the confirm, leaving the chips at the bottom of the old chat.
      expect(find.text('Purana chat message'), findsNothing);
      // Served by POST /chat/session, not by the client-side resume shortcut
      // that would have redrawn the old, ended session.
      verify(() => repo.reopenSessionForResumeImport()).called(1);
    });
  });
}
