import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// #378 — AI-job polling used to be a FLAT 350ms x 40 loop: ~3 requests/second
/// for a full 14s on a metered prepaid connection, with every device hitting
/// /ai-jobs in lockstep. These lock in the fix: same total budget (the voice /
/// extraction UX depends on it), far fewer requests, de-synced across devices.
void main() {
  group('buildAiJobPollSchedule (#378)', () {
    const int attempts = kAiJobPollMaxAttempts;
    const Duration interval = kAiJobPollInterval;
    final Duration budget = interval * attempts;

    test('spends EXACTLY the old total budget — the wait is never shortened',
        () {
      // Seeded across many draws: jitter must never eat into or overrun the
      // 14s the caller budgeted.
      for (int seed = 0; seed < 50; seed++) {
        final List<Duration> schedule = buildAiJobPollSchedule(
          random: math.Random(seed),
        );
        final Duration total = schedule.fold(
          Duration.zero,
          (Duration sum, Duration d) => sum + d,
        );
        expect(total, budget, reason: 'seed $seed drifted off the budget');
      }
    });

    test('backs off — it fits the budget in far fewer polls than the old 40',
        () {
      for (int seed = 0; seed < 50; seed++) {
        final List<Duration> schedule =
            buildAiJobPollSchedule(random: math.Random(seed));
        // The whole point: same 14s, ~8 requests instead of 40.
        expect(schedule.length, lessThan(15), reason: 'seed $seed');
        expect(schedule.length, greaterThan(3), reason: 'seed $seed');
      }
    });

    test('gaps grow exponentially and then cap', () {
      final List<Duration> schedule =
          buildAiJobPollSchedule(random: math.Random(7));

      // First gap stays near the base interval (jitter is +/-25%), so a job
      // that finishes quickly is still noticed quickly.
      expect(schedule.first.inMicroseconds,
          lessThanOrEqualTo((interval.inMicroseconds * 1.25).round()));
      // ...and the widest gap is multiples of it (capped at 8x the base).
      final int widest = schedule
          .map((Duration d) => d.inMicroseconds)
          .reduce((int a, int b) => a > b ? a : b);
      expect(widest, greaterThanOrEqualTo(interval.inMicroseconds * 4));
      expect(widest, lessThanOrEqualTo((interval.inMicroseconds * 8 * 1.25).round()));
    });

    test('is jittered, so a herd of devices does not poll in lockstep', () {
      // Two devices drawing different randomness must not produce identical
      // schedules — that was the old fixed-cadence failure mode.
      final List<Duration> a = buildAiJobPollSchedule(random: math.Random(1));
      final List<Duration> b = buildAiJobPollSchedule(random: math.Random(2));
      expect(a, isNot(equals(b)));
    });

    test('degenerate budgets yield no polls rather than looping forever', () {
      expect(buildAiJobPollSchedule(maxAttempts: 0), isEmpty);
      expect(buildAiJobPollSchedule(pollInterval: Duration.zero), isEmpty);
    });
  });

  group('ApiClient AI-job polling uses the backoff schedule (#378)', () {
    http.Response queuedJob(String id) => http.Response(
          jsonEncode(<String, dynamic>{
            'id': id,
            'job_type': 'profile_extraction',
            'status': 'queued',
          }),
          200,
        );

    test('awaitProfileId makes far fewer than maxAttempts requests', () async {
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls++;
          return queuedJob('job-1');
        }),
      );

      await expectLater(
        api.awaitProfileId(
          'job-1',
          maxAttempts: 40,
          pollInterval: const Duration(milliseconds: 1),
        ),
        throwsA(isA<ProfileExtractionTimeout>()),
      );

      // Old behaviour: exactly 40 round-trips. Backed off: a handful.
      expect(calls, lessThan(15));
      expect(calls, greaterThan(1));
    });

    test('awaitAiJob makes far fewer than maxAttempts requests', () async {
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls++;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'id': 'job-9',
              'job_type': 'transcription',
              'status': 'running',
            }),
            200,
          );
        }),
      );

      await expectLater(
        api.awaitAiJob(
          'job-9',
          maxAttempts: 40,
          pollInterval: const Duration(milliseconds: 1),
        ),
        throwsA(isA<ProfileExtractionTimeout>()),
      );

      expect(calls, lessThan(15));
      expect(calls, greaterThan(1));
    });

    test('still waits out the full budget before timing out', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => queuedJob('job-1')),
      );

      final Stopwatch sw = Stopwatch()..start();
      await expectLater(
        api.awaitProfileId(
          'job-1',
          maxAttempts: 20,
          pollInterval: const Duration(milliseconds: 5),
        ),
        throwsA(isA<ProfileExtractionTimeout>()),
      );
      sw.stop();

      // Budget is 20 x 5ms = 100ms. Fewer requests must NOT mean a shorter
      // wait — that would break the extraction/transcription UX (#282).
      expect(sw.elapsedMilliseconds, greaterThanOrEqualTo(90));
    });

    test('first poll fires immediately — an already-done job is not delayed',
        () async {
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls++;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'id': 'job-1',
              'job_type': 'profile_extraction',
              'status': 'completed',
              'output_ref': <String, dynamic>{'profile_id': 'p1'},
            }),
            200,
          );
        }),
      );

      final Stopwatch sw = Stopwatch()..start();
      final String profileId = await api.awaitProfileId('job-1');
      sw.stop();

      expect(profileId, 'p1');
      expect(calls, 1);
      // No initial delay was introduced: with real 350ms defaults this returns
      // in well under one poll interval.
      expect(sw.elapsedMilliseconds, lessThan(300));
    });
  });
}
