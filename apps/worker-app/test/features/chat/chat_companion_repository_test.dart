import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';

/// The recap exactly as `GET /chat/companion` serves it (ADR-0044): the chat
/// reply's own shape minus `session_id`, plus `mode` and `digest_key`.
Map<String, dynamic> _recapJson({String reply = 'Namaste. Aapki profile taiyaar hai.'}) =>
    <String, dynamic>{
      'mode': 'companion',
      'digest_key': '0123456789abcdef',
      'reply': reply,
      'tts_text': 'नमस्ते।',
      'blocked': false,
      'is_mock': false,
      'asked_question_id': null,
      'extraction_ready': false,
      'unanswered_essentials': <String>[],
      'session_ended': false,
      'input_mode': 'text',
      'answer_type': null,
      'progress': null,
      'occupation_label': null,
      'lookahead': null,
      'form_offer': null,
      'resume_update': null,
      'suggested_followups': <String>['Sabhi jobs dekhein', 'Resume badlein'],
      'suggested_options': <Map<String, dynamic>>[
        <String, dynamic>{
          'option_key': 'companion_jobs_tab',
          'label_text': 'Sabhi jobs dekhein',
          'is_none_of_above': false,
        },
        <String, dynamic>{
          'option_key': 'companion_resume',
          'label_text': 'Resume badlein',
          'is_none_of_above': false,
        },
      ],
      'question_kind': 'disambiguate',
    };

/// The global error envelope the API wraps every thrown HttpException in.
String _conflictBody() => jsonEncode(<String, dynamic>{
      'statusCode': 409,
      'error': <String, dynamic>{'mode': 'interview'},
      'requestId': 'r',
      'path': '/chat/companion/message',
      'timestamp': '2026-09-26T10:00:00.000Z',
    });

/// A JSON response the way the API sends it: UTF-8 (the recap carries Devanagari,
/// which the http package's default latin-1 body encoding cannot represent).
http.Response _json(Object body, int status) => http.Response(
      jsonEncode(body),
      status,
      headers: <String, String>{'content-type': 'application/json; charset=utf-8'},
    );

SessionRepository _signedIn() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

void main() {
  group('CompanionOpen.fromJson — fails closed to the interview', () {
    test('a companion recap parses through the chat reply parser', () {
      final CompanionOpen open = CompanionOpen.fromJson(_recapJson());
      expect(open.companion, isTrue);
      expect(open.digestKey, '0123456789abcdef');
      expect(open.turn!.reply, 'Namaste. Aapki profile taiyaar hai.');
      expect(open.turn!.ttsText, 'नमस्ते।');
      expect(
        open.turn!.suggestedOptions.map((ChatOption o) => o.optionKey),
        <String>['companion_jobs_tab', 'companion_resume'],
      );
    });

    test('anything else is the interview: the flag-off answer, a blank or missing reply, an unknown mode', () {
      for (final Map<String, dynamic> json in <Map<String, dynamic>>[
        <String, dynamic>{'mode': 'interview'},
        <String, dynamic>{},
        <String, dynamic>{..._recapJson(), 'reply': '   '},
        <String, dynamic>{..._recapJson()}..remove('reply'),
        <String, dynamic>{..._recapJson(), 'mode': 'COMPANION'},
        <String, dynamic>{..._recapJson(), 'mode': 1},
      ]) {
        expect(CompanionOpen.fromJson(json), CompanionOpen.interview, reason: '$json');
      }
    });

    test('a missing or empty digest key is null, never an empty string', () {
      expect(CompanionOpen.fromJson(<String, dynamic>{..._recapJson(), 'digest_key': ''}).digestKey, isNull);
      expect(CompanionOpen.fromJson(<String, dynamic>{..._recapJson()}..remove('digest_key')).digestKey, isNull);
    });
  });

  group('ChatRepositoryImpl.openCompanion', () {
    test('asks ONLY GET /chat/companion — never /chat/session*, never caches a session id', () async {
      final SessionRepository session = _signedIn();
      final List<String> hit = <String>[];
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hit.add('${req.method} ${req.url.path}');
            return _json(_recapJson(), 200);
          }),
        ),
        session,
      );

      final CompanionOpening opening = await repo.openCompanion();
      final ChatTurn? turn = opening.turn;

      expect(hit, <String>['GET /chat/companion']);
      expect(session.sessionId, isNull);
      expect(turn, isNotNull);
      expect(turn!.companion, isTrue);
      expect(turn.digestKey, '0123456789abcdef');
      expect(turn.reply, 'Namaste. Aapki profile taiyaar hai.');
    });

    test('{mode:"interview"} is null, and is NOT reported — it is an answer, not an error', () async {
      int reported = 0;
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async =>
              _json(<String, dynamic>{'mode': 'interview'}, 200)),
        ),
        _signedIn(),
        reportNonFatal: (Object e, StackTrace s, {required String reason}) => reported++,
      );
      expect((await repo.openCompanion()).outcome, CompanionOpenOutcome.interview);
      expect(reported, 0);
    });

    test('an old server (404) is an ANSWER — today\'s chat, reported once, never retried (#1750)', () async {
      final List<String> reasons = <String>[];
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async => http.Response('{"statusCode":404}', 404)),
        ),
        _signedIn(),
        reportNonFatal: (Object e, StackTrace s, {required String reason}) => reasons.add(reason),
      );
      // The route does not exist on this server, so there is no companion for
      // anyone on it: retrying cannot help, and a retry state would offer the
      // worker a button that can never succeed.
      expect((await repo.openCompanion()).outcome, CompanionOpenOutcome.interview);
      expect(reasons, <String>['chat_companion_open_failed']);
    });

    test('no token: null, and no request is made', () async {
      // Counted, not fail()ed: openCompanion catches everything, so a fail() thrown inside the
      // client would be swallowed and the test could never go red.
      int requests = 0;
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            requests++;
            return _json(_recapJson(), 200);
          }),
        ),
        SessionRepository(),
      );
      expect((await repo.openCompanion()).isUnreachable, isTrue);
      expect(requests, 0);
    });
  });

  group('ChatRepositoryImpl.sendCompanionMessage', () {
    test('posts {text, submission_id} to the companion and returns a companion turn', () async {
      Map<String, dynamic>? body;
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            expect(req.url.path, '/chat/companion/message');
            body = jsonDecode(req.body) as Map<String, dynamic>;
            return _json(_recapJson(reply: 'Ok.'), 201);
          }),
        ),
        _signedIn(),
      );
      final ChatTurn? turn = await repo.sendCompanionMessage('naye jobs', submissionId: 'sub-1');
      expect(body, <String, dynamic>{'text': 'naye jobs', 'submission_id': 'sub-1'});
      expect(turn!.companion, isTrue);
      expect(turn.reply, 'Ok.');
    });

    test('a 409 (the error envelope, mode under `error`) is null — resend down today\'s chat', () async {
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async => http.Response(_conflictBody(), 409)),
        ),
        _signedIn(),
      );
      expect(await repo.sendCompanionMessage('hi'), isNull);
    });

    test('any other failure is a Failure the bloc marks as an undelivered bubble', () async {
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async => http.Response('{"statusCode":500}', 500)),
        ),
        _signedIn(),
      );
      expect(repo.sendCompanionMessage('hi'), throwsA(isA<Failure>()));
    });

    test('a companion turn never ends the cached interview session', () async {
      final SessionRepository session = _signedIn()..setSession('live-1');
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async =>
              _json(<String, dynamic>{..._recapJson(), 'session_ended': true}, 201)),
        ),
        session,
      );
      await repo.sendCompanionMessage('hi');
      expect(session.sessionId, 'live-1');
    });
  });
}
