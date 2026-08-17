import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// The extraction half of TD59 — the same bug, on the route the fix never
/// reached.
///
/// The client waited exactly 14s (40 x 350ms) for a profile-extraction job. One
/// such job is allowed ~50s of PROVIDER time alone: `PROFILE_JOB_TIMEOUT_MS` in
/// `apps/api/src/ai/ai.service.ts` is 25s and the job spends it TWICE, in
/// sequence — `/profile/parse` types the answer map, then Phase C's
/// `/profiling/extract` reads the conversation for `experiences[]` ("A SECOND
/// CALL, AND DELIBERATELY SO"). On top of that sit queue pickup, the provenance
/// gates, the projector and the profile write.
///
/// So the worker tapped "Ho gaya — meri profile banaiye", was told "Profile
/// taiyaar nahi ho payi. Zyada time lag raha hai." at 14s, and the server then
/// completed, billed and stored the profile they had just been told they did not
/// have. Reproduced on a real device against the live backend. These lock in the
/// fix.
void main() {
  group('profile extraction poll budget', () {
    /// `PROFILE_JOB_TIMEOUT_MS`, duplicated deliberately: the two constants live
    /// in different languages with no shared module to import, so the coupling
    /// is written down in the one place that can fail when it breaks.
    const Duration serverPerCallTimeout = Duration(seconds: 25);

    /// One job spends that bound twice, sequentially.
    final Duration serverCeiling = serverPerCallTimeout * 2; // ~50s

    test('the budget EXCEEDS the ~50s server ceiling', () {
      final Duration budget =
          kAiJobPollInterval * kProfileExtractPollMaxAttempts;

      expect(
        budget,
        greaterThan(serverCeiling),
        reason: 'the client would give up while the server is still working — '
            'the exact failure this budget exists to prevent',
      );
      // Margin for queue pickup, the gates, the projector and the write.
      expect(budget, greaterThanOrEqualTo(const Duration(seconds: 80)));
      expect(kProfileExtractWaitBudget,
          greaterThanOrEqualTo(const Duration(seconds: 80)));
    });

    test('it is no longer the generic 14s default that caused the timeout', () {
      final Duration old = kAiJobPollInterval * kAiJobPollMaxAttempts;
      expect(old, const Duration(seconds: 14));
      expect(old, lessThan(serverCeiling), reason: 'this is why it always failed');
      expect(kProfileExtractPollMaxAttempts, greaterThan(kAiJobPollMaxAttempts));
    });

    test('buys time, not traffic — backoff keeps the request count modest', () {
      // A flat cadence would be ~257 polls. The 8x cap lands it in the
      // thirties-to-forties across jitter draws; 60 is the loose bound that
      // proves the shape without pinning the exact curve.
      final List<Duration> schedule = buildAiJobPollSchedule(
        maxAttempts: kProfileExtractPollMaxAttempts,
      );
      expect(schedule.length, lessThan(60));
      final Duration total = schedule.fold(
        Duration.zero,
        (Duration sum, Duration d) => sum + d,
      );
      expect(total, kAiJobPollInterval * kProfileExtractPollMaxAttempts);
    });

    /// A job still running on the 20th poll.
    ///
    /// 20 IS CHOSEN AGAINST THE BACKOFF CURVE, not the attempt count. With the
    /// 8x cap the OLD 14s budget spends its whole allowance in ~8 polls, while
    /// the new one lands between 28 and 45 depending on the jitter draw. So 20
    /// is unreachable under the old budget and always reached under the new one
    /// — the assertion holds on every seed rather than most of them.
    MockClient stillRunningUntilPoll20(void Function() onCall) =>
        MockClient((http.Request req) async {
          onCall();
          return http.Response(
            jsonEncode(<String, dynamic>{'status': 'running'}),
            200,
          );
        });

    test('a slow extraction now RESOLVES where the old budget gave up',
        () async {
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          calls++;
          final String status = calls < 20 ? 'running' : 'completed';
          return http.Response(
            jsonEncode(<String, dynamic>{
              'status': status,
              'profile_id': status == 'completed' ? 'p1' : null,
            }),
            200,
          );
        }),
      );

      // Default budget; the interval is squeezed only so the test is fast. What
      // is being exercised is the POLL COUNT the budget buys.
      final String profileId = await api.awaitProfileId(
        'job-1',
        authToken: 'tok',
        pollInterval: const Duration(milliseconds: 1),
      );

      expect(profileId, 'p1');
      expect(calls, 20, reason: 'it must not give up before the job lands');
    });

    test('...and the OLD budget would have failed that same job', () async {
      // The other half of the proof: same job, old ceiling, worker sees
      // "Profile taiyaar nahi ho payi".
      int calls = 0;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: stillRunningUntilPoll20(() => calls++),
      );

      await expectLater(
        api.awaitProfileId(
          'job-1',
          authToken: 'tok',
          maxAttempts: kAiJobPollMaxAttempts, // the 14s default that shipped
          pollInterval: const Duration(milliseconds: 1),
        ),
        throwsA(isA<ProfileExtractionTimeout>()),
      );
      expect(calls, lessThan(20), reason: 'the old budget never reached poll 20');
    });
  });
}
