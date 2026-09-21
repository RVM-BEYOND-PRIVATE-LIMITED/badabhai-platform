import 'dart:convert';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/consent/data/consent_repository_impl.dart';
import 'package:badabhai_worker_app/features/consent/domain/employer_contact.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  return s;
}

ConsentRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    ConsentRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

String _state({required List<String> purposes}) => jsonEncode(<String, dynamic>{
      'consent_id': 'c1',
      'consent_version': '2026-08-28',
      'accepted_at': '2026-09-21T10:00:00.000Z',
      'revoked_at': null,
      'purposes': purposes,
    });

void main() {
  test('GETs /consent/me with the bearer; enabled only when BOTH purposes present',
      () async {
    late http.Request captured;
    final ConsentRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        _state(purposes: <String>[
          'profiling',
          'employer_sharing',
          'employer_messaging',
        ]),
        200,
      );
    }));

    final EmployerContactInfo info = await repo.employerContactState();

    expect(captured.method, 'GET');
    expect(captured.url.path, '/consent/me');
    expect(captured.headers['authorization'], 'Bearer tok');
    expect(info.enabled, isTrue);
  });

  test('enabled is FALSE when only one of the two purposes is present', () async {
    final ConsentRepositoryImpl repo = _repo(MockClient(
      (http.Request req) async => http.Response(
        _state(purposes: <String>['profiling', 'employer_sharing']),
        200,
      ),
    ));
    final EmployerContactInfo info = await repo.employerContactState();
    expect(info.enabled, isFalse);
  });

  test('no row is a real answer: [] purposes -> off', () async {
    final ConsentRepositoryImpl repo = _repo(MockClient(
      (http.Request req) async => http.Response(
        _state(purposes: const <String>[]),
        200,
      ),
    ));
    final EmployerContactInfo info = await repo.employerContactState();
    expect(info.enabled, isFalse);
  });

  test('withdrawEmployerContact POSTs the per-purpose exit', () async {
    late http.Request captured;
    final ConsentRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'consent_id': 'c2',
          'withdrawn': <String>['employer_sharing', 'employer_messaging'],
        }),
        200,
      );
    }));

    await repo.withdrawEmployerContact();

    expect(captured.method, 'POST');
    expect(captured.url.path, '/consent/employer-contact/withdraw');
    expect(captured.headers['authorization'], 'Bearer tok');
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final ConsentRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 200)),
      token: null,
    );
    expect(repo.employerContactState(), throwsA(isA<UnauthorizedFailure>()));
    expect(repo.withdrawEmployerContact(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('a server error maps to a typed Failure', () {
    final ConsentRepositoryImpl repo = _repo(MockClient(
      (http.Request req) async => http.Response('{"error":"x"}', 500),
    ));
    expect(repo.employerContactState(), throwsA(isA<Failure>()));
  });
}
