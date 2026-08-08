import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// TD59 / #635 — the client transcript-wait budget was exactly 14s (40 x 350ms),
/// but the server's structural ceiling for even a short answer is ~140s. That
/// 10:1 mismatch made the client give up and tell the worker to retry WHILE the
/// server completed, billed and stored the transcript. These lock in the fix.
void main() {
  group('voice transcript poll budget (#635 / TD59)', () {
    test('the budget EXCEEDS the ~140s server ceiling', () {
      // storage 20s + Sarvam 60s + translate 60s = ~140s.
      expect(kVoiceTranscriptWaitBudget,
          greaterThanOrEqualTo(const Duration(seconds: 140)));
    });

    test('it is far larger than the 14s extraction default that caused TD59', () {
      expect(kVoiceTranscriptPollMaxAttempts,
          greaterThan(kAiJobPollMaxAttempts));
      final Duration extractionBudget =
          kAiJobPollInterval * kAiJobPollMaxAttempts; // 14s
      final Duration transcriptBudget =
          kAiJobPollInterval * kVoiceTranscriptPollMaxAttempts;
      expect(transcriptBudget, greaterThan(extractionBudget));
    });

    test('the poll schedule actually spends the whole ~150s budget', () {
      final List<Duration> schedule =
          buildAiJobPollSchedule(maxAttempts: kVoiceTranscriptPollMaxAttempts);
      final Duration total = schedule.fold(
        Duration.zero,
        (Duration sum, Duration d) => sum + d,
      );
      expect(total, greaterThanOrEqualTo(const Duration(seconds: 140)));
      // Backoff keeps the request COUNT modest across the long wait — not one
      // request per 350ms for 150s.
      expect(schedule.length, lessThan(120));
    });

    test(
        'awaitAiJob drives a slow transcription PAST the old 40-poll (14s) '
        'budget and still resolves', () async {
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls++;
          // Stays pending well past the OLD 40-attempt / 14s ceiling.
          final String status = calls < 45 ? 'running' : 'completed';
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
        maxAttempts: kVoiceTranscriptPollMaxAttempts,
        pollInterval: const Duration(milliseconds: 1), // keep the test fast
      );

      expect(calls, 45, reason: 'it must not give up at 40 like the old budget');
      expect(job.isCompleted, isTrue);
      expect(job.voiceNoteId, 'vn1');
    });
  });
}
