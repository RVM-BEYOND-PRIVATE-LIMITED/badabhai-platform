import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/error/failure_mapper.dart';
import 'package:badabhai_worker_app/core/error/failure_reason.dart';

void main() {
  group('mapError', () {
    test('403 -> ConsentRequiredFailure', () {
      expect(mapError(ApiException(403, 'x')), isA<ConsentRequiredFailure>());
    });

    test('401 -> UnauthorizedFailure', () {
      expect(mapError(ApiException(401, 'x')), isA<UnauthorizedFailure>());
    });

    test('403 WORKER_ACCOUNT_SUSPENDED -> WorkerSuspendedFailure (not consent)',
        () {
      final Failure f = mapError(ApiException(
        403,
        'This account is suspended.',
        body: <String, dynamic>{
          'code': 'WORKER_ACCOUNT_SUSPENDED',
          'restricted_token': 'restricted-abc',
        },
      ));

      expect(f, isA<WorkerSuspendedFailure>());
      expect(f, isNot(isA<ConsentRequiredFailure>()));
      expect((f as WorkerSuspendedFailure).restrictedToken, 'restricted-abc');
      expect(failureReason(f).reason, contains('suspend'));
    });

    test('suspended 403 through the real { error: { code } } envelope works',
        () {
      final Failure f = mapError(ApiException(
        403,
        'This account is suspended.',
        body: <String, dynamic>{
          'error': <String, dynamic>{
            'code': 'WORKER_ACCOUNT_SUSPENDED',
            'restricted_token': 'nested-token',
          },
        },
      ));

      expect((f as WorkerSuspendedFailure).restrictedToken, 'nested-token');
    });

    test('suspended 403 WITHOUT a restricted token still maps to the type',
        () {
      final Failure f = mapError(ApiException(
        403,
        'This account is suspended.',
        body: <String, dynamic>{'code': 'WORKER_ACCOUNT_SUSPENDED'},
      ));

      expect(f, isA<WorkerSuspendedFailure>());
      expect((f as WorkerSuspendedFailure).restrictedToken, isNull);
    });

    test('a plain 403 (no suspended code) is still ConsentRequiredFailure',
        () {
      expect(
        mapError(ApiException(403, 'consent', body: <String, dynamic>{})),
        isA<ConsentRequiredFailure>(),
      );
    });

    // #1013 — a 400 used to fall into the ServerFailure arm and render "Server
    // error (400). Thodi der baad try karein.", which sends the worker away to
    // retry a request the server will refuse identically forever.
    test('400 -> InvalidRequestFailure, and its copy NEVER says to wait', () {
      final Failure f = mapError(ApiException(400, 'message is too long'));
      expect(f, isA<InvalidRequestFailure>());
      expect(f, isNot(isA<ServerFailure>()));
      expect(failureReason(f).reason, isNot(contains('Thodi der baad')));
      // And still PII-safe: the server body is not forwarded.
      expect(f.message, isNot(contains('too long')));
    });

    test('429 -> RateLimitedFailure (per-IP download cap)', () {
      expect(mapError(ApiException(429, 'x')), isA<RateLimitedFailure>());
    });

    test('other status -> ServerFailure carrying the code', () {
      final Failure f = mapError(ApiException(500, 'boom'));
      expect(f, isA<ServerFailure>());
      expect((f as ServerFailure).statusCode, 500);
    });

    test('does NOT forward the server message (PII-safe)', () {
      final Failure f =
          mapError(ApiException(500, 'sensitive +919912345678 detail'));
      expect(f.message, isNot(contains('9912345678')));
      expect(f.message, isNot(contains('sensitive')));
    });

    test('ProfileExtractionTimeout -> ProfileTimeoutFailure', () {
      final Failure f = mapError(ProfileExtractionTimeout('job-1'));
      expect(f, isA<ProfileTimeoutFailure>());
      expect((f as ProfileTimeoutFailure).aiJobId, 'job-1');
    });

    test('SocketException -> NetworkFailure', () {
      expect(mapError(const SocketException('x')), isA<NetworkFailure>());
    });

    test('TimeoutException -> NetworkFailure', () {
      expect(mapError(TimeoutException('x')), isA<NetworkFailure>());
    });

    test('http.ClientException -> NetworkFailure', () {
      expect(mapError(http.ClientException('x')), isA<NetworkFailure>());
    });

    test('anything else -> UnknownFailure', () {
      expect(mapError(Exception('x')), isA<UnknownFailure>());
    });

    test('an existing Failure passes through unchanged', () {
      const Failure f = NetworkFailure();
      expect(mapError(f), same(f));
    });
  });
}
