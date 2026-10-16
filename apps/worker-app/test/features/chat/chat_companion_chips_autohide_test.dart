import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind;
import 'package:badabhai_worker_app/core/config/remote_config.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';

class MockChatRepository extends Mock implements ChatRepository {}

const String _chipA = 'CNC mein aage seekhna';
const String _chipB = 'Doosre skills add kariye';
const String _chipC = 'Pay aur experience';

ChatTurn _companionTurn(String reply, List<String> chips) => ChatTurn(
      reply: reply,
      followups: chips,
      suggestedOptions: <ChatOption>[
        for (final String c in chips) ChatOption(optionKey: 'llm_$c', labelText: c),
      ],
      questionKind: ChatQuestionKind.disambiguate,
      companion: true,
      digestKey: 'k1',
    );

/// ── `issue2.jpeg`: the Bada Bhai tab's chips took the screen for good ──────
///
/// They now show for 15 seconds whenever they appear — a new reply's chips, or
/// the tab coming back into focus — then fold away. Companion mode only.
void main() {
  late MockChatRepository repo;
  late TabFocus tabFocus;

  setUp(() async {
    repo = MockChatRepository();
    tabFocus = TabFocus(TabIndex.chat);
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    locator.registerSingleton<TabFocus>(tabFocus);
    when(() => repo.loadHistory())
        .thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => CompanionOpening(
        CompanionOpenOutcome.companion,
        _companionTurn('Namaste.', <String>[_chipA, _chipB, _chipC]),
      ),
    );
    BbRemoteConfig.instance.debugSetSnapshot(<String, Object>{
      BbRemoteConfig.kKeyChatCompanionEnabled: true,
    });
  });

  tearDown(() async {
    BbRemoteConfig.instance.debugReset();
    await locator.reset();
  });

  Future<void> pumpTab(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      const MaterialApp(home: ChatProfilingScreen(assistantTab: true)),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets('the chips show, then fold away after 15 seconds',
      (WidgetTester tester) async {
    await pumpTab(tester);
    expect(find.text(_chipA), findsOneWidget);

    await tester.pump(const Duration(seconds: 14));
    expect(find.text(_chipA), findsOneWidget, reason: 'still inside 15 s');

    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text(_chipA), findsNothing);
    expect(find.text(_chipB), findsNothing);
    expect(find.text('Namaste.'), findsOneWidget,
        reason: 'only the chips fold — the conversation stays');
    expect(find.byType(TextField), findsOneWidget,
        reason: 'the composer stays');
  });

  testWidgets('coming back to the tab shows them again, for another 15 s',
      (WidgetTester tester) async {
    await pumpTab(tester);
    await tester.pump(const Duration(seconds: 16));
    await tester.pumpAndSettle();
    expect(find.text(_chipA), findsNothing);

    tabFocus.value = TabIndex.jobs; // leave the tab
    await tester.pump();
    tabFocus.value = TabIndex.chat; // and come back
    await tester.pumpAndSettle();
    expect(find.text(_chipA), findsOneWidget);

    await tester.pump(const Duration(seconds: 16));
    await tester.pumpAndSettle();
    expect(find.text(_chipA), findsNothing);
  });

  testWidgets("a new reply's chips get their own 15 s",
      (WidgetTester tester) async {
    when(() => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => _companionTurn(
              'Recession mein bhi skilled kaam milta hai.',
              <String>['Naya chip'],
            ));
    await pumpTab(tester);
    await tester.pump(const Duration(seconds: 16));
    await tester.pumpAndSettle();
    expect(find.text(_chipA), findsNothing);

    await tester.enterText(find.byType(TextField), 'recession aayega?');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(find.text('Naya chip'), findsOneWidget);

    await tester.pump(const Duration(seconds: 16));
    await tester.pumpAndSettle();
    expect(find.text('Naya chip'), findsNothing);
  });

  testWidgets('the INTERVIEW never hides its chips — they are the answers',
      (WidgetTester tester) async {
    // Not a companion: the tab is still running the profiling interview.
    when(() => repo.openCompanion()).thenAnswer(
      (_) async => const CompanionOpening(CompanionOpenOutcome.interview, null),
    );
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.sendMessage(any(),
            submissionId: any(named: 'submissionId'),
            answerSource: any(named: 'answerSource')))
        .thenAnswer((_) async => const ChatTurn(
              reply: 'Kaun si machine?',
              followups: <String>['CNC lathe', 'VMC'],
              suggestedOptions: <ChatOption>[
                ChatOption(optionKey: 'cnc', labelText: 'CNC lathe'),
                ChatOption(optionKey: 'vmc', labelText: 'VMC'),
              ],
            ));
    await pumpTab(tester);
    await tester.enterText(find.byType(TextField), 'fitter');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(find.text('CNC lathe'), findsOneWidget);

    await tester.pump(const Duration(seconds: 30));
    await tester.pumpAndSettle();
    expect(find.text('CNC lathe'), findsOneWidget,
        reason: 'interview answers must never fold away');
  });
}
