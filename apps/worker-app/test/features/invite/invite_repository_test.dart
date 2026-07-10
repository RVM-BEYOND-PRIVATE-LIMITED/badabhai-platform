import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/invite/data/invite_repository_impl.dart';
import 'package:badabhai_worker_app/features/invite/domain/invite_repository.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

InviteRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    InviteRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

void main() {
  test('POSTs /invites with the bearer, empty body; composes the absolute URL',
      () async {
    late http.Request captured;
    final InviteRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'invite_id': 'inv1',
          'code': 'abcdef012345',
          'link': '/i/abcdef012345',
        }),
        201,
      );
    }));

    final InviteLink link = await repo.createInvite();

    expect(captured.method, 'POST');
    expect(captured.url.path, '/invites');
    expect(captured.headers['authorization'], 'Bearer tok');
    // Empty {} body is valid (no campaign) — and carries no PII.
    final Map<String, dynamic> body =
        jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body, isEmpty);

    expect(link.code, 'abcdef012345');
    // kInviteLinkBase (default) + server-relative link.
    expect(link.url, 'https://app.badabhai.in/i/abcdef012345');
  });

  test('passes campaign through when supplied', () async {
    late http.Request captured;
    final InviteRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'invite_id': 'inv1',
          'code': 'abc',
          'link': '/i/abc',
        }),
        201,
      );
    }));

    await repo.createInvite(campaign: 'diwali');

    expect(jsonDecode(captured.body), <String, dynamic>{'campaign': 'diwali'});
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final InviteRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 201)),
      token: null,
    );
    expect(repo.createInvite(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('a transport drop maps to a Failure (not a raw exception)', () {
    final InviteRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      throw Exception('no network');
    }));
    expect(repo.createInvite(), throwsA(isA<Failure>()));
  });
}
