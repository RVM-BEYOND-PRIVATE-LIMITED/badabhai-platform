import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/swipe/data/swipe_repository_impl.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

SwipeRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) {
  return SwipeRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: client),
    _session(token: token),
  );
}

void main() {
  test('getFeed sends the bearer token and returns items', () async {
    late http.Request captured;
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'jobs': <Map<String, dynamic>>[
            <String, dynamic>{
              'job_id': 'j1',
              'trade_key': 'cnc_operator',
              'title': 'CNC Operator',
              'city': 'Pune',
              'area': null,
              'rank': 1,
            },
          ],
        }),
        200,
      );
    }));

    final result = await repo.getFeed();
    expect(captured.url.path, '/feed');
    expect(captured.headers['authorization'], 'Bearer tok');
    expect(result, hasLength(1));
    expect(result.first.jobId, 'j1');
  });

  test('a 403 maps to ConsentRequiredFailure', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{'message': 'consent required'}),
        403,
      );
    }));
    expect(repo.getFeed(), throwsA(isA<ConsentRequiredFailure>()));
  });

  test('a transport drop maps to a Failure (not a raw exception)', () {
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      throw Exception('no network');
    }));
    expect(repo.getFeed(), throwsA(isA<Failure>()));
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final SwipeRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 200)),
      token: null,
    );
    expect(repo.getFeed(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('applyToJob posts to the apply endpoint with the bearer token', () async {
    late http.Request captured;
    final SwipeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'application_id': 'a1',
          'action': 'applied',
        }),
        200,
      );
    }));

    await repo.applyToJob('j1', rank: 3);
    expect(captured.url.path, '/applications/j1/apply');
    expect(captured.headers['authorization'], 'Bearer tok');
  });
}
