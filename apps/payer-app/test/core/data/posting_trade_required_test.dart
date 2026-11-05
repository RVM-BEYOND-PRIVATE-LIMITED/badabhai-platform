import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// #2635 — company jobs match only within the 16 postable trades.
///
/// The API refuses a company PATCH that would leave a LIVE job outside them
/// (publishing one with no trade, or moving an open one off them) with a 400
/// whose `error.reason` is `posting_trade_required`. Clients branch on that
/// reason, never on the message — so the app must read it, and must never show
/// the server's sentence in place of its own words.
///
/// And `POST /payer/match/reach-preview` takes the job's `role_kind`, so the
/// "reaches N workers" figure scopes the posted skills exactly as publish will.
http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

const String _jobId = 'cccccccc-0000-4000-8000-000000000003';

/// The server's message — pinned by the API tests. It must never reach a payer.
const String _serverMessage = 'a live job must name one of the 16 trades';

/// The 400 exactly as `apps/api/src/job-postings/posting-trade-required.wire
/// .test.ts` renders it through the real global exception filter.
http.Response _tradeRequired() => _json(
      <String, dynamic>{
        'statusCode': 400,
        'requestId': 'req-test',
        'path': '/payer/job-postings/$_jobId',
        'timestamp': '2026-11-04T12:00:00.000Z',
        'error': <String, dynamic>{
          'statusCode': 400,
          'error': 'Bad Request',
          'message': _serverMessage,
          'reason': 'posting_trade_required',
        },
      },
      400,
    );

({HttpPayerApiClient api, List<http.Request> seen}) _api(
  http.Response response,
) {
  final List<http.Request> seen = <http.Request>[];
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok', payerId: 'p', role: 'company');
  return (
    api: HttpPayerApiClient(PayerHttp(
      baseUrl: 'http://api.test',
      tokenStore: tokens,
      client: MockClient((http.Request req) async {
        seen.add(req);
        return response;
      }),
    )),
    seen: seen,
  );
}

Future<PayerApiException> _patchFailure(
  http.Response response, {
  String? status,
  String? roleKind,
}) async {
  try {
    await _api(response).api.updateJob(
          _jobId,
          status: status,
          roleKind: roleKind,
        );
  } on PayerApiException catch (e) {
    return e;
  }
  fail('the PATCH did not throw');
}

void main() {
  group('PATCH /payer/job-postings/:id — posting_trade_required', () {
    test('a refused publish is typed by its reason', () async {
      final PayerApiException e =
          await _patchFailure(_tradeRequired(), status: 'open');

      expect(e.statusCode, 400);
      expect(e.code, kPostingTradeRequiredCode);
      expect(e.isPostingTradeRequired, isTrue);
    });

    test("it carries the app's words, pinned to the trade picker", () async {
      final PayerApiException e =
          await _patchFailure(_tradeRequired(), status: 'open');

      expect(e.validationMessage, 'Pick one of the 16 trades');
      expect(e.fieldErrors, <String, String>{
        'role_kind': 'Pick one of the 16 trades',
      });
    });

    test("the server's own message never reaches the payer", () async {
      final PayerApiException e =
          await _patchFailure(_tradeRequired(), roleKind: 'plumber');

      final List<String> shown = <String>[
        e.validationMessage ?? '',
        ...e.fieldErrors.values,
      ];
      for (final String text in shown) {
        expect(text.toLowerCase(), isNot(contains('a live job must name')));
      }
    });

    test('a top-level reason (no error envelope) is read the same way',
        () async {
      final PayerApiException e = await _patchFailure(
        _json(
          <String, dynamic>{
            'statusCode': 400,
            'message': _serverMessage,
            'reason': 'posting_trade_required',
          },
          400,
        ),
        status: 'open',
      );
      expect(e.isPostingTradeRequired, isTrue);
    });

    test('it branches on the reason, never on the message', () async {
      // The same sentence with NO reason is just a service-thrown 400: it is
      // not stamped, and keeps the old field-or-sentence handling.
      final PayerApiException e = await _patchFailure(
        _json(
          <String, dynamic>{
            'statusCode': 400,
            'error': <String, dynamic>{'message': _serverMessage},
          },
          400,
        ),
        status: 'open',
      );
      expect(e.isPostingTradeRequired, isFalse);
      expect(e.code, isNull);
    });

    test('another reason is not mistaken for it', () async {
      final PayerApiException e = await _patchFailure(
        _json(
          <String, dynamic>{
            'statusCode': 400,
            'error': <String, dynamic>{
              'message': 'something else',
              'reason': 'some_other_reason',
            },
          },
          400,
        ),
        status: 'open',
      );
      expect(e.isPostingTradeRequired, isFalse);
    });
  });

  group('POST /payer/match/reach-preview — role_kind', () {
    http.Response preview() => _json(<String, dynamic>{
          'skills': <dynamic>[],
          'reach_skill_ids': <String>['mskill_welder'],
          'reach_total': 7,
          'reach_tier1': 7,
          'zero_reach': false,
          'applied_unticked_ids': <String>[],
          'max_skills_per_posting': 3,
        });

    test("carries the job's trade, so the count scopes as publish will",
        () async {
      final ({HttpPayerApiClient api, List<http.Request> seen}) h =
          _api(preview());

      final ReachPreview reach = await h.api.reachPreview(
        matchSkillIds: const <String>['mskill_welder'],
        roleKind: 'welder',
      );

      expect(reach.reachTotal, 7);
      final http.Request req = h.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/match/reach-preview');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body, <String, dynamic>{
        'match_skill_ids': <String>['mskill_welder'],
        'unticked_related_ids': <String>[],
        'role_kind': 'welder',
      });
    });

    test('omits role_kind when the form has no trade (additive field)',
        () async {
      final ({HttpPayerApiClient api, List<http.Request> seen}) h =
          _api(preview());

      await h.api.reachPreview(matchSkillIds: const <String>['mskill_welder']);

      final Map<String, dynamic> body =
          jsonDecode(h.seen.single.body) as Map<String, dynamic>;
      expect(body.containsKey('role_kind'), isFalse);
    });
  });
}
