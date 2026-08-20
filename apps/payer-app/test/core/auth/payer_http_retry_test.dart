import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';

/// Regression: a company opening Find / Jobs saw "data load nahi ho raha" with a
/// Retry button on the FIRST load, and tapping Retry loaded it fine — a transient
/// transport failure (cold first-connection / dropped socket on a weak link) that
/// the caller had to recover by hand. `PayerHttp` now auto-retries a transient
/// failure on an IDEMPOTENT GET, so the first load self-heals; a write is never
/// repeated.
http.Response _ok() => http.Response(
      '{}',
      200,
      headers: <String, String>{'content-type': 'application/json'},
    );

PayerHttp _client(http.Client client) {
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'jwt', payerId: 'p', role: 'employer');
  return PayerHttp(baseUrl: 'http://api.test', tokenStore: tokens, client: client);
}

void main() {
  test('GET self-heals a transient transport failure (the reported bug)',
      () async {
    int calls = 0;
    final PayerHttp http0 = _client(MockClient((http.Request _) async {
      calls++;
      if (calls == 1) throw http.ClientException('dropped socket');
      return _ok();
    }));

    final PayerResponse res =
        await http0.send(PayerMethod.get, '/payer/job-postings');

    expect(res.statusCode, 200);
    expect(calls, 2, reason: 'first failed, retried once, succeeded');
  });

  test('GET retries a transient 503, then succeeds', () async {
    int calls = 0;
    final PayerHttp http0 = _client(MockClient((http.Request _) async {
      calls++;
      return calls == 1 ? http.Response('{}', 503) : _ok();
    }));

    final PayerResponse res =
        await http0.send(PayerMethod.get, '/payer/reach/jobs/j/applicants');

    expect(res.statusCode, 200);
    expect(calls, 2);
  });

  test('a deterministic 500 is NOT retried — surfaces at once', () async {
    int calls = 0;
    final PayerHttp http0 = _client(MockClient((http.Request _) async {
      calls++;
      return http.Response('{}', 500);
    }));

    final PayerResponse res =
        await http0.send(PayerMethod.get, '/payer/job-postings');

    expect(res.statusCode, 500);
    expect(calls, 1);
  });

  test('a POST is NEVER auto-retried — a write must not repeat', () async {
    int calls = 0;
    final PayerHttp http0 = _client(MockClient((http.Request _) async {
      calls++;
      throw http.ClientException('dropped after the server took the request');
    }));

    await expectLater(
      http0.send(PayerMethod.post, '/payer/credits',
          body: <String, dynamic>{'pack_code': 'starter'}),
      throwsA(isA<http.ClientException>()),
    );
    expect(calls, 1, reason: 'buying credits twice would double-charge');
  });

  test('a TIMEOUT is NOT retried — bounds the wait to one timeout, no 45s spinner',
      () async {
    int calls = 0;
    final PayerHttp http0 = _client(MockClient((http.Request _) async {
      calls++;
      throw TimeoutException('server accepted but never answered');
    }));

    await expectLater(
      http0.send(PayerMethod.get, '/payer/job-postings'),
      throwsA(isA<TimeoutException>()),
    );
    expect(calls, 1,
        reason: 'retrying a hung server multiplies the wait without helping');
  });

  test('a GET that keeps failing gives up after the bounded attempts', () async {
    int calls = 0;
    final PayerHttp http0 = _client(MockClient((http.Request _) async {
      calls++;
      throw http.ClientException('down');
    }));

    await expectLater(
      http0.send(PayerMethod.get, '/payer/job-postings'),
      throwsA(isA<http.ClientException>()),
    );
    expect(calls, 3, reason: '2 retries + the original attempt');
  });
}
