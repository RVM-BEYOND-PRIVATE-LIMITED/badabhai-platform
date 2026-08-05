import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/settings/data/notification_prefs_repository_impl.dart';

SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

NotificationPrefsRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    NotificationPrefsRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

http.Response _json(Object body, [int status = 200]) => http.Response(
      jsonEncode(body),
      status,
      headers: const <String, String>{'content-type': 'application/json'},
    );

void main() {
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('defaults ON when neither local nor server has a value (endpoint absent)',
      () async {
    // 404 = the backend has not shipped the route yet → fail-soft to local default.
    final NotificationPrefsRepositoryImpl repo =
        _repo(MockClient((http.Request req) async => _json(<String, dynamic>{}, 404)));
    expect(await repo.isEnabled(), isTrue);
  });

  test('prefers the SERVER value (cross-device) and caches it locally', () async {
    final NotificationPrefsRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      expect(req.method, 'GET');
      expect(req.url.path, '/workers/me/notification-prefs');
      return _json(<String, dynamic>{'notifications_enabled': false});
    }));
    expect(await repo.isEnabled(), isFalse);
    // Cached through to prefs (so a later offline read still returns OFF).
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('bb_notifications_enabled'), isFalse);
  });

  test('setEnabled writes the local cache AND PATCHes the server', () async {
    final List<http.Request> reqs = <http.Request>[];
    final NotificationPrefsRepositoryImpl repo = _repo(MockClient((http.Request req) async {
      reqs.add(req);
      return _json(<String, dynamic>{'notifications_enabled': false});
    }));

    await repo.setEnabled(false);

    final http.Request patch = reqs.singleWhere((http.Request r) => r.method == 'PATCH');
    expect(patch.url.path, '/workers/me/notification-prefs');
    expect(jsonDecode(patch.body), <String, dynamic>{'notifications_enabled': false});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('bb_notifications_enabled'), isFalse);
  });

  test('setEnabled is best-effort: a failed server PATCH still persists locally',
      () async {
    final NotificationPrefsRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => _json(<String, dynamic>{'m': 'no route'}, 404)));
    // Must not throw even though the endpoint is missing.
    await repo.setEnabled(false);
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('bb_notifications_enabled'), isFalse,
        reason: 'the toggle sticks on-device regardless of the server');
  });

  test('onLogout clears the local value so the next worker does not inherit it',
      () async {
    final NotificationPrefsRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => _json(<String, dynamic>{}, 404)));
    await repo.setEnabled(false);
    repo.onLogout();
    // Allow the fire-and-forget clear to run.
    await Future<void>.delayed(Duration.zero);
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('bb_notifications_enabled'), isNull);
  });
}
