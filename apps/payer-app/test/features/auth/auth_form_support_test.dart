import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/auth/payer_auth_api.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/auth/presentation/widgets/auth_form_support.dart';

/// The shared auth copy + policy mirror. #2597 adds two cases (the code door's
/// 409 and a 2xx without a session); every earlier mapping must read the same.
void main() {
  group('authErrorFor', () {
    test('#2597 — the 409 points at the temporary password, on either door',
        () {
      const PayerPasswordChangeRequiredException e =
          PayerPasswordChangeRequiredException();
      expect(authErrorFor(e, otp: true), kTemporaryPasswordSignInCopy);
      expect(authErrorFor(e), kTemporaryPasswordSignInCopy);
    });

    test('#2597 — a 2xx without a session blames the server, not the payer',
        () {
      expect(authErrorFor(const PayerApiException(200)),
          "We couldn't complete that right now. Please try again in a moment.");
    });

    test('a bare 409 keeps the old generic line', () {
      expect(authErrorFor(const PayerApiException(409)),
          "We couldn't complete that. Please check your details and try again.");
    });

    test('earlier mappings are unchanged', () {
      expect(authErrorFor(const PayerApiException(401)),
          'Wrong email, phone or company name, or password.');
      expect(authErrorFor(const PayerApiException(429), otp: true),
          'Too many attempts. Please wait a minute and try again.');
      expect(authErrorFor(const PayerApiException(400)),
          'Please check the details and try again.');
      expect(authErrorFor(const PayerApiException(503)),
          "We couldn't complete that right now. Please try again in a moment.");
      expect(authErrorFor(const PayerApiException(500), otp: true),
          "We couldn't send your code right now. Please try again in a moment.");
      expect(authErrorFor(const PayerApiException(403), otp: true),
          "We couldn't send your code. Please check your details and try again.");
      expect(authErrorFor(TimeoutException('slow')),
          'Could not reach the server. Check your connection and retry.');
    });
  });

  group('passwordPolicyProblem', () {
    test('mirrors the server policy with the same copy as before', () {
      expect(passwordPolicyProblem('abc1'), 'Use at least 8 characters.');
      expect(passwordPolicyProblem('a1' * 65), 'Use at most 128 characters.');
      expect(passwordPolicyProblem('12345678'), 'Add at least one letter.');
      expect(passwordPolicyProblem('abcdefgh'), 'Add at least one number.');
      expect(passwordPolicyProblem('abcdefg1'), isNull);
    });
  });
}
