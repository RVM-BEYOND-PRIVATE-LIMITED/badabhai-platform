import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/chat_end_divider.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── #2224: "End of conversation" ──────────────────────────────────────────
///
/// A finished interview used to just stop — the closing bubble looked like any
/// other turn, so a reopened thread read as one still waiting for an answer.
void main() {
  late MockChatRepository repo;

  ChatTurn closing({bool fromClosedSession = false}) => ChatTurn(
        reply: 'Aapki baat poori ho chuki hai.',
        sessionEnded: true,
        isMock: fromClosedSession,
      );

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.loadHistory())
        .thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
  });

  tearDown(() async => locator.reset());

  // ── the bloc keeps WHERE the session ended ────────────────────────────────
  group('ChatState.sessionEndedAfterIndex', () {
    Future<ChatBloc> open() async {
      final ChatBloc bloc = ChatBloc(repo);
      bloc.add(const ChatStarted());
      await Future<void>.delayed(const Duration(milliseconds: 20));
      return bloc;
    }

    test('null mid-interview', () async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => const ChatTurn(reply: 'Aur kya kaam?'));
      final ChatBloc bloc = await open();
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('fitter'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(bloc.state.sessionEndedAfterIndex, isNull);
    });

    test('set to the closing bubble on the turn that ends the session',
        () async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => closing());
      final ChatBloc bloc = await open();
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('fitter'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      final int? at = bloc.state.sessionEndedAfterIndex;
      expect(at, isNotNull);
      expect(at, bloc.state.messages.length - 1);
      expect(bloc.state.messages[at!].fromWorker, isFalse);
      expect(bloc.state.messages[at].text, 'Aapki baat poori ho chuki hai.');
    });

    test('a LATER reply on the closed session leaves the marker where it is',
        () async {
      int call = 0;
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async {
        call++;
        return call == 1
            ? closing()
            // The stateless résumé menu: already-closed, so `is_mock` is true.
            : closing(fromClosedSession: true);
      });
      final ChatBloc bloc = await open();
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('fitter'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      final int? first = bloc.state.sessionEndedAfterIndex;

      bloc.add(const ChatMessageSent('resume'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(bloc.state.sessionEndedAfterIndex, first);
      expect(bloc.state.messages.length, greaterThan(first! + 1),
          reason: 'the later bubbles land BELOW the marker');
    });

    test('cleared by a restart', () async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => closing());
      when(() => repo.startNewSession()).thenAnswer((_) async => null);
      final ChatBloc bloc = await open();
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('fitter'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(bloc.state.sessionEndedAfterIndex, isNotNull);

      bloc.add(const ChatSessionRestarted());
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(bloc.state.sessionEndedAfterIndex, isNull);
    });
  });

  // ── the transcript draws it exactly once, in the right place ──────────────
  group('the marker on the real screen', () {
    Future<void> pump(WidgetTester tester, {Size size = const Size(420, 900), double scale = 1.0}) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(scale)),
          child: const MaterialApp(home: ChatProfilingScreen()),
        ),
      );
      await tester.pumpAndSettle();
    }

    Future<void> answer(WidgetTester tester, String text) async {
      await tester.enterText(find.byType(TextField), text);
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
    }

    testWidgets('absent mid-interview', (WidgetTester tester) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => const ChatTurn(reply: 'Aur kya kaam?'));
      await pump(tester);
      await answer(tester, 'fitter');
      expect(find.byType(ChatEndDivider), findsNothing);
      expect(find.text(kChatEndOfConversationLabel), findsNothing);
    });

    testWidgets('appears ONCE when the closing reply lands',
        (WidgetTester tester) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => closing());
      await pump(tester);
      await answer(tester, 'fitter');

      expect(find.byType(ChatEndDivider), findsOneWidget);
      expect(find.text(kChatEndOfConversationLabel), findsOneWidget);
      // Under the closing bubble, not above it.
      final double label =
          tester.getTopLeft(find.text(kChatEndOfConversationLabel)).dy;
      final double bubble =
          tester.getTopLeft(find.text('Aapki baat poori ho chuki hai.')).dy;
      expect(label, greaterThan(bubble));
    });

    testWidgets('TalkBack reads it once', (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => closing());
      await pump(tester);
      await answer(tester, 'fitter');

      expect(
        find.bySemanticsLabel(kChatEndOfConversationLabel),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('no overflow at 320x568 with text scale 2.0',
        (WidgetTester tester) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => closing());
      await pump(tester, size: const Size(320, 568), scale: 2.0);
      await answer(tester, 'fitter');

      expect(find.byType(ChatEndDivider), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
