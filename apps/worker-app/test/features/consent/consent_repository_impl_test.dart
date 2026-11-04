import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/referral/pending_referral_store.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/consent/data/consent_repository_impl.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  return s;
}

/// Lets the unawaited (fire-and-forget) attribution future drain after
/// acceptConsent returns — take() + the mock HTTP round-trip are async.
Future<void> _flush() => Future<void>.delayed(const Duration(milliseconds: 20));

void main() {
  test('accepts consent, then fires referral attribution and consumes the code',
      () async {
    final List<http.Request> requests = <http.Request>[];
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        requests.add(req);
        return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
      }),
    );
    final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
    await store.capture('abcdef012345');

    final ConsentRepositoryImpl repo =
        ConsentRepositoryImpl(api, _session(), store);

    await repo.acceptConsent(purposes: <String>['profiling'], age18Plus: true);
    await _flush();

    // Consent was posted first, carrying the age answer as a real JSON bool...
    final http.Request consent =
        requests.firstWhere((http.Request r) => r.url.path == '/consent/accept');
    expect(jsonDecode(consent.body), containsPair('age_18_plus', true));
    expect(jsonDecode(consent.body)['age_18_plus'], isA<bool>());
    // ...then the attribution, with the bearer + opaque code.
    final http.Request attr =
        requests.firstWhere((http.Request r) => r.url.path == '/referrals/attribute');
    expect(attr.headers['authorization'], 'Bearer tok');
    expect(jsonDecode(attr.body), <String, dynamic>{'code': 'abcdef012345'});
    // Consumed exactly once.
    expect(await store.take(), isNull);
  });

  test('no pending code -> no attribution call', () async {
    final List<http.Request> requests = <http.Request>[];
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        requests.add(req);
        return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
      }),
    );

    final ConsentRepositoryImpl repo = ConsentRepositoryImpl(
        api, _session(), InMemoryPendingReferralStore());

    await repo.acceptConsent(purposes: <String>['profiling'], age18Plus: true);
    await _flush();

    expect(requests.any((http.Request r) => r.url.path == '/referrals/attribute'),
        isFalse);
  });

  test('a failing attribution is swallowed — consent still succeeds', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/referrals/attribute') {
          return http.Response('{"message":"no"}', 403);
        }
        return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
      }),
    );
    final InMemoryPendingReferralStore store = InMemoryPendingReferralStore();
    await store.capture('abcdef012345');

    final ConsentRepositoryImpl repo =
        ConsentRepositoryImpl(api, _session(), store);

    // acceptConsent must NOT throw even though attribution 403s.
    await expectLater(
      repo.acceptConsent(purposes: <String>['profiling'], age18Plus: true),
      completes,
    );
    await _flush();
  });

  test('null store (widget-test graph) -> attribution is inert', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async =>
          http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200)),
    );
    // No PendingReferralStore supplied — mirrors the guarded DI default.
    final ConsentRepositoryImpl repo = ConsentRepositoryImpl(api, _session());

    await expectLater(
      repo.acceptConsent(purposes: <String>['profiling'], age18Plus: true),
      completes,
    );
  });

  test('missing worker id fails closed with UnauthorizedFailure', () {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response('{}', 200)),
    );
    final SessionRepository session = SessionRepository(); // no worker set
    final ConsentRepositoryImpl repo =
        ConsentRepositoryImpl(api, session, InMemoryPendingReferralStore());

    expect(repo.acceptConsent(purposes: <String>['profiling'], age18Plus: true),
        throwsA(isA<UnauthorizedFailure>()));
  });

  test('sends age_18_plus: false as a JSON boolean (never a string)', () async {
    final List<http.Request> requests = <http.Request>[];
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        requests.add(req);
        return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
      }),
    );
    final ConsentRepositoryImpl repo = ConsentRepositoryImpl(api, _session());

    await repo.acceptConsent(purposes: <String>['profiling'], age18Plus: false);
    await _flush();

    final dynamic body = jsonDecode(
        requests.singleWhere((r) => r.url.path == '/consent/accept').body);
    expect(body['age_18_plus'], false);
    expect(body['age_18_plus'], isA<bool>());
  });

  test('403 AGE_BELOW_MINIMUM -> AgeBelowMinimumFailure', () {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{
              'statusCode': 403,
              'error': <String, dynamic>{
                'code': 'AGE_BELOW_MINIMUM',
                'message': 'Sign-up requires 18+.',
              },
            }),
            403,
          )),
    );
    final ConsentRepositoryImpl repo = ConsentRepositoryImpl(api, _session());

    expect(
      repo.acceptConsent(purposes: <String>['profiling'], age18Plus: false),
      throwsA(isA<AgeBelowMinimumFailure>()),
    );
  });

  test('400 AGE_CONFIRMATION_REQUIRED -> AgeConfirmationRequiredFailure', () {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{
              'statusCode': 400,
              'error': <String, dynamic>{
                'code': 'AGE_CONFIRMATION_REQUIRED',
                'message': 'Age confirmation is required.',
              },
            }),
            400,
          )),
    );
    final ConsentRepositoryImpl repo = ConsentRepositoryImpl(api, _session());

    expect(
      repo.acceptConsent(purposes: <String>['profiling'], age18Plus: true),
      throwsA(isA<AgeConfirmationRequiredFailure>()),
    );
  });

  group('withdrawConsent', () {
    test('POSTs /consent/withdraw with the session bearer, empty body',
        () async {
      final List<http.Request> requests = <http.Request>[];
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          requests.add(req);
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
      );
      final ConsentRepositoryImpl repo = ConsentRepositoryImpl(api, _session());

      await repo.withdrawConsent();

      expect(requests, hasLength(1));
      expect(requests.single.url.path, '/consent/withdraw');
      expect(requests.single.headers['authorization'], 'Bearer tok');
      expect(jsonDecode(requests.single.body), isEmpty);
    });

    test('missing token fails closed with UnauthorizedFailure (no unauthed call)',
        () {
      final List<http.Request> requests = <http.Request>[];
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          requests.add(req);
          return http.Response('{}', 200);
        }),
      );
      final ConsentRepositoryImpl repo =
          ConsentRepositoryImpl(api, SessionRepository());

      expect(repo.withdrawConsent(), throwsA(isA<UnauthorizedFailure>()));
      expect(requests, isEmpty);
    });

    test('a server error is mapped to a typed Failure (not raw ApiException)',
        () {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{'message': 'no'}), 500)),
      );
      final ConsentRepositoryImpl repo = ConsentRepositoryImpl(api, _session());

      expect(repo.withdrawConsent(), throwsA(isA<Failure>()));
    });
  });
}
