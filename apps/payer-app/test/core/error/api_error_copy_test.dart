import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/error/api_error_copy.dart';

/// #2690 (rule 3) — every API failure leaves through ONE catalogue. A known
/// code/status gets its honest line; anything unknown (or a raw exception)
/// gets a safe generic line and never leaks the exception text.
void main() {
  test('a typed server code wins over its status', () {
    expect(
      ApiErrorCopy.forError(
        const PayerApiException(400, code: kJobEditClosedCode),
      ),
      kJobEditClosedMessage,
    );
    expect(
      ApiErrorCopy.forError(
        const PayerApiException(400, code: kPostingTradeRequiredCode),
      ),
      kPostingTradeRequiredMessage,
    );
  });

  test('status fallbacks are human and calm', () {
    expect(ApiErrorCopy.forError(const PayerApiException(429)),
        ApiErrorCopy.busy);
    expect(ApiErrorCopy.forError(const PayerApiException(503)),
        ApiErrorCopy.server);
    expect(ApiErrorCopy.forError(const PayerApiException(404)),
        ApiErrorCopy.notFound);
    expect(ApiErrorCopy.forError(const PayerApiException(401)),
        ApiErrorCopy.session);
  });

  test('an operation keeps its own honest wording', () {
    expect(
      ApiErrorCopy.forError(
        const PayerApiException(409),
        context: 'org.invite',
      ),
      'Already on your team, or your team is full.',
    );
    expect(
      ApiErrorCopy.forError(
        const PayerApiException(503),
        context: 'org.invite',
      ),
      "Couldn't send the invite email. Try again in a bit.",
    );
  });

  test('transport failures map to network / timeout copy', () {
    expect(ApiErrorCopy.forError(const SocketException('dead')),
        ApiErrorCopy.network);
    expect(ApiErrorCopy.forError(TimeoutException('slow')),
        ApiErrorCopy.timeout);
  });

  test('an UNKNOWN code gets the safe generic line, never the raw code', () {
    final String copy = ApiErrorCopy.forError(
      const PayerApiException(418, code: 'SOMETHING_NEW'),
    );
    expect(copy, ApiErrorCopy.generic);
    expect(copy, isNot(contains('SOMETHING_NEW')));
    expect(copy, isNot(contains('418')));
  });

  test('a raw exception never reaches the UI', () {
    final String copy =
        ApiErrorCopy.forError(Exception('secret server text 500'));
    expect(copy, ApiErrorCopy.generic);
    expect(copy, isNot(contains('secret')));
    expect(copy, isNot(contains('500')));
  });
}
