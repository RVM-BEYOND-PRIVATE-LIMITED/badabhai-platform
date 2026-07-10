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

    test('getAiJob parses a completed transcription output_ref (NO auth header)',
        () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'id': 'job-9',
              'job_type': 'transcription',
              'status': 'completed',
              'output_ref': <String, dynamic>{'voice_note_id': 'vn1'},
              'error_message': null,
            }),
            200,
          );
        }),
      );

      final AiJob job = await api.getAiJob('job-9');

      expect(captured.url.path, '/ai-jobs/job-9');
      expect(captured.headers.containsKey('authorization'), isFalse);
      expect(job.isCompleted, isTrue);
      expect(job.isTerminal, isTrue);
      expect(job.voiceNoteId, 'vn1');
      expect(job.profileId, isNull);
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
              'id': 'job-9',
              'job_type': 'transcription',
              'status': status,
              'output_ref': status == 'completed'
                  ? <String, dynamic>{'voice_note_id': 'vn1'}
                  : null,
            }),
            200,
          );
        }),
      );

      final AiJob job = await api.awaitAiJob(
        'job-9',
        pollInterval: const Duration(milliseconds: 1),
      );

      expect(calls, 3);
      expect(job.isCompleted, isTrue);
      expect(job.voiceNoteId, 'vn1');
    });

    test('awaitAiJob times out (bounded budget) while still queued', () {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'id': 'job-9',
                'job_type': 'transcription',
                'status': 'queued',
              }),
              200,
            )),
      );

      expect(
        () => api.awaitAiJob(
          'job-9',
          maxAttempts: 2,
          pollInterval: const Duration(milliseconds: 1),
        ),
        throwsA(isA<ProfileExtractionTimeout>()),
      );
    });
  });
}
