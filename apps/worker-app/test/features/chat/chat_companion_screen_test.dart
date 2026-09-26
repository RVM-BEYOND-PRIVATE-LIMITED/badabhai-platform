import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';
import 'package:badabhai_worker_app/router.dart';

/// ── THE BADA BHAI TAB IN COMPANION MODE (ADR-0044) ──────────────────────────
///
/// Only the `/bada-bhai` tab, only with the Remote Config switch on, asks for
/// the companion. Its chips route on `option_key`:
///   - `companion_job:<id>` opens that job's detail, never posted;
///   - `companion_jobs_tab` switches to the Jobs tab, never posted;
///   - `companion_applied` opens the applied list, never posted;
///   - `companion_resume` / `companion_new_jobs` are answered by the server.
/// The "build my profile" CTA is gone: the profile is already done.
class MockChatRepository extends Mock implements ChatRepository {}

const String _jobId = '11111111-1111-4111-8111-111111111111';
const String _recap = 'Namaste. Aapki profile taiyaar hai. Ab tak yeh hua hai.';

const List<ChatOption> _recapOptions = <ChatOption>[
  ChatOption(optionKey: 'companion_job:$_jobId', labelText: 'CNC Operator — Pune'),
  ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
  ChatOption(optionKey: 'companion_applied', labelText: 'Apni applications dekhein'),
  ChatOption(optionKey: 'companion_resume', labelText: 'Resume badlein'),
];

ChatTurn _companion(String reply, List<ChatOption> options) => ChatTurn(
      reply: reply,
      followups: <String>[for (final ChatOption o in options) o.labelText],
      suggestedOptions: options,
      questionKind: ChatQuestionKind.disambiguate,
      companion: true,
      digestKey: 'k1',
    );

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.openCompanion()).thenAnswer((_) async => _companion(_recap, _recapOptions));
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  void companionSwitch(bool on) => BbRemoteConfig.instance
      .debugSetSnapshot(<String, Object>{BbRemoteConfig.kKeyChatCompanionEnabled: on});

  GoRouter router({bool assistantTab = true}) => GoRouter(
        initialLocation: '/bada-bhai',
        routes: <RouteBase>[
          GoRoute(
            path: '/bada-bhai',
            builder: (_, __) => ChatProfilingScreen(assistantTab: assistantTab),
          ),
          GoRoute(
            path: '${Routes.jobDetail}/:jobId',
            builder: (_, GoRouterState s) {
              final JobDetail d = s.extra! as JobDetail;
              return Scaffold(
                body: Center(
                  child: Text('DETAIL ${s.pathParameters['jobId']} | ${d.title} | ${d.city}'),
                ),
              );
            },
          ),
          GoRoute(
            path: Routes.jobs,
            builder: (_, __) => const Scaffold(body: Center(child: Text('JOBS TAB'))),
          ),
          GoRoute(
            path: Routes.appliedJobs,
            builder: (_, __) => const Scaffold(body: Center(child: Text('APPLIED LIST'))),
          ),
        ],
      );

  Future<void> pumpTab(WidgetTester tester, {bool assistantTab = true}) async {
    tester.view.physicalSize = const Size(400, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router(assistantTab: assistantTab)));
    await tester.pump();
    await tester.pumpAndSettle();
  }

  testWidgets('switch ON: the tab opens on the recap, touches no session, and has no "build my profile" CTA',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    expect(find.text(_recap), findsOneWidget);
    expect(find.text('CNC Operator — Pune'), findsOneWidget);
    expect(find.text(kChatDoneNotReadyLabel), findsNothing);
    verify(() => repo.openCompanion()).called(1);
    verifyNever(() => repo.ensureSession());
  });

  testWidgets('a job chip opens THAT job\'s detail with its title and city, and posts nothing',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    await tester.tap(find.text('CNC Operator — Pune'));
    await tester.pumpAndSettle();

    expect(find.text('DETAIL $_jobId | CNC Operator | Pune'), findsOneWidget);
    verifyNever(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')));
    verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
  });

  testWidgets('"Sabhi jobs dekhein" switches to the Jobs tab, and posts nothing', (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    await tester.tap(find.text('Sabhi jobs dekhein'));
    await tester.pumpAndSettle();

    expect(find.text('JOBS TAB'), findsOneWidget);
    verifyNever(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')));
  });

  testWidgets('"Apni applications dekhein" opens the applied list, and posts nothing',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester);

    await tester.tap(find.text('Apni applications dekhein'));
    await tester.pumpAndSettle();

    expect(find.text('APPLIED LIST'), findsOneWidget);
    verifyNever(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')));
  });

  testWidgets('"Resume badlein" is answered by the server, through the COMPANION route',
      (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
      (_) async => _companion('Aap kya karna chahte hain. Neeche se chunein.', const <ChatOption>[
        ChatOption(optionKey: 'resume_edit', labelText: 'Apna resume edit karein'),
        ChatOption(optionKey: 'resume_redo', labelText: 'Apna resume dobara banayein'),
      ]),
    );
    await pumpTab(tester);

    await tester.tap(find.text('Resume badlein'));
    await tester.pumpAndSettle();

    verify(() => repo.sendCompanionMessage('Resume badlein', submissionId: any(named: 'submissionId')))
        .called(1);
    verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
    expect(find.text('Apna resume edit karein'), findsOneWidget);
  });

  testWidgets('switch OFF (the default): today\'s tab — no companion call, the session opens, the CTA is there',
      (WidgetTester tester) async {
    await pumpTab(tester);

    verifyNever(() => repo.openCompanion());
    verify(() => repo.ensureSession()).called(1);
    expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
  });

  testWidgets('switch ON but not the Bada Bhai tab (the /chat route): today\'s chat, no companion call',
      (WidgetTester tester) async {
    companionSwitch(true);
    await pumpTab(tester, assistantTab: false);

    verifyNever(() => repo.openCompanion());
    verify(() => repo.ensureSession()).called(1);
  });

  testWidgets('not a companion worker (null): today\'s tab, CTA included', (WidgetTester tester) async {
    companionSwitch(true);
    when(() => repo.openCompanion()).thenAnswer((_) async => null);
    await pumpTab(tester);

    verify(() => repo.ensureSession()).called(1);
    expect(find.text(_recap), findsNothing);
    expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
  });
}
