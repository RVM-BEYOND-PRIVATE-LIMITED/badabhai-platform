import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

void main() {
  group('ApiClient voice-note methods (A2)', () {
    test('uploadVoiceNote POSTs /voice/upload with bearer + PII-free body',
        () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'voice_note_id': 'vn1',
              'duration_seconds': 12,
            }),
            201,
          );
        }),
      );

      final VoiceUploadResult res = await api.uploadVoiceNote(
        authToken: 'tok',
        sessionId: 'sess-1',
        storagePath: 'voice-notes/clip-1.m4a',
        durationSeconds: 12,
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/voice/upload');
      expect(captured.headers['authorization'], 'Bearer tok');
      final Map<String, dynamic> body =
          jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body, <String, dynamic>{
        'session_id': 'sess-1',
        'storage_path': 'voice-notes/clip-1.m4a',
        'duration_seconds': 12,
      });
      // No PII fields on the wire.
      expect(body.containsKey('phone'), isFalse);
      expect(body.containsKey('full_name'), isFalse);
      expect(res.voiceNoteId, 'vn1');
      expect(res.durationSeconds, 12);
    });

    test('transcribeVoiceNote POSTs /voice/transcribe with bearer', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'ai_job_id': 'job-9',
              'status': 'queued',
            }),
            202,
          );
        }),
      );

      final TranscribeResult res = await api.transcribeVoiceNote(
        authToken: 'tok',
        voiceNoteId: 'vn1',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/voice/transcribe');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(
        jsonDecode(captured.body),
        <String, dynamic>{'voice_note_id': 'vn1'},
      );
      expect(res.aiJobId, 'job-9');
      expect(res.status, 'queued');
    });

    // REGRESSION GUARD. This test used to assert the OPPOSITE — path
    // `/ai-jobs/job-9` and `containsKey('authorization') == false` — which pinned
    // the broken contract in place: the route had been put behind
    // InternalServiceGuard and every real poll 401'd, while this test stayed green
    // because MockClient always answers 200. Both assertions are now inverted.
    test('getAiJob hits the WORKER route WITH a bearer token', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'status': 'completed',
              'profile_id': null,
              'voice_note_id': 'vn1',
            }),
            200,
          );
        }),
      );

      final AiJob job = await api.getAiJob('job-9', authToken: 'tok');

      expect(captured.url.path, '/workers/me/ai-jobs/job-9');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(job.isCompleted, isTrue);
      expect(job.isTerminal, isTrue);
      expect(job.voiceNoteId, 'vn1');
      expect(job.profileId, isNull);
    });

    test('getAiJob ignores ops-only fields if a server ever sent them', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'status': 'failed',
                'profile_id': null,
                'voice_note_id': null,
                // None of these are on the worker contract. Parsing them back
                // would re-create the coupling this change removed.
                'error_message': 'write CONNECTION_CLOSED db.internal:5432',
                'ai_usage': <String, dynamic>{'cost_inr': 0.0137},
              }),
              200,
            )),
      );

      final AiJob job = await api.getAiJob('job-9', authToken: 'tok');

      expect(job.isFailed, isTrue);
      expect(job.props, <Object?>['failed', null, null]);
    });

    test('awaitAiJob polls until terminal and returns the job', () async {
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls++;
          final String status = calls < 3 ? 'running' : 'completed';
          return http.Response(
            jsonEncode(<String, dynamic>{
              'status': status,
              'voice_note_id': status == 'completed' ? 'vn1' : null,
            }),
            200,
          );
        }),
      );

      final AiJob job = await api.awaitAiJob(
        'job-9',
        authToken: 'tok',
        pollInterval: const Duration(milliseconds: 1),
      );

      expect(calls, 3);
      expect(job.isCompleted, isTrue);
      expect(job.voiceNoteId, 'vn1');
    });

    test(
        'requestVoiceUploadUrl POSTs /voice/upload-url with bearer + EMPTY '
        'JSON body and parses the ticket', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'storage_path': 'voice-notes/w1/abc.m4a',
              'upload_url': 'https://storage.test/signed-slot',
              'expires_in': 7200,
            }),
            201,
          );
        }),
      );

      final VoiceUploadTicket ticket =
          await api.requestVoiceUploadUrl(authToken: 'tok');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/voice/upload-url');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(jsonDecode(captured.body), <String, dynamic>{});
      expect(ticket.storagePath, 'voice-notes/w1/abc.m4a');
      expect(ticket.uploadUrl, 'https://storage.test/signed-slot');
      expect(ticket.expiresInSeconds, 7200);
    });

    test('requestVoiceUploadUrl surfaces a 503 as ApiException(503)', () {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{'message': 'not enabled'}),
              503,
            )),
      );

      expect(
        () => api.requestVoiceUploadUrl(authToken: 'tok'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 503)),
      );
    });

    test('fetchVoiceNote GETs /voice/:id with bearer and parses transcripts',
        () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'voice_note_id': 'vn1',
              'duration_seconds': 12,
              'transcript_text': 'CNC par 4 saal.',
              'transcript_english': '4 years on CNC.',
              'transcript_confidence': 0.92,
            }),
            200,
          );
        }),
      );

      final VoiceNoteDetail note =
          await api.fetchVoiceNote(authToken: 'tok', voiceNoteId: 'vn1');

      expect(captured.method, 'GET');
      expect(captured.url.path, '/voice/vn1');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(note.voiceNoteId, 'vn1');
      expect(note.transcriptText, 'CNC par 4 saal.');
      expect(note.transcriptEnglish, '4 years on CNC.');
      expect(note.transcriptConfidence, 0.92);
    });

    test('fetchVoiceNote tolerates null transcripts (STT still pending)',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'voice_note_id': 'vn1',
                'duration_seconds': 12,
                'transcript_text': null,
                'transcript_english': null,
                'transcript_confidence': null,
              }),
              200,
            )),
      );

      final VoiceNoteDetail note =
          await api.fetchVoiceNote(authToken: 'tok', voiceNoteId: 'vn1');

      expect(note.transcriptText, isNull);
      expect(note.transcriptEnglish, isNull);
      expect(note.transcriptConfidence, isNull);
    });

    test('awaitAiJob times out (bounded budget) while still queued', () {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{'status': 'queued'}),
              200,
            )),
      );

      expect(
        () => api.awaitAiJob(
          'job-9',
          authToken: 'tok',
          maxAttempts: 2,
          pollInterval: const Duration(milliseconds: 1),
        ),
        throwsA(isA<ProfileExtractionTimeout>()),
      );
    });
  });
}
