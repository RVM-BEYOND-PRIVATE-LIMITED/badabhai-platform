import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// P1 — AGENCY supply-money (agent-only, FLAG-GATED): KYC / earnings / payouts
/// over `HttpPayerApiClient` driven by a mock `http.Client`. Verifies each method
/// hits the right path + parses the REAL wire shape, snake_case IN on the KYC
/// POST, the payout-request 200 for BOTH ok/blocked, the BARE-array history, and
/// the FLAG-OFF neutral 404 surfacing as a typed [PayerApiException] (which the
/// cubits then degrade to "not available yet"). No body `payer_id` anywhere.
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
  tokens.save(accessToken: 'tok-agent', payerId: 'p', role: 'agent');
  final PayerHttp httpClient = PayerHttp(
    baseUrl: 'http://api.test',
    tokenStore: tokens,
    client: router.client(),
  );
  return (api: HttpPayerApiClient(httpClient), router: router);
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

void main() {
  group('KYC', () {
    test('submitAgencyKyc POSTs snake_case body → 201 masked view', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/kyc': _json(<String, dynamic>{
          'status': 'pending',
          'panLast4': '234F',
          'bankLast4': '9012',
          'rejectReason': null,
          'updatedAt': '2026-07-12T00:00:00Z',
        }, 201),
      });

      final AgencyKycView kyc = await h.api.submitAgencyKyc(
        pan: 'ABCDE1234F',
        bankAccount: '123456789012',
        ifsc: 'HDFC0001234',
        accountHolderName: 'Acme Staffing',
      );

      expect(kyc.status, 'pending');
      expect(kyc.isPending, isTrue);
      expect(kyc.panLast4, '234F');
      expect(kyc.bankLast4, '9012');

      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/agency/kyc');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['pan'], 'ABCDE1234F');
      expect(body['bank_account'], '123456789012');
      expect(body['ifsc'], 'HDFC0001234');
      expect(body['account_holder_name'], 'Acme Staffing');
      expect(body.containsKey('payer_id'), isFalse);
      expect(req.headers['authorization'], 'Bearer tok-agent');
    });

    test('fetchAgencyKyc GET → masked view (last-4 only)', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/kyc': _json(<String, dynamic>{
          'status': 'verified',
          'panLast4': '234F',
          'bankLast4': '9012',
          'rejectReason': null,
          'updatedAt': '2026-07-10T00:00:00Z',
        }),
      });

      final AgencyKycView kyc = await h.api.fetchAgencyKyc();
      expect(kyc.isVerified, isTrue);
      expect(kyc.panLast4, '234F');
      expect(h.router.seen.single.url.path, '/payer/agency/kyc');
    });

    test('fetchAgencyKyc a FLAG-OFF 404 throws (→ "not available yet")',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/kyc': _json(<String, dynamic>{}, 404),
      });
      await expectLater(
        h.api.fetchAgencyKyc(),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'statusCode', 404)),
      );
    });
  });

  group('earnings', () {
    test('fetchAgencyEarnings GET → parses the full gate view', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/earnings': _json(<String, dynamic>{
          'totalAccruedInr': 1350,
          'requestableInr': 850,
          'inRequestInr': 0,
          'paidInr': 500,
          'accrualCount': 135,
          'kycStatus': 'verified',
          'thresholdInr': 500,
          'basisInr': 40,
          'rateBps': 2500,
          'windowDays': 90,
          'payoutsEnabled': true,
          'canRequest': true,
          'blockedReason': null,
        }),
      });

      final AgencyEarnings e = await h.api.fetchAgencyEarnings();
      expect(e.requestableInr, 850);
      expect(e.paidInr, 500);
      expect(e.kycStatus, 'verified');
      expect(e.canRequest, isTrue);
      expect(e.blockedReason, isNull);
      expect(e.rateBps, 2500);
      expect(h.router.seen.single.url.path, '/payer/agency/earnings');
    });

    test('a below-threshold gate is reflected, not re-derived', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/earnings': _json(<String, dynamic>{
          'totalAccruedInr': 120,
          'requestableInr': 120,
          'inRequestInr': 0,
          'paidInr': 0,
          'accrualCount': 12,
          'kycStatus': 'verified',
          'thresholdInr': 500,
          'basisInr': 40,
          'rateBps': 2500,
          'windowDays': 90,
          'payoutsEnabled': true,
          'canRequest': false,
          'blockedReason': 'below_threshold',
        }),
      });

      final AgencyEarnings e = await h.api.fetchAgencyEarnings();
      expect(e.canRequest, isFalse);
      expect(e.blockedReason, 'below_threshold');
      expect(e.remainingToThresholdInr, 380);
    });

    test('a FLAG-OFF 404 throws', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/earnings': _json(<String, dynamic>{}, 404),
      });
      await expectLater(
        h.api.fetchAgencyEarnings(),
        throwsA(isA<PayerApiException>()),
      );
    });
  });

  group('payouts', () {
    test('requestAgencyPayout POSTs empty body → ok:true request', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/payouts': _json(<String, dynamic>{
          'ok': true,
          'requestId': 'req-1',
          'amountInr': 850,
          'accrualCount': 85,
        }),
      });

      final PayoutRequestResult r = await h.api.requestAgencyPayout();
      expect(r.ok, isTrue);
      expect(r.requestId, 'req-1');
      expect(r.amountInr, 850);
      expect(r.accrualCount, 85);

      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/agency/payouts');
      // MONEY-OUT: no gateway, no body payer_id — the session is the actor.
      expect(req.body, isEmpty);
    });

    test('requestAgencyPayout a gate refusal is HTTP 200 ok:false + reason',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/payouts': _json(<String, dynamic>{
          'ok': false,
          'blocked': true,
          'reason': 'kyc_not_verified',
        }),
      });

      final PayoutRequestResult r = await h.api.requestAgencyPayout();
      expect(r.ok, isFalse);
      expect(r.blockedReason, 'kyc_not_verified');
      expect(r.requestId, isNull);
    });

    test('requestAgencyPayout a FLAG-OFF 404 throws (not parsed as blocked)',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/payouts': _json(<String, dynamic>{}, 404),
      });
      await expectLater(
        h.api.requestAgencyPayout(),
        throwsA(isA<PayerApiException>()),
      );
    });

    test('fetchAgencyPayouts parses a BARE array (wrapped under items)',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/payouts': _json(<Map<String, dynamic>>[
          <String, dynamic>{
            'id': 'p2',
            'amountInr': 850,
            'accrualCount': 85,
            'status': 'requested',
            'createdAt': '2026-07-14T00:00:00Z',
          },
          <String, dynamic>{
            'id': 'p1',
            'amountInr': 500,
            'accrualCount': 50,
            'status': 'paid',
            'createdAt': '2026-06-20T00:00:00Z',
          },
        ]),
      });

      final List<AgencyPayout> rows = await h.api.fetchAgencyPayouts();
      expect(rows, hasLength(2));
      expect(rows.first.id, 'p2');
      expect(rows.first.status, 'requested');
      expect(rows[1].status, 'paid');
      expect(h.router.seen.single.url.path, '/payer/agency/payouts');
    });

    test('fetchAgencyPayouts a FLAG-OFF 404 throws (not an empty history)',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/payouts': _json(<String, dynamic>{}, 404),
      });
      await expectLater(
        h.api.fetchAgencyPayouts(),
        throwsA(isA<PayerApiException>()),
      );
    });
  });
}
