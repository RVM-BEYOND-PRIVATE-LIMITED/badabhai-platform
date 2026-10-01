import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_identity_questions.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class _MockChatRepository extends Mock implements ChatRepository {}

/// ADR-0048 (#1864) — THE CHAT ASKS FOR THE WORKER'S NAME NOW.
///
/// `/name` is retired. The chat's opening turn can BE an identity question, and
/// the app has to know that for two reasons: the location questions get the
/// pickers the form had, and an intake open must not be mistaken for a résumé
/// import that produced nothing (#1660).
SessionRepository _signedIn() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

/// Serves [body] for the session POST only. The latest-session GET answers 404
/// so `ensureSession` MINTS rather than resumes — a resumed session carries no
/// opening, which is not the path under test here.
ChatRepositoryImpl _repo(Map<String, dynamic> body) => ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          if (req.method == 'GET') {
            return http.Response(jsonEncode(<String, dynamic>{}), 404);
          }
          return http.Response(
            jsonEncode(body),
            200,
            headers: <String, String>{
              'content-type': 'application/json; charset=utf-8',
            },
          );
        }),
      ),
      _signedIn(),
    );

void main() {
  group('the opening carries its question key', () {
    test('an intake open names the question and its answer type', () async {
      final ChatSessionOpening? opening = await _repo(<String, dynamic>{
        'session_id': 's1',
        'opening_text': 'Aapka pehla naam kya hai?',
        'opening_question_key': 'worker_first_name',
        'opening_answer_type': 'text',
      }).ensureSession();

      expect(opening, isNotNull);
      expect(opening!.questionKey, kChatFirstNameQuestionKey);
      expect(opening.answerType, 'text');
    });

    test('an ordinary open carries neither — every other open is unchanged',
        () async {
      final ChatSessionOpening? opening = await _repo(<String, dynamic>{
        'session_id': 's1',
        'opening_text': 'Aap kaunsa kaam karte hain?',
      }).ensureSession();

      expect(opening!.questionKey, isNull);
      expect(opening.answerType, isNull);
    });

    test('a garbled key is ignored rather than routed on', () async {
      // `text()` drops a non-string and a blank, so a malformed body can never
      // put the app into a picker it cannot fill.
      final ChatSessionOpening? opening = await _repo(<String, dynamic>{
        'session_id': 's1',
        'opening_text': 'Namaste.',
        'opening_question_key': 42,
        'opening_answer_type': '   ',
      }).ensureSession();

      expect(opening!.questionKey, isNull);
      expect(opening.answerType, isNull);
    });
  });

  group('which questions the app treats as identity', () {
    test('the four server keys, and nothing else', () {
      expect(kChatIdentityQuestionKeys, <String>{
        'worker_first_name',
        'worker_last_name',
        'worker_state',
        'worker_city',
      });
    });

    test('only the two LOCATION questions get a picker', () {
      // The name questions are ordinary text turns — the app adds nothing.
      expect(isChatLocationQuestion(kChatStateQuestionKey), isTrue);
      expect(isChatLocationQuestion(kChatCityQuestionKey), isTrue);
      expect(isChatLocationQuestion(kChatFirstNameQuestionKey), isFalse);
      expect(isChatLocationQuestion(kChatLastNameQuestionKey), isFalse);
      expect(isChatLocationQuestion('turning_machine'), isFalse);
      expect(isChatLocationQuestion(null), isFalse);
    });
  });

  // ── ADR-0048 — THE APP CAPTURES THE NAME AS IT IS ENTERED ──────────────────
  //
  // The header shows the worker's name once the intake captures it (and flies
  // it up there). The name is captured CLIENT-side, from the answers to the two
  // name questions, title-cased with the same shared helper the server mirrors.
  group('the bloc captures the worker name', () {
    late _MockChatRepository repo;

    setUp(() {
      repo = _MockChatRepository();
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
    });

    ChatBloc blocOpening(String? questionKey) {
      when(() => repo.ensureSession()).thenAnswer(
        (_) async => ChatSessionOpening(
          text: 'Aapka naam kya hai?',
          questionKey: questionKey,
        ),
      );
      return ChatBloc(repo)..add(const ChatStarted());
    }

    test('a two-word first answer is the WHOLE name — no surname step', () async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async =>
              const ChatTurn(reply: 'Shukriya.', askedQuestionId: null));
      final ChatBloc bloc = blocOpening(kChatFirstNameQuestionKey);
      await pumpEventQueue();

      bloc.add(const ChatMessageSent('ramesh kumar'));
      await pumpEventQueue();

      expect(bloc.state.workerName, 'Ramesh Kumar');
      await bloc.close();
    });

    test('a single-word first name stays UNREVEALED until the surname arrives',
        () async {
      final List<ChatTurn> replies = <ChatTurn>[
        const ChatTurn(
          reply: 'Aur aapka surname?',
          askedQuestionId: kChatLastNameQuestionKey,
        ),
        const ChatTurn(reply: 'Shukriya.', askedQuestionId: null),
      ];
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => replies.removeAt(0));
      final ChatBloc bloc = blocOpening(kChatFirstNameQuestionKey);
      await pumpEventQueue();

      // First name: the server still wants the surname, so NOTHING is revealed
      // (and no flight fires) yet — the whole point of the single reveal.
      bloc.add(const ChatMessageSent('ramesh'));
      await pumpEventQueue();
      expect(bloc.state.workerName, isNull);

      // Surname: the server moves on, and the COMPLETE name is revealed ONCE.
      bloc.add(const ChatMessageSent('kumar'));
      await pumpEventQueue();
      expect(bloc.state.workerName, 'Ramesh Kumar');
      await bloc.close();
    });

    test('an ordinary question captures NOTHING', () async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async =>
              const ChatTurn(reply: 'Achha.', askedQuestionId: null));
      final ChatBloc bloc = blocOpening(null);
      await pumpEventQueue();

      bloc.add(const ChatMessageSent('main cnc operator hoon'));
      await pumpEventQueue();

      expect(bloc.state.workerName, isNull);
      await bloc.close();
    });

    test('a state answer does not capture a name', () async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async =>
              const ChatTurn(reply: 'Theek.', askedQuestionId: null));
      final ChatBloc bloc = blocOpening(kChatStateQuestionKey);
      await pumpEventQueue();

      bloc.add(const ChatMessageSent('Maharashtra'));
      await pumpEventQueue();

      expect(bloc.state.workerName, isNull);
      await bloc.close();
    });
  });
}
