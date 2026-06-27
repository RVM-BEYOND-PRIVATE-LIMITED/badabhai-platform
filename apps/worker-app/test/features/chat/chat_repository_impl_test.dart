import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';

/// A client that fails the test if it is ever hit — the fail-closed guards must
/// short-circuit before any network call.
MockClient _neverCalled() =>
    MockClient((http.Request req) async => fail('network must not be hit'));

ChatRepositoryImpl _repo(SessionRepository session) {
  return ChatRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: _neverCalled()),
    session,
  );
}

void main() {
  test('ensureSession fails closed with UnauthorizedFailure when no token', () {
    final ChatRepositoryImpl repo = _repo(SessionRepository());
    expect(repo.ensureSession(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('sendMessage fails closed with UnauthorizedFailure when no token', () {
    final ChatRepositoryImpl repo = _repo(SessionRepository());
    expect(repo.sendMessage('hi'), throwsA(isA<UnauthorizedFailure>()));
  });

  test('sendMessage fails closed when a session has not been opened', () {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
    // Token present but no sessionId (ensureSession never ran).
    final ChatRepositoryImpl repo = _repo(session);
    expect(repo.sendMessage('hi'), throwsA(isA<UnauthorizedFailure>()));
  });
}
