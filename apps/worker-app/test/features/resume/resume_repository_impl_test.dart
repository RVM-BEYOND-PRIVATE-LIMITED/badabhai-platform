import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/resume/data/resume_repository_impl.dart';

SessionRepository _session({String? token = 'tok', String? resumeId = 'r1'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  if (resumeId != null) s.setResume(resumeId);
  return s;
}

ResumeRepositoryImpl _repo(
  MockClient client, {
  String? token = 'tok',
  String? resumeId = 'r1',
}) =>
    ResumeRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token, resumeId: resumeId),
    );

void main() {
  group('resumeDownloadUrl', () {
    test('success returns the signed url with the bearer attached', () async {
      late http.Request captured;
      final ResumeRepositoryImpl repo = _repo(MockClient((http.Request req) async {
        captured = req;
        return http.Response(
          jsonEncode(<String, dynamic>{'url': 'https://signed/pdf', 'expires_in': 300}),
          200,
        );
      }));

      expect(await repo.resumeDownloadUrl(), 'https://signed/pdf');
      expect(captured.method, 'GET');
      expect(captured.url.path, '/resume/r1/download');
      expect(captured.headers['authorization'], 'Bearer tok');
    });

    test('409 -> ResumeNotReadyFailure (honest "PDF taiyaar ho rahi hai", NOT a generic ServerFailure)',
        () {
      final ResumeRepositoryImpl repo = _repo(MockClient((http.Request req) async =>
          http.Response(
            jsonEncode(<String, dynamic>{'message': 'Resume PDF is still being rendered'}),
            409,
          )));
      expect(repo.resumeDownloadUrl(), throwsA(isA<ResumeNotReadyFailure>()));
    });

    test('500 -> ServerFailure (the 409 special-case does not swallow real errors)', () {
      final ResumeRepositoryImpl repo = _repo(MockClient(
          (http.Request req) async => http.Response('{}', 500)));
      expect(repo.resumeDownloadUrl(), throwsA(isA<ServerFailure>()));
    });

    test('401 -> UnauthorizedFailure', () {
      final ResumeRepositoryImpl repo = _repo(MockClient(
          (http.Request req) async => http.Response('{}', 401)));
      expect(repo.resumeDownloadUrl(), throwsA(isA<UnauthorizedFailure>()));
    });

    test('no resumeId / token fails closed with UnauthorizedFailure', () {
      final ResumeRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => http.Response('{}', 200)),
        token: null,
      );
      expect(repo.resumeDownloadUrl(), throwsA(isA<UnauthorizedFailure>()));
    });
  });
}
