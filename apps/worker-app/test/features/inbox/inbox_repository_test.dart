import 'dart:convert';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/inbox/data/inbox_repository_impl.dart';
import 'package:badabhai_worker_app/features/inbox/domain/inbox_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

InboxRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    InboxRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

void main() {
  test('GETs /workers/me/relay-threads with the bearer and parses faceless rows',
      () async {
    late http.Request captured;
    final InboxRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'threads': <Map<String, dynamic>>[
            <String, dynamic>{
              'unlock_id': 'u1',
              'last_message_at': '2026-09-21T10:00:00.000Z',
              'unread_count': 2,
            },
          ],
        }),
        200,
      );
    }));

    final List<InboxThread> threads = await repo.threads();

    expect(captured.method, 'GET');
    expect(captured.url.path, '/workers/me/relay-threads');
    expect(captured.headers['authorization'], 'Bearer tok');
    expect(threads, hasLength(1));
    expect(threads.single.unlockId, 'u1');
    expect(threads.single.unreadCount, 2);
    expect(threads.single.hasUnread, isTrue);
  });

  test('reads one thread, mapping direction to fromWorker', () async {
    late http.Request captured;
    final InboxRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(
        jsonEncode(<String, dynamic>{
          'messages': <Map<String, dynamic>>[
            <String, dynamic>{
              'message_id': 'm1',
              'direction': 'payer_to_worker',
              'text': 'Aap available hain?',
              'created_at': '2026-09-21T10:00:00.000Z',
              'read_at': null,
            },
            <String, dynamic>{
              'message_id': 'm2',
              'direction': 'worker_to_payer',
              'text': 'Haan',
              'created_at': '2026-09-21T10:05:00.000Z',
              'read_at': null,
            },
          ],
        }),
        200,
      );
    }));

    final List<InboxMessage>? messages = await repo.thread('u1');

    expect(captured.url.path, '/workers/me/relay-threads/u1');
    expect(messages, hasLength(2));
    expect(messages!.first.fromWorker, isFalse);
    expect(messages[1].fromWorker, isTrue);
  });

  test('a neutral body on read means the thread is closed (null), never a reason',
      () async {
    final InboxRepositoryImpl repo = _repo(MockClient(
      (http.Request req) async =>
          http.Response(jsonEncode(<String, dynamic>{'status': 'unavailable'}), 200),
    ));
    expect(await repo.thread('u1'), isNull);
  });

  test('reply POSTs the text and returns false on the neutral body', () async {
    late http.Request captured;
    final InboxRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(jsonEncode(<String, dynamic>{'status': 'unavailable'}), 200);
    }));

    final bool sent = await repo.reply('u1', 'Haan, aa sakta hoon');

    expect(captured.method, 'POST');
    expect(captured.url.path, '/workers/me/relay-threads/u1/reply');
    expect(jsonDecode(captured.body), <String, dynamic>{'text': 'Haan, aa sakta hoon'});
    expect(sent, isFalse, reason: 'a closed thread is a non-success, not an error');
  });

  test('markRead POSTs to the read route', () async {
    late http.Request captured;
    final InboxRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      captured = req;
      return http.Response(jsonEncode(<String, dynamic>{'marked': 1}), 200);
    }));

    await repo.markRead('u1');

    expect(captured.method, 'POST');
    expect(captured.url.path, '/workers/me/relay-threads/u1/read');
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final InboxRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 200)),
      token: null,
    );
    expect(repo.threads(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('a transport drop maps to a Failure (not a raw exception)', () {
    final InboxRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      throw Exception('no network');
    }));
    expect(repo.threads(), throwsA(isA<Failure>()));
  });
}
