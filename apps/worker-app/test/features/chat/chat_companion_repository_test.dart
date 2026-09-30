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

  // ── ADR-0046 §5.1 — THE EDIT CARD'S WIRE SHAPE ─────────────────────────────
  group('EditProposal.fromJson / ChatReply edit fields', () {
    Map<String, dynamic> card() => <String, dynamic>{
          'proposal_id': 'p1',
          'expires_at': '2026-09-29T10:10:00.000Z',
          'rows': <Map<String, dynamic>>[
            <String, dynamic>{
              'row_id': 'r1',
              'section_label': 'Skills',
              'op': 'add',
              'before': null,
              'after': 'Welding',
            },
            <String, dynamic>{
              'row_id': 'r2',
              'section_label': 'Languages',
              'op': 'delete',
              'before': 'Hindi',
              'after': null,
            },
          ],
        };

    test('parses the card and its rows', () {
      final EditProposal p = EditProposal.fromJson(card())!;
      expect(p.proposalId, 'p1');
      expect(p.rows, hasLength(2));
      expect(p.rows.first.rowId, 'r1');
      expect(p.rows.first.sectionLabel, 'Skills');
      expect(p.rows.first.op, 'add');
      expect(p.rows.first.after, 'Welding');
      expect(p.rows.first.before, isNull);
      expect(p.rows.last.before, 'Hindi');
    });

    test('fails closed to null on a malformed card', () {
      for (final Object? bad in <Object?>[
        null,
        'card',
        <String, dynamic>{},
        <String, dynamic>{...card()}..remove('proposal_id'),
        <String, dynamic>{...card(), 'expires_at': 'not-a-date'},
        <String, dynamic>{...card(), 'rows': 'nope'},
        <String, dynamic>{...card(), 'rows': <Object?>[]},
      ]) {
        expect(EditProposal.fromJson(bad), isNull, reason: '$bad');
      }
    });

    test('a malformed ROW is dropped, the rest of the card survives', () {
      final EditProposal p = EditProposal.fromJson(<String, dynamic>{
        ...card(),
        'rows': <Object?>[
          <String, dynamic>{'row_id': 'r1', 'section_label': 'Skills', 'op': 'add'},
          <String, dynamic>{'row_id': '', 'section_label': 'Skills', 'op': 'add'},
          'garbage',
        ],
      })!;
      expect(p.rows, hasLength(1));
      expect(p.rows.single.rowId, 'r1');
    });

    test('ChatReply carries edit_proposal / read_aloud / cooldown_until', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        ..._recapJson(),
        'edit_proposal': card(),
        // P3 / P2 fields, parsed for forward-compat (never served in P1).
        'read_aloud': false,
        'cooldown_until': '2026-09-29T11:00:00.000Z',
      });
      expect(reply.editProposal!.proposalId, 'p1');
      expect(reply.readAloud, isFalse);
      expect(reply.cooldownUntil, isNotNull);
    });

    test('an absent edit_proposal / read_aloud / cooldown_until is null', () {
      final ChatReply reply = ChatReply.fromJson(_recapJson());
      expect(reply.editProposal, isNull);
      expect(reply.readAloud, isNull);
      expect(reply.cooldownUntil, isNull);
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

  // ── ADR-0046 §5.2 — CONFIRM / CANCEL ───────────────────────────────────────
  //
  // The two routes answer `200 turn` / `404` / two DISTINCT 409s. The
  // repository maps them to the three-answer contract: served, gone (404 or
  // stale), interview (409 `{mode:"interview"}`).
  group('ChatRepositoryImpl.confirmCompanionEdit / cancelCompanionEdit', () {
    const String proposalId = '22222222-2222-4222-8222-222222222222';

    String errorBody(String key, String value) => jsonEncode(<String, dynamic>{
          'statusCode': 409,
          'error': <String, dynamic>{key: value},
          'requestId': 'r',
          'path': '/chat/companion/edits/$proposalId/confirm',
          'timestamp': '2026-09-29T10:00:00.000Z',
        });

    ChatRepositoryImpl repoWith(MockClient client) =>
        ChatRepositoryImpl(ApiClient(baseUrl: 'http://test', client: client), _signedIn());

    test('confirm POSTs {row_ids, submission_id} and returns the served turn', () async {
      Map<String, dynamic>? body;
      String? path;
      final ChatRepositoryImpl repo = repoWith(MockClient((http.Request req) async {
        path = req.url.path;
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return _json(_recapJson(reply: 'Badlav ho gaya.'), 200);
      }));

      final CompanionEditResult result = await repo.confirmCompanionEdit(
        proposalId,
        <String>['r1', 'r2'],
        submissionId: 'sub-1',
      );

      expect(path, '/chat/companion/edits/$proposalId/confirm');
      expect(body, <String, dynamic>{
        'row_ids': <String>['r1', 'r2'],
        'submission_id': 'sub-1',
      });
      expect(result.outcome, CompanionEditOutcome.served);
      expect(result.turn!.reply, 'Badlav ho gaya.');
    });

    test('cancel POSTs to the cancel route', () async {
      String? path;
      final ChatRepositoryImpl repo = repoWith(MockClient((http.Request req) async {
        path = req.url.path;
        return _json(_recapJson(reply: 'Theek hai, kuch nahi badla.'), 200);
      }));

      final CompanionEditResult result = await repo.cancelCompanionEdit(proposalId);

      expect(path, '/chat/companion/edits/$proposalId/cancel');
      expect(result.outcome, CompanionEditOutcome.served);
    });

    test('a 404 is GONE — the proposal is unknown or expired', () async {
      final ChatRepositoryImpl repo = repoWith(
        MockClient((http.Request req) async => http.Response('{"statusCode":404}', 404)),
      );
      expect((await repo.confirmCompanionEdit(proposalId, <String>['r1'])).outcome,
          CompanionEditOutcome.gone);
      expect((await repo.cancelCompanionEdit(proposalId)).outcome,
          CompanionEditOutcome.gone);
    });

    test('a 409 {reason:"stale"} is GONE — the profile changed under the card', () async {
      final ChatRepositoryImpl repo = repoWith(
        MockClient((http.Request req) async => http.Response(errorBody('reason', 'stale'), 409)),
      );
      expect((await repo.confirmCompanionEdit(proposalId, <String>['r1'])).outcome,
          CompanionEditOutcome.gone);
    });

    test('a 409 {mode:"interview"} LEAVES companion mode', () async {
      final ChatRepositoryImpl repo = repoWith(
        MockClient((http.Request req) async =>
            http.Response(errorBody('mode', 'interview'), 409)),
      );
      expect((await repo.confirmCompanionEdit(proposalId, <String>['r1'])).outcome,
          CompanionEditOutcome.interview);
      expect((await repo.cancelCompanionEdit(proposalId)).outcome,
          CompanionEditOutcome.interview);
    });

    test('any other failure is a Failure the card keeps', () async {
      final ChatRepositoryImpl repo = repoWith(
        MockClient((http.Request req) async => http.Response('{"statusCode":500}', 500)),
      );
      expect(repo.confirmCompanionEdit(proposalId, <String>['r1']),
          throwsA(isA<Failure>()));
      expect(repo.cancelCompanionEdit(proposalId), throwsA(isA<Failure>()));
    });
  });
  // ── THE HOP THAT WAS MISSING ────────────────────────────────────────────────
  //
  // Everything above asserts on `ChatReply` — the parse. Everything in the bloc
  // and widget suites hand-builds a `ChatTurn` that already carries the card.
  // Between those two sits `_companionTurn`, the ONLY ChatReply → ChatTurn hop
  // on the companion path, and it did not copy `edit_proposal` at all: the card,
  // its ticker, the confirm/cancel routes and all their tests existed and could
  // never run, with a fully green suite over the top.
  //
  // These tests drive the real repository from a raw JSON body to the `ChatTurn`
  // the bloc actually receives. They are the ones that fail if the mapper ever
  // drops a field again.
  group('wire → ChatTurn: the companion carries its v2 fields', () {
    Map<String, dynamic> cardJson() => <String, dynamic>{
          'proposal_id': 'p1',
          'expires_at': '2026-09-29T10:10:00.000Z',
          'rows': <Map<String, dynamic>>[
            <String, dynamic>{
              'row_id': 'r1',
              'section_label': 'Skills',
              'op': 'add',
              'before': null,
              'after': 'Welding',
            },
          ],
        };

    Map<String, dynamic> turnJson() => <String, dynamic>{
          ..._recapJson(),
          'edit_proposal': cardJson(),
          'cooldown_until': '2026-09-29T11:00:00.000Z',
          'read_aloud': false,
        };

    ChatRepositoryImpl repoServing(Map<String, dynamic> body) =>
        ChatRepositoryImpl(
          ApiClient(
            baseUrl: 'http://test',
            client: MockClient((http.Request _) async => _json(body, 200)),
          ),
          _signedIn(),
        );

    test('GET /chat/companion — the OPEN turn carries the card', () async {
      final CompanionOpening open = await repoServing(turnJson()).openCompanion();
      expect(open.isCompanion, isTrue);
      expect(open.turn!.editProposal, isNotNull,
          reason: 'the recap dropped edit_proposal — the card can never render');
      expect(open.turn!.editProposal!.proposalId, 'p1');
      expect(open.turn!.editProposal!.rows.single.after, 'Welding');
      expect(open.turn!.cooldownUntil, isNotNull);
      expect(open.turn!.readAloud, isFalse);
    });

    test('POST /chat/companion/message — the reply carries the card', () async {
      final ChatTurn? turn =
          await repoServing(turnJson()).sendCompanionMessage('Resume badlo');
      expect(turn, isNotNull);
      expect(turn!.editProposal, isNotNull,
          reason: 'a message reply dropped edit_proposal');
      expect(turn.editProposal!.rows, hasLength(1));
      expect(turn.cooldownUntil, isNotNull);
    });

    test('confirm and cancel both answer a turn that carries the card',
        () async {
      for (final String what in <String>['confirm', 'cancel']) {
        final ChatRepositoryImpl repo = repoServing(turnJson());
        final CompanionEditResult result = what == 'confirm'
            ? await repo.confirmCompanionEdit('p1', <String>['r1'])
            : await repo.cancelCompanionEdit('p1');
        expect(result.outcome, CompanionEditOutcome.served, reason: what);
        expect(result.turn!.editProposal, isNotNull,
            reason: '$what dropped edit_proposal');
      }
    });

    test('a turn WITHOUT the fields carries nulls, never a throw', () async {
      // The everyday case: the flag is off, or the turn simply has no card.
      final CompanionOpening open = await repoServing(_recapJson()).openCompanion();
      expect(open.turn!.editProposal, isNull);
      expect(open.turn!.cooldownUntil, isNull);
      expect(open.turn!.readAloud, isNull);
      expect(open.turn!.companion, isTrue, reason: 'still a companion turn');
    });

    test('a MALFORMED card does not cost the turn its reply', () async {
      final Map<String, dynamic> body = <String, dynamic>{
        ..._recapJson(reply: 'Aapki profile taiyaar hai.'),
        'edit_proposal': <String, dynamic>{'proposal_id': 42},
      };
      final CompanionOpening open = await repoServing(body).openCompanion();
      expect(open.turn!.editProposal, isNull, reason: 'fail closed');
      expect(open.turn!.reply, 'Aapki profile taiyaar hai.');
    });
  });
}
