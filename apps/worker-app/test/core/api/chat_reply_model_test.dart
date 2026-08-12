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

  group('OIE Phase 8 fields (#649)', () {
    test('parses progress, question_kind and occupation_label', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aap darzi hain?',
        'progress': <String, dynamic>{'answered': 3, 'total': 12},
        'question_kind': 'disambiguate',
        'occupation_label': 'darzi',
      });
      expect(reply.progress!.answered, 3);
      expect(reply.progress!.total, 12);
      expect(reply.progress!.fraction, closeTo(0.25, 1e-9));
      expect(reply.questionKind, ChatQuestionKind.disambiguate);
      expect(reply.occupationLabel, 'darzi');
    });

    test('an absent set = the safe defaults (no bar, ask, no pill)', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Theek hai'});
      expect(reply.progress, isNull);
      expect(reply.questionKind, ChatQuestionKind.ask);
      expect(reply.occupationLabel, isNull);
    });

    test('a malformed progress hides the bar, never throws the reply away', () {
      for (final Object? bad in <Object?>[
        <String, dynamic>{'answered': 3}, // missing total
        <String, dynamic>{'answered': 'x', 'total': 12}, // non-int
        <String, dynamic>{'answered': 3, 'total': 0}, // zero total
        'nonsense',
        42,
      ]) {
        final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
          'reply': 'Bada bhai ka jawaab',
          'progress': bad,
        });
        expect(reply.reply, 'Bada bhai ka jawaab', reason: 'reply survives');
        expect(reply.progress, isNull, reason: 'bad progress: $bad');
      }
    });

    test('an unknown question_kind falls back to ask', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'ok',
        'question_kind': 'something_new_from_the_future',
      });
      expect(reply.questionKind, ChatQuestionKind.ask);
    });

    test('a non-string occupation_label is null, not a crash', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'ok',
        'occupation_label': 42,
      });
      expect(reply.occupationLabel, isNull);
    });
  });

  group('input_mode parsing (#770)', () {
    test('"options_only" parses to optionsOnly', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aur koi experience jodna hai?',
        'input_mode': 'options_only',
        'suggested_followups': <String>['Haan', 'Nahi'],
      });
      expect(reply.inputMode, ChatInputMode.optionsOnly);
    });

    test('"text" parses to text', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aap kya kaam karte hain?',
        'input_mode': 'text',
      });
      expect(reply.inputMode, ChatInputMode.text);
    });

    test('an absent input_mode defaults to text (older/deterministic turn)', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'ok'});
      expect(reply.inputMode, ChatInputMode.text);
    });

    test('an unknown/non-string input_mode falls back to text, reply survives',
        () {
      for (final Object? bad in <Object?>[
        'freeform_from_the_future',
        42,
        <String, dynamic>{'mode': 'options_only'},
        true,
      ]) {
        final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
          'reply': 'Bada bhai ka jawaab',
          'input_mode': bad,
        });
        expect(reply.reply, 'Bada bhai ka jawaab', reason: 'reply survives');
        expect(
          reply.inputMode,
          ChatInputMode.text,
          reason: 'bad input_mode never hides the composer: $bad',
        );
      }
    });
  });
}
