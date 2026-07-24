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

  // #478 CHAT-UE-1 + asked_question_id — additive, parsed defensively like the
  // chips so a malformed value can never take down the whole reply.
  group('unanswered_essentials + asked_question_id parsing', () {
    test('parses the topic ids and keeps ESSENTIAL_TOPICS order', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aur bataiye.',
        'asked_question_id': 'machines',
        'unanswered_essentials': <dynamic>['machines', 'current_location'],
      });
      expect(reply.askedQuestionId, 'machines');
      expect(reply.unansweredEssentials, <String>['machines', 'current_location']);
    });

    test('absent keys -> null id + empty essentials (older API build)', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Theek hai'});
      expect(reply.askedQuestionId, isNull);
      expect(reply.unansweredEssentials, isEmpty);
    });

    test('a non-string asked_question_id degrades to null, reply survives', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Badhiya!',
        'asked_question_id': 42,
      });
      expect(reply.reply, 'Badhiya!');
      expect(reply.askedQuestionId, isNull);
    });

    test('a garbage essentials entry is dropped, the rest survive', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aur bataiye.',
        'unanswered_essentials': <dynamic>['role', 7, null, 'experience'],
      });
      expect(reply.unansweredEssentials, <String>['role', 'experience']);
    });
  });
}
