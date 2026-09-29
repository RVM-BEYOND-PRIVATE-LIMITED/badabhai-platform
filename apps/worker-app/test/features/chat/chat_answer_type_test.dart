// #1559 / #1583 — the Bada Bhai chat honours the server's `answer_type`.
//
// The server has sent `answer_type` on every chat turn since #1292 and the
// client ignored it, so: a multi-select (languages, work types, secondary
// occupations) recorded ONE choice per tap; a boolean question
// (willing_to_travel) — served with ZERO options — offered no Haan / Nahi; and a
// number question (commute km, notice days, training year) opened the text
// keyboard. This pins the whole chain: JSON -> ChatReply -> ChatTurn ->
// ChatState (turn-scoped) -> the chips, the "Ho gaya" send, the quick replies
// and the keypad — and that an absent/unknown type is exactly today's chat.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

// Re-exports the api_models DTOs (ChatAnswerType, ChatOption, ChatReply, …).
import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_multi_select.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// qp_universal@4 `languages`, trimmed to three chips.
const List<ChatOption> kLanguages = <ChatOption>[
  ChatOption(optionKey: 'hindi', labelText: 'Hindi'),
  ChatOption(optionKey: 'marathi', labelText: 'Marathi'),
  ChatOption(optionKey: 'bengali', labelText: 'Bengali'),
];

const ChatTurn kLanguagesTurn = ChatTurn(
  reply: 'Aap kaun kaun si bhasha bolte hain?',
  followups: <String>['Hindi', 'Marathi', 'Bengali'],
  suggestedOptions: kLanguages,
  answerType: ChatAnswerType.multiSelect,
  askedQuestionId: 'languages',
);

/// qp_universal@4 `willing_to_travel`: boolean with ZERO options.
const ChatTurn kTravelTurn = ChatTurn(
  reply: 'Kya aap ghar se door kaam ke liye ja sakte hain?',
  answerType: ChatAnswerType.boolean,
  askedQuestionId: 'willing_to_travel',
);

/// qp_universal@4 `commute_max_km`: number, no options.
const ChatTurn kCommuteTurn = ChatTurn(
  reply: 'Kaam ke liye aap kitne km tak ja sakte hain?',
  answerType: ChatAnswerType.number,
  askedQuestionId: 'commute_max_km',
);

void main() {
  // ------------------------------------------------------------ wire parsing

  group('ChatAnswerType.parse', () {
    test('maps the five contract values', () {
      expect(ChatAnswerType.parse('text'), ChatAnswerType.text);
      expect(ChatAnswerType.parse('number'), ChatAnswerType.number);
      expect(ChatAnswerType.parse('boolean'), ChatAnswerType.boolean);
      expect(ChatAnswerType.parse('single_select'), ChatAnswerType.singleSelect);
      expect(ChatAnswerType.parse('multi_select'), ChatAnswerType.multiSelect);
    });

    test('null, unknown and non-string values read as null (today)', () {
      for (final Object? raw in <Object?>[
        null,
        '',
        'city', // DB-only, aliased server-side before the wire
        'duration',
        'MULTI_SELECT',
        1,
        true,
        <String, dynamic>{},
      ]) {
        expect(ChatAnswerType.parse(raw), isNull, reason: 'raw: $raw');
      }
    });
  });

  group('ChatReply.fromJson answer_type', () {
    test('reads the top-level key', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aap kaun kaun si bhasha bolte hain?',
        'answer_type': 'multi_select',
      });
      expect(reply.answerType, ChatAnswerType.multiSelect);
    });

    test('absent key -> null (an older API build)', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Aur bataiye.'});
      expect(reply.answerType, isNull);
    });

    test('explicit null -> null (nothing pack-shaped on screen)', () {
      final ChatReply reply = ChatReply.fromJson(
          <String, dynamic>{'reply': 'Dhanyavaad.', 'answer_type': null});
      expect(reply.answerType, isNull);
    });

    test('a garbage value never costs the reply (#371)', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Bada bhai ka jawaab',
        'answer_type': 42,
      });
      expect(reply.reply, 'Bada bhai ka jawaab');
      expect(reply.answerType, isNull);
    });
  });

  test('ChatRepositoryImpl.sendMessage carries answer_type to the turn',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'reply': 'Kya aap ghar se door kaam ke liye ja sakte hain?',
                'answer_type': 'boolean',
                'suggested_followups': <String>[],
                'suggested_options': <dynamic>[],
              }),
              201,
            )),
      ),
      session,
    );

    final ChatTurn turn = await repo.sendMessage('20 km');
    expect(turn.answerType, ChatAnswerType.boolean);
  });

  // ------------------------------------------------------- the joined answer

  group('chatMultiSelectAnswer', () {
    test('joins the ticked LABELS in tick order', () {
      expect(
        chatMultiSelectAnswer(
          options: kLanguages,
          tickedKeys: <String>['marathi', 'hindi'],
        ),
        'Marathi, Hindi',
      );
    });

    test('one tick is exactly the chip label (the server\'s chip match)', () {
      expect(
        chatMultiSelectAnswer(options: kLanguages, tickedKeys: <String>['hindi']),
        'Hindi',
      );
    });

    test('nothing ticked, or only unknown keys -> empty (nothing to send)', () {
      expect(
        chatMultiSelectAnswer(options: kLanguages, tickedKeys: <String>[]),
        '',
      );
      expect(
        chatMultiSelectAnswer(options: kLanguages, tickedKeys: <String>['urdu']),
        '',
      );
    });
  });

  // -------------------------------------------------------------------- bloc

  group('ChatState.answerType is TURN-SCOPED', () {
    late MockChatRepository repo;
    setUp(() {
      repo = MockChatRepository();
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
    });

    test('set from the reply, cleared on the next send, then set again',
        () async {
      final Completer<ChatTurn> second = Completer<ChatTurn>();
      int calls = 0;
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) {
        calls++;
        return calls == 1 ? Future<ChatTurn>.value(kCommuteTurn) : second.future;
      });
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      expect(bloc.state.answerType, isNull, reason: 'nothing asked yet');
      bloc.add(const ChatMessageSent('Mahine ka'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, ChatAnswerType.number);

      bloc.add(const ChatMessageSent('20 km'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, isNull,
          reason: 'the keypad must not outlive the question it was for');

      second.complete(const ChatTurn(reply: 'Aapne kaunsi training ki hai?'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, isNull,
          reason: 'a turn without answer_type is today\'s rendering');
    });

    test('the optimistic prediction brings its own answer shape', () async {
      final Completer<ChatTurn> second = Completer<ChatTurn>();
      int calls = 0;
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) {
        calls++;
        if (calls == 1) {
          return Future<ChatTurn>.value(const ChatTurn(
            reply: 'Aap din ki shift chahte hain ya raat ki?',
            suggestedOptions: <ChatOption>[
              ChatOption(optionKey: 'day', labelText: 'Din ki shift'),
            ],
            answerType: ChatAnswerType.singleSelect,
            lookahead: <String, PredictedQuestion?>{
              'day': PredictedQuestion(
                questionKey: 'languages',
                promptText: 'Aap kaun kaun si bhasha bolte hain?',
                answerType: 'multi_select',
                options: <String>['Hindi', 'Marathi'],
              ),
            },
          ));
        }
        return second.future;
      });
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('Welder hoon'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, ChatAnswerType.singleSelect);

      bloc.add(const ChatMessageSent(
        'Din ki shift',
        optionKey: 'day',
        servedOption: true,
      ));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.predictedQuestionKey, 'languages');
      expect(bloc.state.answerType, ChatAnswerType.multiSelect,
          reason: 'the predicted multi-select renders as one on the tap');
      expect(bloc.state.followups, <String>['Hindi', 'Marathi']);

      second.complete(kLanguagesTurn);
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, ChatAnswerType.multiSelect);
      expect(bloc.state.predictedQuestionKey, isNull);
    });

    test('a voice merge clears it', () async {
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => kTravelTurn);
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('20 km'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, ChatAnswerType.boolean);

      bloc.add(const ChatVoiceMerged(transcript: 'haan ji', reply: 'Theek hai.'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, isNull);
    });

    test('a failed send leaves none; the retried reply brings its own',
        () async {
      int calls = 0;
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        return kCommuteTurn;
      });
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('haan'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, isNull);

      bloc.add(const ChatRetryRequested(1)); // the failed bubble, after the opener
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.answerType, ChatAnswerType.number);
    });
  });

  // ------------------------------------------------------------------ screen

  group('the chat screen draws the answer type', () {
    late MockChatRepository repo;

    setUp(() async {
      repo = MockChatRepository();
      await locator.reset();
      locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
    });

    tearDown(() async => locator.reset());

    /// The first send returns [first]; every later one an ordinary turn.
    void replies(ChatTurn first) {
      int calls = 0;
      when(() =>
              repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        calls++;
        return calls == 1 ? first : const ChatTurn(reply: 'Aur bataiye.');
      });
    }

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
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();
      await tester.pumpAndSettle();
    }

    Future<void> type(WidgetTester tester, String text) async {
      await tester.enterText(find.byType(TextField), text);
      await tester.pump(); // composer switches Mic→Send once there is text
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();
    }

    VoidCallback? doneAction(WidgetTester tester) => tester
        .widget<BbButton>(
            find.widgetWithText(BbButton, kChatMultiSelectDoneLabel))
        .onPressed;

    void verifySentOnce(String text) => verify(() =>
            repo.sendMessage(text, submissionId: any(named: 'submissionId')))
        .called(1);

    void verifyNotSent(String text) => verifyNever(() =>
        repo.sendMessage(text, submissionId: any(named: 'submissionId')));

    testWidgets(
        'multi_select: a chip TICKS instead of sending, and "Ho gaya" sends '
        'every tick as ONE message', (WidgetTester tester) async {
      replies(kLanguagesTurn);
      await pumpChat(tester);
      await type(tester, 'Welder hoon');

      expect(find.text(kChatMultiSelectDoneLabel), findsOneWidget);
      expect(doneAction(tester), isNull, reason: 'nothing ticked yet');

      await tester.tap(find.text('Hindi'));
      await tester.pump();
      verifyNotSent('Hindi');
      expect(doneAction(tester), isNotNull);

      await tester.tap(find.text('Marathi'));
      await tester.pump();
      expect(find.byIcon(Icons.check_rounded), findsNWidgets(2));

      await tester.tap(find.text(kChatMultiSelectDoneLabel));
      await tester.pumpAndSettle();

      verifySentOnce('Hindi, Marathi');
      verifyNotSent('Marathi');
      // The worker's bubble reads like the answer they gave.
      expect(find.text('Hindi, Marathi'), findsOneWidget);
      // The turn moved on: the tick row and its button are gone.
      expect(find.text(kChatMultiSelectDoneLabel), findsNothing);
    });

    testWidgets('multi_select: a second tap unticks', (WidgetTester tester) async {
      replies(kLanguagesTurn);
      await pumpChat(tester);
      await type(tester, 'Welder hoon');

      await tester.tap(find.text('Bengali'));
      await tester.pump();
      await tester.tap(find.text('Hindi'));
      await tester.pump();
      await tester.tap(find.text('Bengali'));
      await tester.pump();

      await tester.tap(find.text(kChatMultiSelectDoneLabel));
      await tester.pumpAndSettle();
      verifySentOnce('Hindi');
    });

    testWidgets(
        'multi_select: "none of these" is exclusive (the voice/trade form rule)',
        (WidgetTester tester) async {
      replies(const ChatTurn(
        reply: 'Aap kaunse tools chalate hain?',
        suggestedOptions: <ChatOption>[
          ChatOption(optionKey: 'drill', labelText: 'Drill machine'),
          ChatOption(optionKey: 'grinder', labelText: 'Grinder'),
          ChatOption(
            optionKey: 'none',
            labelText: 'Inme se koi nahi',
            isNoneOfAbove: true,
          ),
        ],
        answerType: ChatAnswerType.multiSelect,
      ));
      await pumpChat(tester);
      await type(tester, 'Fitter hoon');

      await tester.tap(find.text('Drill machine'));
      await tester.pump();
      await tester.tap(find.text('Inme se koi nahi'));
      await tester.pump();
      expect(find.byIcon(Icons.check_rounded), findsOneWidget,
          reason: 'none-of-above replaced the drill tick');

      await tester.tap(find.text(kChatMultiSelectDoneLabel));
      await tester.pumpAndSettle();
      verifySentOnce('Inme se koi nahi');
    });

    testWidgets('multi_select on label-only chips ticks and sends the same way',
        (WidgetTester tester) async {
      replies(const ChatTurn(
        reply: 'Aap kis tarah ka kaam lena chahte hain?',
        followups: <String>['Permanent', 'Contract', 'Daily wage'],
        answerType: ChatAnswerType.multiSelect,
      ));
      await pumpChat(tester);
      await type(tester, 'Helper hoon');

      await tester.tap(find.text('Contract'));
      await tester.pump();
      await tester.tap(find.text('Permanent'));
      await tester.pump();
      verifyNotSent('Contract');

      await tester.tap(find.text(kChatMultiSelectDoneLabel));
      await tester.pumpAndSettle();
      verifySentOnce('Contract, Permanent');
    });

    testWidgets(
        'single_select keeps one tap = one answer (no tick row, no Ho gaya)',
        (WidgetTester tester) async {
      replies(const ChatTurn(
        reply: 'Aapki salary mahine, din ya saal ke hisaab se hai?',
        suggestedOptions: <ChatOption>[
          ChatOption(optionKey: 'month', labelText: 'Mahine ka'),
          ChatOption(optionKey: 'day', labelText: 'Din ka'),
        ],
        answerType: ChatAnswerType.singleSelect,
      ));
      await pumpChat(tester);
      await type(tester, 'Welder hoon');

      expect(find.text(kChatMultiSelectDoneLabel), findsNothing);
      await tester.tap(find.text('Mahine ka'));
      await tester.pumpAndSettle();
      verifySentOnce('Mahine ka');
    });

    testWidgets(
        'boolean with NO served chips: Haan / Nahi quick replies send the word',
        (WidgetTester tester) async {
      replies(kTravelTurn);
      await pumpChat(tester);
      await type(tester, '20 km');

      expect(find.text('Haan'), findsOneWidget);
      expect(find.text('Nahi'), findsOneWidget);
      // The composer stays: typing "haan ji" still answers.
      expect(find.byType(TextField), findsOneWidget);

      await tester.tap(find.text('Nahi'));
      await tester.pumpAndSettle();
      verifySentOnce('Nahi');
      verifyNotSent('Haan');
      expect(find.text('Haan'), findsNothing, reason: 'the turn moved on');
    });

    testWidgets('boolean WITH served chips: only the server\'s chips',
        (WidgetTester tester) async {
      replies(const ChatTurn(
        reply: 'Kya aap welding kar lete hain?',
        suggestedOptions: <ChatOption>[
          ChatOption(optionKey: 'yes', labelText: 'Haan, kar leta hoon'),
          ChatOption(optionKey: 'no', labelText: 'Nahi'),
        ],
        answerType: ChatAnswerType.boolean,
      ));
      await pumpChat(tester);
      await type(tester, 'Fitter hoon');

      expect(find.text('Haan, kar leta hoon'), findsOneWidget);
      expect(find.text('Nahi'), findsOneWidget, reason: 'no client duplicate');
      expect(find.text('Haan'), findsNothing);
    });

    testWidgets('no answer_type and no chips: nothing new is drawn',
        (WidgetTester tester) async {
      replies(const ChatTurn(reply: 'Aur bataiye.'));
      await pumpChat(tester);
      await type(tester, 'Welder hoon');

      expect(find.text('Haan'), findsNothing);
      expect(find.text(kChatMultiSelectDoneLabel), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField)).keyboardType,
        TextInputType.multiline,
        reason: 'today\'s composer keyboard',
      );
    });

    testWidgets(
        'number: the composer opens a number keypad for THAT turn only',
        (WidgetTester tester) async {
      replies(kCommuteTurn);
      await pumpChat(tester);
      expect(
        tester.widget<TextField>(find.byType(TextField)).keyboardType,
        TextInputType.multiline,
      );

      await type(tester, 'Welder hoon');
      expect(
        tester.widget<TextField>(find.byType(TextField)).keyboardType,
        TextInputType.number,
      );
      // The mic (tap-to-talk) is still offered on the empty field.
      expect(find.byIcon(Icons.mic), findsWidgets);

      await type(tester, '20 km');
      verifySentOnce('20 km');
      expect(
        tester.widget<TextField>(find.byType(TextField)).keyboardType,
        TextInputType.multiline,
        reason: 'reverted on the next turn',
      );
    });
  });
}
