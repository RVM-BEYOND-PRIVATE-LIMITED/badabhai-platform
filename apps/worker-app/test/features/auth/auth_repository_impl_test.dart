import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/auth/data/auth_repository_impl.dart';

AuthRepositoryImpl _repo(MockClient client, SessionRepository session) {
  return AuthRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: client),
    session,
  );
}

void main() {
  // The wiring the entire authenticated flow depends on: a successful verifyOtp
  // must populate the session (phone + workerId + bearer token) from the API
  // result. Asserted over a real SessionRepository + ApiClient(MockClient).
  test('verifyOtp populates the session from the API result', () async {
    final SessionRepository session = SessionRepository();
    final AuthRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      return http.Response(
        jsonEncode(<String, dynamic>{
          'worker_id': 'w1',
          'access_token': 'tok-123',
          'is_new_worker': true,
          'status': 'active',
        }),
        200,
      );
    }), session);

    await repo.verifyOtp(phoneE164: '+919912345678', otp: '1234');

    expect(session.workerId, 'w1');
    expect(session.sessionToken, 'tok-123');
    expect(session.phoneE164, '+919912345678');
  });

  test('a transport drop on verifyOtp maps to a Failure (session untouched)',
      () {
    final SessionRepository session = SessionRepository();
    final AuthRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => throw Exception('no network')),
      session,
    );
    expect(
      repo.verifyOtp(phoneE164: '+919912345678', otp: '1234'),
      throwsA(isA<Failure>()),
    );
    expect(session.workerId, isNull);
    expect(session.sessionToken, isNull);
  });
}
