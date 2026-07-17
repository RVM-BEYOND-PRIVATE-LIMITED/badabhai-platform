import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';

/// #371 — ChatReply.fromJson mapped `suggested_followups` with
/// `(e) => e as String`, so ONE non-string entry threw a raw TypeError out of
/// parsing and destroyed the whole reply: bada bhai's answer was lost over a
/// cosmetic chip. The chips are a nice-to-have; the reply is the product.
void main() {
  group('ChatReply.suggestedFollowups parsing (#371)', () {
    test('keeps the usable strings and drops a non-string entry', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Got it.',
        'suggested_followups': <dynamic>['Haan', 42, 'Nahi', null],
      });

      expect(reply.reply, 'Got it.', reason: 'the reply must survive');
      expect(reply.suggestedFollowups, <String>['Haan', 'Nahi']);
    });

    test('an all-garbage list degrades to no chips, not a crash', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Badhiya!',
        'suggested_followups': <dynamic>[
          null,
          1,
          <String, dynamic>{'nested': 'object'},
        ],
      });

      expect(reply.reply, 'Badhiya!');
      expect(reply.suggestedFollowups, isEmpty);
    });

    test('a missing key still yields an empty list', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Theek hai'});
      expect(reply.suggestedFollowups, isEmpty);
    });

    test('the normal all-string case is unchanged', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Kaunsa control?',
        'suggested_followups': <dynamic>['Fanuc', 'Siemens'],
      });
      expect(reply.suggestedFollowups, <String>['Fanuc', 'Siemens']);
    });
  });
}
