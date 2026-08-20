import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:payer_app/core/data/models.dart' show PayerApiException;
import 'package:payer_app/core/error/payer_failure.dart';

/// The error taxonomy that lets every payer screen name the REAL problem instead
/// of one flat "couldn't load".
void main() {
  group('PayerFailure.from — server responses', () {
    test('401/403 → session (re-auth)', () {
      for (final int s in <int>[401, 403]) {
        final PayerFailure f = PayerFailure.from(PayerApiException(s));
        expect(f.kind, PayerFailureKind.session, reason: 'status $s');
        expect(f.isSessionExpired, isTrue);
        expect(f.statusCode, s);
      }
    });

    test('5xx → server', () {
      for (final int s in <int>[500, 502, 503, 504]) {
        expect(PayerFailure.from(PayerApiException(s)).kind,
            PayerFailureKind.server,
            reason: 'status $s');
      }
    });

    test('404 → notFound', () {
      expect(PayerFailure.from(PayerApiException(404)).kind,
          PayerFailureKind.notFound);
    });

    test('other 4xx → unknown but keeps the status', () {
      final PayerFailure f = PayerFailure.from(PayerApiException(400));
      expect(f.kind, PayerFailureKind.unknown);
      expect(f.statusCode, 400);
    });
  });

  group('PayerFailure.from — transport failures', () {
    test('TimeoutException → timeout (server slow, not a dead link)', () {
      expect(PayerFailure.from(TimeoutException('slow')).kind,
          PayerFailureKind.timeout);
    });

    test('SocketException → network', () {
      expect(PayerFailure.from(const SocketException('no route')).kind,
          PayerFailureKind.network);
    });

    test('http.ClientException → network', () {
      expect(PayerFailure.from(http.ClientException('reset')).kind,
          PayerFailureKind.network);
    });

    test('an unclassifiable error → unknown, never a crash', () {
      expect(PayerFailure.from(const FormatException('weird')).kind,
          PayerFailureKind.unknown);
      expect(PayerFailure.from(null).kind, PayerFailureKind.unknown);
    });
  });

  test('from(PayerFailure) is idempotent (safe to re-wrap)', () {
    const PayerFailure f = PayerFailure(PayerFailureKind.server, statusCode: 500);
    expect(PayerFailure.from(f), same(f));
  });

  test('network copy never blames the connection for a server fault', () {
    // The whole point: a 5xx must NOT read as "check your internet".
    final PayerFailure server = PayerFailure.from(PayerApiException(500));
    expect(server.message.toLowerCase(), isNot(contains('internet')));
    final PayerFailure network =
        PayerFailure.from(http.ClientException('x'));
    expect(network.message.toLowerCase(), contains('internet'));
  });

  test('every kind has a non-empty title + message', () {
    for (final PayerFailureKind k in PayerFailureKind.values) {
      final PayerFailure f = PayerFailure(k);
      expect(f.title, isNotEmpty, reason: '$k title');
      expect(f.message, isNotEmpty, reason: '$k message');
    }
  });
}
