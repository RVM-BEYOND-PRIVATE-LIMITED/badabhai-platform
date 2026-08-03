import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/job_posting_chat_models.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// ADR-0035 — the five frozen job-posting-chat endpoints over
/// `HttpPayerApiClient`, driven by a mock `http.Client`.
///
/// What these lock:
///  - the exact paths + verbs of the frozen contract,
///  - the bearer rides every call and NO body `payer_id` ever does (XB-A),
///  - NO org/company name is ever sent or parsed (§Decision 3 — the draft has
///    no such field by construction),
///  - vacancy stays BANDED (§Decision 4 / ADR-0012),
///  - the no-oracle neutral 404 on transcript hydration,
///  - a non-2xx never decodes to a confident-looking empty value.
class _Router {
  _Router(this.routes);
  final Map<String, http.Response> routes;
  final List<http.Request> seen = <http.Request>[];

  http.Client client() => MockClient((http.Request req) async {
        seen.add(req);
        final String key = '${req.method} ${req.url.path}';
        return routes[key] ?? http.Response('{}', 404);
      });
}

({HttpPayerApiClient api, _Router router}) _harness(
  Map<String, http.Response> routes,
) {
  final _Router router = _Router(routes);
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok-abc', payerId: 'p', role: 'employer');
  return (
    api: HttpPayerApiClient(
      PayerHttp(
        baseUrl: 'http://api.test',
        tokenStore: tokens,
        client: router.client(),
      ),
    ),
    router: router,
  );
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

const String _sid = '22222222-2222-4222-8222-222222222222';

void main() {
  group('ADR-0035 — session + message', () {
    test('POST /session returns the OPENING TURN, with the bearer and no body '
        'payer_id / org name', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-posting-chat/session': _json(<String, dynamic>{
          'session_id': _sid,
          'status': 'active',
          'reply_text': 'Aapko kis kaam ke liye log chahiye?',
          'suggested_replies': <String>['CNC Setter', 'Welder'],
        }, 201),
      });

      final JobPostingChatTurn start = await h.api.startJobPostingChatSession();

      expect(start.sessionId, _sid);
      expect(start.reply, 'Aapko kis kaam ke liye log chahiye?');
      expect(start.suggestedReplies, <String>['CNC Setter', 'Welder']);
      final http.Request req = h.router.seen.single;
      expect(req.headers['authorization'], 'Bearer tok-abc');
      expect(req.body.contains('payer_id'), isFalse);
      expect(req.body.contains('org'), isFalse);
    });

    test('a 2xx with no session_id THROWS rather than opening a dead chat',
        () async {
      // Every later call keys off this id; an empty one would send the payer
      // into a conversation whose every turn 404s.
      final h = _harness(<String, http.Response>{
        'POST /payer/job-posting-chat/session': _json(<String, dynamic>{
          'status': 'active',
          'reply_text': 'hi',
        }, 201),
      });

      await expectLater(
        h.api.startJobPostingChatSession(),
        throwsA(isA<PayerApiException>()),
      );
    });

    test('POST /message sends EXACTLY {session_id, text} and parses the turn',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-posting-chat/message': _json(<String, dynamic>{
          'session_id': _sid,
          'reply_text': 'Kitne log chahiye?',
          'draft_ready': false,
          'suggested_replies': <String>['1', '2-5'],
          'draft': <String, dynamic>{
            'role_title': 'CNC Setter',
            'skill_phrases': <String>['Fanuc'],
            'vacancy_band': '2-5',
            'pay_min': 22000,
            'pay_max': 28000,
          },
        }),
      });

      final JobPostingChatTurn turn = await h.api.sendJobPostingChatMessage(
        sessionId: _sid,
        text: 'CNC Setter chahiye',
      );

      expect(turn.reply, 'Kitne log chahiye?');
      expect(turn.draftReady, isFalse);
      expect(turn.suggestedReplies, <String>['1', '2-5']);
      expect(turn.draft?.roleTitle, 'CNC Setter');
      expect(turn.draft?.skillPhrases, <String>['Fanuc']);
      expect(turn.draft?.vacancyBand, '2-5');

      final Map<String, dynamic> body =
          jsonDecode(h.router.seen.single.body) as Map<String, dynamic>;
      expect(body.keys.toSet(), <String>{'session_id', 'text'});
      expect(body['session_id'], _sid);
    });

    test('a BLOCKED turn (pseudonymize fail-closed) is surfaced, not hidden',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-posting-chat/message': _json(<String, dynamic>{
          'session_id': _sid,
          'reply_text': 'Ek baar dobara likhiye.',
          'blocked': true,
        }),
      });

      final JobPostingChatTurn turn = await h.api
          .sendJobPostingChatMessage(sessionId: _sid, text: 'anything');

      expect(turn.blocked, isTrue);
      expect(turn.suggestedReplies, isEmpty);
      expect(turn.draft, isNull, reason: 'a blocked turn carries no state');
    });
  });

  group('ADR-0035 — cross-device sessions list', () {
    test('GET /sessions parses rows and orders them newest-activity first',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/job-posting-chat/sessions': _json(<String, dynamic>{
          'sessions': <dynamic>[
            <String, dynamic>{
              'session_id': 'older',
              'status': 'active',
              'started_at': '2026-07-20T09:00:00Z',
              'last_message_at': '2026-07-20T09:30:00Z',
            },
            <String, dynamic>{
              'session_id': _sid,
              'status': 'draft_ready',
              'started_at': '2026-07-27T09:00:00Z',
              'last_message_at': '2026-07-27T10:00:00Z',
              'role_title': 'CNC Setter',
            },
            <String, dynamic>{
              'session_id': 'done',
              'status': 'published',
              'started_at': '2026-07-26T09:00:00Z',
            },
          ],
        }),
      });

      final List<JobPostingChatSessionSummary> rows =
          await h.api.fetchJobPostingChatSessions();

      expect(rows.length, 3);
      expect(rows.first.id, _sid, reason: 'newest activity first');
      expect(rows.first.draftReady, isTrue,
          reason: 'status draft_ready implies it');
      expect(rows.first.roleTitle, 'CNC Setter');
      expect(rows.first.isResumable, isTrue);
      expect(
        rows.firstWhere((JobPostingChatSessionSummary s) => s.id == 'done')
            .isResumable,
        isFalse,
      );
    });

    test('the BARE-ARRAY list convention also parses', () async {
      // PayerHttp wraps a top-level array under `items`; both conventions ship
      // in-repo, and the web client accepts both too.
      final h = _harness(<String, http.Response>{
        'GET /payer/job-posting-chat/sessions': _json(<dynamic>[
          <String, dynamic>{'session_id': _sid, 'status': 'active'},
        ]),
      });

      final List<JobPostingChatSessionSummary> rows =
          await h.api.fetchJobPostingChatSessions();
      expect(rows.single.id, _sid);
    });

    test('a 5xx must NOT decode to "you have nothing to resume"', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/job-posting-chat/sessions': http.Response('{}', 500),
      });

      await expectLater(
        h.api.fetchJobPostingChatSessions(),
        throwsA(isA<PayerApiException>()),
      );
    });
  });

  group('ADR-0035 — transcript hydration', () {
    test('GET /sessions/:id/messages maps inbound/outbound to the right side '
        'AND carries the draft, so a resumed chat shows it', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/job-posting-chat/sessions/$_sid/messages':
            _json(<String, dynamic>{
          'session_id': _sid,
          'status': 'draft_ready',
          'draft_ready': true,
          'suggested_replies': <String>['Day', 'Night'],
          'draft': <String, dynamic>{
            'role_title': 'CNC Setter',
            'vacancy_band': '2-5',
          },
          'messages': <dynamic>[
            <String, dynamic>{
              'direction': 'outbound',
              'body_text': 'Aapko kis kaam ke liye log chahiye?',
            },
            <String, dynamic>{'direction': 'inbound', 'body_text': 'CNC Setter'},
          ],
        }),
      });

      final JobPostingChatTranscript? t =
          await h.api.fetchJobPostingChatTranscript(_sid);

      expect(t, isNotNull);
      expect(t!.messages.map((JobPostingChatMessageRow r) => r.fromPayer),
          <bool>[false, true]);
      expect(t.draft?.roleTitle, 'CNC Setter');
      expect(t.draftReady, isTrue);
      expect(t.suggestedReplies, <String>['Day', 'Night']);
    });

    test('a neutral 404 (unknown OR not-owned) is NULL, never an exception — '
        'no IDOR oracle', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/job-posting-chat/sessions/$_sid/messages':
            http.Response('{}', 404),
      });

      expect(await h.api.fetchJobPostingChatTranscript(_sid), isNull);
    });
  });

  group('ADR-0035 — publish', () {
    test('POST /publish returns the created posting id; EMPTY body, no payer_id',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-posting-chat/sessions/$_sid/publish':
            _json(<String, dynamic>{
          'job_posting_id': 'job-9',
          'session_id': _sid,
          'status': 'published',
        }, 201),
      });

      expect((await h.api.publishJobPostingChatSession(_sid)).jobPostingId, 'job-9');
      final String body = h.router.seen.single.body;
      expect(body.contains('payer_id'), isFalse);
      expect(body.contains('org'), isFalse);
    });

    test('a 2xx WITHOUT job_posting_id is contract breakage, not a success',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-posting-chat/sessions/$_sid/publish':
            _json(<String, dynamic>{'status': 'published'}, 201),
      });
      await expectLater(
        h.api.publishJobPostingChatSession(_sid),
        throwsA(isA<PayerApiException>()),
      );
    });

    test('400 (draft incomplete) / 409 (already published or not ready) surface '
        'typed', () async {
      for (final int status in <int>[400, 409]) {
        final h = _harness(<String, http.Response>{
          'POST /payer/job-posting-chat/sessions/$_sid/publish':
              http.Response('{}', status),
        });
        await expectLater(
          h.api.publishJobPostingChatSession(_sid),
          throwsA(isA<PayerApiException>()
              .having((PayerApiException e) => e.statusCode, 'status', status)),
        );
      }
    });
  });

  group('ADR-0035 §Decision 3/4 — structural guarantees', () {
    test('the draft has NO org/company field, however the server spells it',
        () async {
      // The payer's own org name is auto-filled server-side at publish time and
      // never travels through the chat. If a future contract change started
      // sending one, there must be nowhere here for it to land.
      final JobPostingDraft draft = JobPostingDraft.fromJson(<String, dynamic>{
        'role_title': 'CNC Setter',
        'org_label': 'Kalyani Industries',
        'orgLabel': 'Kalyani Industries',
        'company_name': 'Kalyani Industries',
      });

      expect(draft.roleTitle, 'CNC Setter');
      expect(draft.props.contains('Kalyani Industries'), isFalse);
      expect(draft.props.any((Object? p) => p.toString().contains('Kalyani')),
          isFalse);
    });

    test('vacancy is only ever the BANDED enum', () async {
      expect(kVacancyBands, <String>['1', '2-5', '6-10', '11-25', '25+']);
      final JobPostingDraft draft = JobPostingDraft.fromJson(<String, dynamic>{
        'role_title': 'CNC Setter',
        'vacancy_band': '6-10',
        // A raw headcount has no field to land in.
        'vacancies': 8,
      });
      expect(draft.vacancyBand, '6-10');
      expect(draft.props.contains(8), isFalse);
    });

    test('hasRequiredFields gates on role_title + a VALID band', () async {
      expect(const JobPostingDraft(roleTitle: 'X').hasRequiredFields, isFalse);
      expect(
        const JobPostingDraft(roleTitle: 'X', vacancyBand: '7').hasRequiredFields,
        isFalse,
        reason: 'an out-of-enum band would just be a server 400',
      );
      expect(
        const JobPostingDraft(roleTitle: 'X', vacancyBand: '2-5')
            .hasRequiredFields,
        isTrue,
      );
    });
  });

  group('MOCK client — the chat loop is walkable with no backend', () {
    test('the canned interview never asks for the company/org name', () async {
      final MockPayerApiClient api = MockPayerApiClient();
      final JobPostingChatTurn start = await api.startJobPostingChatSession();

      final List<String> asked = <String>[start.reply];
      JobPostingChatTurn turn = await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: 'CNC Setter');
      for (int i = 0; i < 8 && !turn.draftReady; i++) {
        asked.add(turn.reply);
        turn = await api.sendJobPostingChatMessage(
            sessionId: start.sessionId, text: '3');
      }
      asked.add(turn.reply);

      final String script = asked.join(' ').toLowerCase();
      for (final String forbidden in <String>[
        'company',
        'org',
        'firm',
        'employer',
        'kampani',
      ]) {
        expect(script.contains(forbidden), isFalse, reason: forbidden);
      }
    });

    test('a headcount answer is BANDED, and publish needs a complete draft',
        () async {
      final MockPayerApiClient api = MockPayerApiClient();
      final JobPostingChatTurn start = await api.startJobPostingChatSession();

      // Publishing before the interview is done is a 400, exactly like the
      // server validating against PayerCreateJobPostingSchema.
      await expectLater(
        api.publishJobPostingChatSession(start.sessionId),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'status', 400)),
      );

      await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: 'CNC Setter');
      await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: 'Chakan, Pune');
      final JobPostingChatTurn vacancy = await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: '8 log');

      expect(vacancy.draft?.vacancyBand, '6-10',
          reason: '8 falls in the 6-10 band — never a raw 8');

      await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: '22000-28000');
      await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: 'Day');
      final JobPostingChatTurn last = await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: '2+ years');

      expect(last.draftReady, isTrue);
      expect((await api.publishJobPostingChatSession(start.sessionId)).jobPostingId,
          isNotEmpty);

      // Re-publishing the same conversation is a 409.
      await expectLater(
        api.publishJobPostingChatSession(start.sessionId),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'status', 409)),
      );
    });

    test('sessions + transcript come back for cross-device pickup', () async {
      final MockPayerApiClient api = MockPayerApiClient();
      final JobPostingChatTurn start = await api.startJobPostingChatSession();
      await api.sendJobPostingChatMessage(
          sessionId: start.sessionId, text: 'CNC Setter');

      final List<JobPostingChatSessionSummary> sessions =
          await api.fetchJobPostingChatSessions();
      expect(sessions.single.id, start.sessionId);
      expect(sessions.single.isResumable, isTrue);

      final JobPostingChatTranscript? t =
          await api.fetchJobPostingChatTranscript(start.sessionId);
      expect(t, isNotNull);
      expect(t!.messages.any((JobPostingChatMessageRow r) => r.fromPayer),
          isTrue);
      expect(t.messages.any((JobPostingChatMessageRow r) => !r.fromPayer),
          isTrue);
      expect(t.draft?.roleTitle, 'CNC Setter');

      // An unknown id is a neutral null, never an oracle.
      expect(await api.fetchJobPostingChatTranscript('nope'), isNull);
    });
  });
}
