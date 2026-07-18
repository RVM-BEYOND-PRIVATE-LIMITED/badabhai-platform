import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/notifications/data/notification_read_store.dart';
import 'package:badabhai_worker_app/features/notifications/data/notifications_repository_impl.dart';
import 'package:badabhai_worker_app/features/notifications/domain/app_notification.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

NotificationsRepositoryImpl _repo(
  MockClient client, {
  String? token = 'tok',
  NotificationReadStore? store,
}) =>
    NotificationsRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
      readStore: store,
    );

/// In-memory [NotificationReadStore] standing in for shared_preferences (which
/// throws under `flutter test` without mock init) — the same fake-the-backend
/// shape as FakePrefs in test/core/auth/fakes.dart. The backing [ids] survive a
/// repository re-instantiation, which is how these tests simulate a cold start.
class _FakeReadStore implements NotificationReadStore {
  _FakeReadStore([List<String>? backing]) : ids = backing ?? <String>[];

  final List<String> ids;

  @override
  Future<List<String>> read() async => List<String>.of(ids);

  @override
  Future<void> write(List<String> next) async {
    ids
      ..clear()
      ..addAll(next);
  }
}

/// A store that fails every call — a corrupt prefs XML from a restored backup,
/// an unregistered plugin, a full disk. Stands in for #355's unreadable secure
/// store.
class _BrokenReadStore implements NotificationReadStore {
  const _BrokenReadStore();

  @override
  Future<List<String>> read() async => throw Exception('prefs unavailable');

  @override
  Future<void> write(List<String> ids) async =>
      throw Exception('prefs unavailable');
}

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

  // --- #456 / TD90: read-state must outlive the app process -----------------

  group('durable read state', () {
    /// A stable two-row feed: one security alert + one resume row. The SAME
    /// rows are served to every repository instance, exactly as the append-only
    /// events spine would after a restart.
    MockClient feed() => MockClient((http.Request req) async => _ok(
          <String, dynamic>{
            'notifications': <Map<String, dynamic>>[
              _noti(
                id: 'e1',
                type: 'security',
                title: 'Naye device se login',
                body: 'Aapke account mein ek naye device se login hua.',
                createdAt: DateTime.now().toUtc().toIso8601String(),
              ),
              _noti(
                id: 'e2',
                type: 'resume_ready',
                title: 'Resume taiyaar hai',
                body: 'Aapka naya resume ban gaya.',
                createdAt: DateTime.now().toUtc().toIso8601String(),
              ),
            ],
          },
        ));

    test('a read SECURITY alert stays read across a cold start (the TD90 bug)',
        () async {
      final _FakeReadStore store = _FakeReadStore();

      // Process 1: worker opens Alerts, reads the takeover alert, force-quits.
      final NotificationsRepositoryImpl first = _repo(feed(), store: store);
      await first.list();
      expect(first.unreadCount.value, 2);
      await first.markAllRead();

      // Process 2: a brand-new repository over the SAME device store — this is
      // the cold start that used to resurrect "Naye device se login" as unread
      // and train the worker to ignore it.
      final NotificationsRepositoryImpl second = _repo(feed(), store: store);
      final List<AppNotification> after = await second.list();

      expect(after.every((AppNotification n) => n.read), isTrue);
      expect(second.unreadCount.value, 0);
    });

    test('the badge is already 0 on the cold-start refresh(), before Alerts is '
        'even opened', () async {
      final _FakeReadStore store = _FakeReadStore(<String>['e1', 'e2']);
      final NotificationsRepositoryImpl repo = _repo(feed(), store: store);

      await repo.refresh();

      expect(repo.unreadCount.value, 0);
    });

    test('markAllRead persists the shown ids', () async {
      final _FakeReadStore store = _FakeReadStore();
      final NotificationsRepositoryImpl repo = _repo(feed(), store: store);

      await repo.list();
      expect(store.ids, isEmpty); // listing alone writes nothing
      await repo.markAllRead();

      expect(store.ids, containsAll(<String>['e1', 'e2']));
    });

    test('only opaque event ids are persisted — no title/body/phone', () async {
      final _FakeReadStore store = _FakeReadStore();
      final NotificationsRepositoryImpl repo = _repo(feed(), store: store);

      await repo.list();
      await repo.markAllRead();

      // The store is PLAIN prefs, so the same bright line the feed itself holds
      // applies to what we write there: ids only, never copy or identity.
      expect(store.ids, <String>['e1', 'e2']);
      for (final String id in store.ids) {
        expect(id, isNot(contains('login')));
        expect(id, isNot(contains('+91')));
        expect(id, isNot(matches(RegExp(r'\d{4,}'))));
      }
    });

    test('an unread alert arriving AFTER the read sweep still lights the badge',
        () async {
      final _FakeReadStore store = _FakeReadStore(<String>['e1', 'e2']);
      // Same store, but the server now has a third, never-seen event.
      final NotificationsRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => _ok(<String, dynamic>{
              'notifications': <Map<String, dynamic>>[
                _noti(
                  id: 'e3',
                  type: 'security',
                  title: 'Naye device se login',
                  body: 'Aapke account mein ek naye device se login hua.',
                  createdAt: DateTime.now().toUtc().toIso8601String(),
                ),
                _noti(
                  id: 'e1',
                  type: 'security',
                  title: 'Naye device se login',
                  body: 'Aapke account mein ek naye device se login hua.',
                  createdAt: DateTime.now().toUtc().toIso8601String(),
                ),
              ],
            })),
        store: store,
      );

      final List<AppNotification> items = await repo.list();

      // Persisting read-state must not blanket-mute the feed: e3 is new.
      expect(
          items.firstWhere((AppNotification n) => n.id == 'e3').read, isFalse);
      expect(items.firstWhere((AppNotification n) => n.id == 'e1').read, isTrue);
      expect(repo.unreadCount.value, 1);
    });

    test('markAllRead called BEFORE any list() does not clobber stored ids',
        () async {
      // _persist REPLACES the stored set, so an un-hydrated write here would
      // wipe every previously-read id instead of adding to it.
      final _FakeReadStore store = _FakeReadStore(<String>['old1', 'old2']);
      final NotificationsRepositoryImpl repo = _repo(feed(), store: store);

      await repo.markAllRead();

      expect(store.ids, containsAll(<String>['old1', 'old2']));
    });

    test('the persisted set is capped, evicting OLDEST first and keeping the '
        'newest read ids', () async {
      final List<String> old = List<String>.generate(
        NotificationsRepositoryImpl.maxPersistedReadIds,
        (int i) => 'old$i',
      );
      final _FakeReadStore store = _FakeReadStore(List<String>.of(old));
      final NotificationsRepositoryImpl repo = _repo(feed(), store: store);

      await repo.list();
      await repo.markAllRead();

      // Bounded: an append-only spine would otherwise grow this forever.
      expect(
          store.ids, hasLength(NotificationsRepositoryImpl.maxPersistedReadIds));
      // The just-read rows survive; the oldest ids are the ones dropped. The cap
      // is 10x the server's 50-row feed, so nothing evictable is still on screen.
      expect(store.ids, containsAll(<String>['e1', 'e2']));
      expect(store.ids, isNot(contains('old0')));
      expect(store.ids, contains('old${old.length - 1}'));
    });
  });

  group('a broken read store degrades instead of breaking the feed', () {
    MockClient feed() => MockClient((http.Request req) async => _ok(
          <String, dynamic>{
            'notifications': <Map<String, dynamic>>[
              _noti(
                id: 'e1',
                type: 'security',
                title: 'Naye device se login',
                body: 'Aapke account mein ek naye device se login hua.',
                createdAt: DateTime.now().toUtc().toIso8601String(),
              ),
            ],
          },
        ));

    test('list() still returns the rows when the store throws on read',
        () async {
      final NotificationsRepositoryImpl repo =
          _repo(feed(), store: const _BrokenReadStore());

      // A wrong badge beats no feed: an unreadable store must never turn the
      // Alerts screen into a failure state that HIDES the security alert.
      final List<AppNotification> items = await repo.list();
      expect(items, hasLength(1));
      expect(items.single.id, 'e1');
      expect(repo.unreadCount.value, 1);
    });

    test('markAllRead still clears the badge when the store throws on write',
        () async {
      final NotificationsRepositoryImpl repo =
          _repo(feed(), store: const _BrokenReadStore());

      await repo.list();
      await repo.markAllRead(); // must not throw

      expect(repo.unreadCount.value, 0);
      // Degrades to EXACTLY the old in-memory behaviour: read for this process.
      final List<AppNotification> after = await repo.list();
      expect(after.single.read, isTrue);
    });

    test('the default store (no shared_preferences under flutter test) also '
        'degrades rather than throwing', () async {
      // No `store:` — the repository builds its real SharedPrefs-backed store,
      // whose plugin is unavailable in a plain `flutter test`. Same posture.
      final NotificationsRepositoryImpl repo = _repo(feed());

      final List<AppNotification> items = await repo.list();
      expect(items, hasLength(1));
      await repo.markAllRead();
      expect(repo.unreadCount.value, 0);
    });
  });
}
