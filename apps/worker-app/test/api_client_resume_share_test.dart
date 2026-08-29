import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// #1317 — the app shared the résumé but never called the server's share
/// endpoint, so `resume.shared` read zero by construction. These pin the wire
/// contract of the new [ApiClient.shareResume] and the closed channel enum.
void main() {
  group('ApiClient.shareResume', () {
    test('POSTs the channel to /resume/:id/share with the bearer token',
        () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
      );

      await api.shareResume(
        resumeId: 'r1',
        channel: 'whatsapp',
        authToken: 'tok',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/resume/r1/share');
      expect(captured.headers['authorization'], 'Bearer tok');
      final Map<String, dynamic> body =
          jsonDecode(captured.body) as Map<String, dynamic>;
      // ONLY the closed-enum channel — no link, no id, no PII on the wire.
      expect(body, <String, dynamic>{'channel': 'whatsapp'});
    });

    test('a non-2xx throws ApiException (best-effort swallowing is the CALLER\'s '
        'job, not the client seam\'s)', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{}), 500)),
      );

      expect(
        api.shareResume(resumeId: 'r1', channel: 'other', authToken: 'tok'),
        throwsA(isA<ApiException>()),
      );
    });
  });

  group('kResumeShareChannels', () {
    // The single source of truth is the server DTO: ShareResumeSchema.channel =
    // z.enum(["whatsapp","link","download","other"]) in
    // apps/api/src/resume/resume.dto.ts. A client value outside this set is a
    // 400, so this test is the drift tripwire — if the server enum changes, the
    // client const must change in the SAME PR and this assertion catches a miss.
    test('matches the server ShareResumeSchema enum EXACTLY', () {
      expect(
        kResumeShareChannels,
        <String>{'whatsapp', 'link', 'download', 'other'},
      );
    });
  });
}
