import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/auth/payer_account_deleted_signal.dart';

/// The RESERVED account-deleted trigger: HTTP **410** AND a
/// `code == PAYER_ACCOUNT_DELETED`, read from either the top-level body or the
/// API's `{ error: { code } }` envelope. BOTH the status AND the exact code are
/// required, so no generic error can ever cause a false destructive logout.
void main() {
  group('isPayerAccountDeletedResponse', () {
    test('410 + TOP-LEVEL code → true', () {
      expect(
        isPayerAccountDeletedResponse(
          410,
          <String, dynamic>{'code': 'PAYER_ACCOUNT_DELETED'},
        ),
        isTrue,
      );
    });

    test('410 + NESTED error.code (the real AllExceptionsFilter shape) → true',
        () {
      expect(
        isPayerAccountDeletedResponse(410, <String, dynamic>{
          'statusCode': 410,
          'error': <String, dynamic>{
            'code': 'PAYER_ACCOUNT_DELETED',
            'message': 'This account no longer exists.',
          },
        }),
        isTrue,
      );
    });

    test('410 with a DIFFERENT code (either shape) → false', () {
      expect(
        isPayerAccountDeletedResponse(
          410,
          <String, dynamic>{'code': 'RESOURCE_GONE'},
        ),
        isFalse,
      );
      expect(
        isPayerAccountDeletedResponse(410, <String, dynamic>{
          'error': <String, dynamic>{'code': 'RESOURCE_GONE'},
        }),
        isFalse,
      );
    });

    test('a bare 410 (no code) → false', () {
      expect(isPayerAccountDeletedResponse(410, <String, dynamic>{}), isFalse);
      expect(
        isPayerAccountDeletedResponse(410, <String, dynamic>{
          'error': <String, dynamic>{'message': 'Gone.'},
        }),
        isFalse,
      );
    });

    test('a null body → false', () {
      expect(isPayerAccountDeletedResponse(410, null), isFalse);
    });

    test('the code on a NON-410 status → false (a 401/500 is never deletion)',
        () {
      for (final int status in <int>[200, 401, 404, 500]) {
        expect(
          isPayerAccountDeletedResponse(
            status,
            <String, dynamic>{'code': 'PAYER_ACCOUNT_DELETED'},
          ),
          isFalse,
          reason: '$status carrying the code must not trigger deletion',
        );
        expect(
          isPayerAccountDeletedResponse(status, <String, dynamic>{
            'error': <String, dynamic>{'code': 'PAYER_ACCOUNT_DELETED'},
          }),
          isFalse,
        );
      }
    });

    test('the reserved code constant is exactly PAYER_ACCOUNT_DELETED', () {
      expect(kPayerAccountDeletedCode, 'PAYER_ACCOUNT_DELETED');
    });
  });

  group('AccountDeletedSignal', () {
    test('fire() emits on the broadcast stream', () async {
      final AccountDeletedSignal signal = AccountDeletedSignal();
      addTearDown(signal.dispose);

      final Future<void> first = signal.stream.first;
      signal.fire();

      await first; // completes → an event was delivered
    });

    test('fire() is safe to call repeatedly (parallel 410s)', () async {
      final AccountDeletedSignal signal = AccountDeletedSignal();
      int seen = 0;
      final sub = signal.stream.listen((_) => seen++);
      addTearDown(sub.cancel);

      signal
        ..fire()
        ..fire()
        ..fire();
      await Future<void>.delayed(Duration.zero);

      expect(seen, 3, reason: 'every fire is delivered; the app root debounces');
    });

    test('fire() after dispose is a no-op, never throws', () {
      final AccountDeletedSignal signal = AccountDeletedSignal();
      signal.dispose();
      expect(signal.fire, returnsNormally);
    });
  });
}
