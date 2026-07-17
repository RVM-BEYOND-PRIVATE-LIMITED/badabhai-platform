import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/swipe/data/jobs_repository_impl.dart';
import 'package:badabhai_worker_app/features/swipe/domain/job_detail.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

JobsRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) {
  return JobsRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: client),
    _session(token: token),
  );
}

void main() {
  test('jobDetail GETs /jobs/:id with the bearer token and parses the body',
      () async {
    late http.Request captured;
    final JobsRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'job_id': 'j1',
          'trade_key': 'cnc_operator',
          'title': 'CNC Operator',
          'city': 'Pune',
          'area': 'Chakan',
          'pay_min': 16000,
          'pay_max': 26000,
          'min_experience_years': 0,
          'max_experience_years': 2,
          'needed_by': 'immediate',
          'shift': 'day',
          'description': 'CNC lathe par kaam.',
          'benefits': <String>['PF + ESI'],
          'requirements': <String>['Fanuc control'],
        }),
        200,
      );
    }));

    final JobDetail detail = await repo.jobDetail('j1');
    expect(captured.method, 'GET');
    expect(captured.url.path, '/jobs/j1');
    expect(captured.headers['authorization'], 'Bearer tok');
    expect(detail.jobId, 'j1');
    expect(detail.payMin, 16000);
    expect(detail.shift, 'day');
    expect(detail.benefits, <String>['PF + ESI']);
  });

  test('a 401 maps to UnauthorizedFailure (re-login)', () {
    final JobsRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{'message': 'unauthorized'}),
        401,
      );
    }));
    expect(repo.jobDetail('j1'), throwsA(isA<UnauthorizedFailure>()));
  });

  test('a 403 maps to ConsentRequiredFailure (consent gate)', () {
    final JobsRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{'message': 'consent required'}),
        403,
      );
    }));
    expect(repo.jobDetail('j1'), throwsA(isA<ConsentRequiredFailure>()));
  });

  test(
      'the neutral 404 (unknown/closed job) maps to ServerFailure carrying '
      'the status — no NotFound Failure exists, so this IS the idiomatic '
      'mapping (see mapError)', () {
    final JobsRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{'message': 'Job not found'}),
        404,
      );
    }));
    expect(
      repo.jobDetail('gone'),
      throwsA(
        isA<ServerFailure>()
            .having((ServerFailure f) => f.statusCode, 'statusCode', 404),
      ),
    );
  });

  test('a transport drop maps to a Failure (not a raw exception)', () {
    final JobsRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      throw Exception('no network');
    }));
    expect(repo.jobDetail('j1'), throwsA(isA<Failure>()));
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final JobsRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 200)),
      token: null,
    );
    expect(repo.jobDetail('j1'), throwsA(isA<UnauthorizedFailure>()));
  });
}
