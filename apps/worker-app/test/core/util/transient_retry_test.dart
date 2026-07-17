import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/util/transient_retry.dart';

/// The download reported "Server error (500). Thodi der baad try karein." and
/// then worked on the very next tap — because a 500 was never retried, only the
/// 409 was. A blip the worker fixes by tapping again is a blip the app should
/// have ridden out itself.
void main() {
  group('isTransientFailure', () {
    test('5xx is transient — the server fell over, it did not answer', () {
      expect(isTransientFailure(const ServerFailure(500)), isTrue);
      expect(isTransientFailure(const ServerFailure(502)), isTrue);
      expect(isTransientFailure(const ServerFailure(503)), isTrue);
      expect(isTransientFailure(const ServerFailure(504)), isTrue);
    });

    test('a TIMEOUT is NOT retried — it is already a 60s bounded wait', () {
      // Retrying would make the worker wait 3 MINUTES before hearing anything.
      expect(isTransientFailure(TimeoutException('slow')), isFalse);
    });

    test('a transport failure is NOT retried — it is honest and instant', () {
      // "No internet" needs saying at once, not after 30s of hopeful retries;
      // the worker can see their own signal bar.
      expect(isTransientFailure(const NetworkFailure()), isFalse);
      expect(isTransientFailure(const SocketException('down')), isFalse);
      expect(isTransientFailure(http.ClientException('reset')), isFalse);
    });

    test('4xx is NOT — it is the server\'s considered answer', () {
      // Retrying these just fails again, slower.
      expect(isTransientFailure(const ServerFailure(400)), isFalse);
      expect(isTransientFailure(const UnauthorizedFailure()), isFalse);
      expect(isTransientFailure(const ResumeNotReadyFailure()), isFalse);
      expect(isTransientFailure(const ProfileIncompleteFailure()), isFalse);
    });

    test('429 is NOT retried — that is how you stay rate-limited', () {
      expect(isTransientFailure(const RateLimitedFailure()), isFalse);
      expect(isTransientFailure(const ServerFailure(429)), isFalse);
    });
  });

  group('retryTransient', () {
    test('a 500 then success is invisible to the worker', () async {
      int calls = 0;
      final String out = await retryTransient(
        () async {
          calls++;
          if (calls == 1) throw const ServerFailure(500);
          return 'ok';
        },
        backoff: Duration.zero,
      );

      expect(out, 'ok');
      expect(calls, 2, reason: 'the app tapped again, so the worker need not');
    });

    test('gives up honestly once the budget is spent', () async {
      int calls = 0;
      await expectLater(
        retryTransient(
          () async {
            calls++;
            throw const ServerFailure(500);
          },
          backoff: Duration.zero,
        ),
        throwsA(isA<ServerFailure>()),
      );
      // Bounded: this rides out a blip, it does not hammer a server that is down.
      expect(calls, kTransientRetryAttempts);
    });

    test('a 4xx fails FAST — no pointless waiting', () async {
      int calls = 0;
      await expectLater(
        retryTransient(
          () async {
            calls++;
            throw const UnauthorizedFailure();
          },
          backoff: Duration.zero,
        ),
        throwsA(isA<UnauthorizedFailure>()),
      );
      expect(calls, 1);
    });

    test('succeeds first time without retrying', () async {
      int calls = 0;
      await retryTransient(() async {
        calls++;
        return 'ok';
      }, backoff: Duration.zero);
      expect(calls, 1);
    });
  });
}
