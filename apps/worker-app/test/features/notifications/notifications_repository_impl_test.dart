import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/notifications/data/notifications_repository_impl.dart';
import 'package:badabhai_worker_app/features/notifications/domain/app_notification.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

NotificationsRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    NotificationsRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

Map<String, dynamic> _noti({
  required String id,
  required String type,
  required String title,
  required String body,
  required String createdAt,
}) =>
    <String, dynamic>{
      'id': id,
      'type': type,
      'title': title,
      'body': body,
      'created_at': createdAt,
    };

/// A 200 JSON response with an explicit utf-8 charset (as real NestJS sends) —
/// so multi-byte copy (e.g. the em-dash "—") round-trips instead of throwing
/// under `http`'s latin1 default.
http.Response _ok(Object body) => http.Response(
      jsonEncode(body),
      200,
      headers: const <String, String>{
        'content-type': 'application/json; charset=utf-8',
      },
    );

void main() {
  test('GETs /workers/me/notifications with the bearer; maps type -> kind, '
      'body -> subtitle; drives the unread badge', () async {
    late http.Request captured;
    final String nowIso = DateTime.now().toUtc().toIso8601String();
    final NotificationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      captured = req;
      return _ok(<String, dynamic>{
          'notifications': <Map<String, dynamic>>[
            _noti(
              id: 'e1',
              type: 'resume_ready',
              title: 'Resume taiyaar hai',
              body: 'Aapka naya resume ban gaya — dekhein aur download karein.',
              createdAt: nowIso,
            ),
            _noti(
              id: 'e2',
              type: 'security',
              title: 'Naye device se login',
              body: 'Aapke account mein ek naye device se login hua.',
              createdAt: nowIso,
            ),
          ],
        });
    }));

    final List<AppNotification> items = await repo.list();

    // Worker-scoped GET, token-derived, bearer attached.
    expect(captured.method, 'GET');
    expect(captured.url.path, '/workers/me/notifications');
    expect(captured.headers['authorization'], 'Bearer tok');

    // Real mapping: server type -> UI kind, body -> subtitle.
    expect(items, hasLength(2));
    expect(items[0].kind, NotificationKind.resumeReady);
    expect(items[0].title, 'Resume taiyaar hai');
    expect(items[0].subtitle, contains('resume'));
    expect(items[1].kind, NotificationKind.security);

    // Both start unread → badge shows 2.
    expect(repo.unreadCount.value, 2);
  });

  test('the feed renders NO employer/company name, ₹/pay, or phone-like text',
      () async {
    final NotificationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      return _ok(<String, dynamic>{
          'notifications': <Map<String, dynamic>>[
            _noti(
              id: 'e1',
              type: 'profile_ready',
              title: 'Profile taiyaar hai',
              body: 'Aapki profile confirm ho gayi.',
              createdAt: DateTime.now().toUtc().toIso8601String(),
            ),
          ],
        });
    }));

    final List<AppNotification> items = await repo.list();
    for (final AppNotification n in items) {
      final String text = '${n.title} ${n.subtitle}';
      expect(text, isNot(contains('₹')));
      expect(text.toLowerCase(), isNot(contains('employer')));
      expect(text.toLowerCase(), isNot(contains('company')));
      expect(text, isNot(matches(RegExp(r'\d{4,}')))); // no phone/pay digit runs
    }
  });

  test('application_sent decodes to its OWN kind (not the security fallback) '
      'and keeps the server-rendered copy verbatim', () async {
    final NotificationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      return _ok(<String, dynamic>{
        'notifications': <Map<String, dynamic>>[
          _noti(
            id: 'e1',
            type: 'application_sent',
            title: 'Application bhej di',
            body: 'Aapki application aage pahunch gayi.',
            createdAt: DateTime.now().toUtc().toIso8601String(),
          ),
        ],
      });
    }));

    final List<AppNotification> items = await repo.list();

    // Mapped explicitly — must NOT land on the unknown-type fallback.
    expect(items.single.kind, NotificationKind.applicationSent);
    expect(items.single.kind, isNot(NotificationKind.security));

    // Copy is SERVER-rendered: passed through byte-for-byte, never composed.
    expect(items.single.title, 'Application bhej di');
    expect(items.single.subtitle, 'Aapki application aage pahunch gayi.');
  });

  test('an unknown/future type still falls back to security (posture kept)',
      () async {
    final NotificationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      return _ok(<String, dynamic>{
        'notifications': <Map<String, dynamic>>[
          _noti(
            id: 'e1',
            type: 'some_future_type',
            title: 'Kuch naya',
            body: 'Server ne naya type bheja.',
            createdAt: DateTime.now().toUtc().toIso8601String(),
          ),
        ],
      });
    }));

    final List<AppNotification> items = await repo.list();
    expect(items.single.kind, NotificationKind.security);
  });

  test('the application_sent row is faceless (ADR-0024): no employer/company '
      'word, no identity marker, no pay, no phone', () async {
    final NotificationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      return _ok(<String, dynamic>{
        'notifications': <Map<String, dynamic>>[
          _noti(
            id: 'e1',
            type: 'application_sent',
            title: 'Application bhej di',
            body: 'Aapki application aage pahunch gayi.',
            createdAt: DateTime.now().toUtc().toIso8601String(),
          ),
        ],
      });
    }));

    final List<AppNotification> items = await repo.list();
    final String text = '${items.single.title} ${items.single.subtitle}';
    // Same bright line as the sibling sweeps above: the server copy names no
    // counterparty at all, not even the generic noun (mirrors the API-side guard
    // in notifications.service.test.ts).
    expect(text.toLowerCase(), isNot(contains('employer')));
    expect(text.toLowerCase(), isNot(contains('company')));
    // …and no identity-shaped marker (posture of the mock-client PII sweep).
    expect(text, isNot(contains('Pvt')));
    expect(text, isNot(contains('Ltd')));
    expect(text, isNot(contains('@')));
    expect(text, isNot(contains('₹')));
    expect(text, isNot(matches(RegExp(r'\d{4,}')))); // no phone/pay digit runs
  });

  test('markAllRead clears the badge and re-list marks them read', () async {
    final NotificationsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async {
      return _ok(<String, dynamic>{
          'notifications': <Map<String, dynamic>>[
            _noti(
              id: 'e1',
              type: 'resume_ready',
              title: 'Resume taiyaar hai',
              body: 'Aapka naya resume ban gaya.',
              createdAt: DateTime.now().toUtc().toIso8601String(),
            ),
          ],
        });
    }));

    await repo.list();
    expect(repo.unreadCount.value, 1);

    await repo.markAllRead();
    expect(repo.unreadCount.value, 0);

    final List<AppNotification> after = await repo.list();
    expect(after.every((AppNotification n) => n.read), isTrue);
  });

  test('no session token fails closed with UnauthorizedFailure', () {
    final NotificationsRepositoryImpl repo = _repo(
      MockClient((http.Request req) async => http.Response('{}', 200)),
      token: null,
    );
    expect(repo.list(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('a transport drop maps to a Failure (not a raw exception)', () {
    final NotificationsRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => throw Exception('no network')));
    expect(repo.list(), throwsA(isA<Failure>()));
  });
}
