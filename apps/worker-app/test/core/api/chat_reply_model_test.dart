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
  // #761 — the advisory lookahead. Parsed defensively like the chips (#371): a
  // malformed entry yields "no prediction" for that key and the reply survives.
  group('lookahead + PredictedQuestion parsing (#761)', () {
    Map<String, dynamic> entry({
      String? key = 'skills',
      String prompt = 'Aapko kaunse kaam aate hain?',
      String kind = 'ask',
    }) =>
        <String, dynamic>{
          'question_key': key,
          'question_kind': kind,
          'prompt_text': prompt,
          'why_text': 'Isse behtar match milta hai.',
          'answer_type': 'single_select',
          'options': <dynamic>[
            <String, dynamic>{'option_key': 'weld', 'label_text': 'Welding'},
            <String, dynamic>{'option_key': 'fit', 'label_text': 'Fitting'},
          ],
          'progress': <String, dynamic>{'answered': 4, 'total': 12},
        };

    test('parses well-formed entries keyed by option_key and __declined', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Kaunsa control?',
        'suggested_followups': <dynamic>['Fanuc', 'Siemens'],
        'lookahead': <String, dynamic>{
          'Fanuc': entry(),
          '__declined': entry(key: 'experience', prompt: 'Kitna anubhav?'),
        },
      });

      expect(reply.lookahead.keys, containsAll(<String>['Fanuc', '__declined']));
      final PredictedQuestion fanuc = reply.lookahead['Fanuc']!;
      expect(fanuc.questionKey, 'skills');
      expect(fanuc.promptText, 'Aapko kaunse kaam aate hain?');
      expect(fanuc.questionKind, ChatQuestionKind.ask);
      expect(fanuc.answerType, 'single_select');
      expect(fanuc.whyText, 'Isse behtar match milta hai.');
      // Options are LABEL strings on chat (the label is the answer of record).
      expect(fanuc.options, <String>['Welding', 'Fitting']);
      expect(fanuc.progress?.answered, 4);
      expect(fanuc.progress?.total, 12);
      expect(reply.lookahead['__declined']!.questionKey, 'experience');
    });

    test('a close prediction has a null question_key and the closing prompt', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aakhri sawaal.',
        'lookahead': <String, dynamic>{
          '__declined': <String, dynamic>{
            'question_kind': 'close',
            'question_key': null,
            'prompt_text': 'Shukriya, aapki poori baat ho gayi.',
          },
        },
      });
      final PredictedQuestion close = reply.lookahead['__declined']!;
      expect(close.questionKind, ChatQuestionKind.close);
      expect(close.questionKey, isNull);
      expect(close.promptText, 'Shukriya, aapki poori baat ho gayi.');
      expect(close.options, isEmpty);
    });

    test('a malformed entry is dropped and the reply survives (#371)', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Bada bhai ka jawaab',
        // A <dynamic, dynamic> map so a non-string key can be exercised.
        'lookahead': <dynamic, dynamic>{
          'good': entry(),
          'no_prompt': <String, dynamic>{'question_key': 'x'}, // no prompt_text
          'blank_prompt': <String, dynamic>{'prompt_text': '   '},
          'not_a_map': 'garbage',
          42: entry(), // non-string key
        },
      });
      expect(reply.reply, 'Bada bhai ka jawaab', reason: 'the reply must survive');
      expect(reply.lookahead.keys, <String>['good'],
          reason: 'every malformed entry is dropped, the good one kept');
    });

    test('a garbage option object is dropped, the rest survive', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'ok',
        'lookahead': <String, dynamic>{
          'k': <String, dynamic>{
            'prompt_text': 'Aage?',
            'options': <dynamic>[
              <String, dynamic>{'option_key': 'a', 'label_text': 'Alpha'},
              42, // not a map
              <String, dynamic>{'option_key': 'b'}, // no label_text
              <String, dynamic>{'label_text': 'Gamma'},
            ],
          },
        },
      });
      expect(reply.lookahead['k']!.options, <String>['Alpha', 'Gamma']);
    });

    test('an absent lookahead is an empty map, not an error', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Theek hai'});
      expect(reply.lookahead, isEmpty);
    });

    test('a non-map lookahead degrades to empty, reply survives', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Theek hai',
        'lookahead': 'nonsense',
      });
      expect(reply.reply, 'Theek hai');
      expect(reply.lookahead, isEmpty);
    });
  });

  // #761 — `suggested_options` is served ALONGSIDE `suggested_followups` and
  // carries the STABLE option_key the `lookahead` map is keyed by, so a chip
  // whose display label differs from that key can still be indexed. Parsed with
  // the same #371 discipline: a garbage entry is dropped, the reply survives.
  group('suggested_options parsing (#761)', () {
    test('a well-formed list parses to ChatOptions with key/label/flag', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Kaunsa kaam?',
        'suggested_followups': <dynamic>['Salad bar attendant', 'Kuch aur'],
        'suggested_options': <dynamic>[
          <String, dynamic>{
            'option_key': 'role_salad_bar',
            'label_text': 'Salad bar attendant',
            'is_none_of_above': false,
          },
          <String, dynamic>{
            'option_key': '__none',
            'label_text': 'Kuch aur',
            'is_none_of_above': true,
          },
        ],
      });

      expect(reply.suggestedOptions, hasLength(2));
      final ChatOption first = reply.suggestedOptions.first;
      expect(first.optionKey, 'role_salad_bar');
      expect(first.labelText, 'Salad bar attendant',
          reason: 'the label is what the chip shows AND submits');
      expect(first.optionKey, isNot(first.labelText),
          reason: 'the whole point: the key is NOT the display label');
      expect(first.isNoneOfAbove, isFalse);
      expect(reply.suggestedOptions.last.isNoneOfAbove, isTrue);
      // Served ALONGSIDE — the followups stay authoritative for display/submit.
      expect(reply.suggestedFollowups,
          <String>['Salad bar attendant', 'Kuch aur']);
    });

    test('a garbage entry is dropped and the reply survives (#371)', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Bada bhai ka jawaab',
        'suggested_options': <dynamic>[
          <String, dynamic>{'option_key': 'a', 'label_text': 'Alpha'},
          42, // not a map
          <String, dynamic>{'option_key': 'b'}, // no label_text
          <String, dynamic>{'label_text': 'Gamma'}, // no option_key
          <String, dynamic>{'option_key': '', 'label_text': 'Blank key'},
          null,
        ],
      });

      expect(reply.reply, 'Bada bhai ka jawaab',
          reason: 'a bad option must never lose the reply');
      expect(reply.suggestedOptions, hasLength(1));
      expect(reply.suggestedOptions.single.optionKey, 'a');
      expect(reply.suggestedOptions.single.labelText, 'Alpha');
    });

    test('a non-bool is_none_of_above reads as false, option survives', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'ok',
        'suggested_options': <dynamic>[
          <String, dynamic>{
            'option_key': 'k',
            'label_text': 'L',
            'is_none_of_above': 'yes', // not a bool
          },
        ],
      });
      expect(reply.suggestedOptions.single.isNoneOfAbove, isFalse);
    });

    test('an absent key yields an empty list (older/deterministic turn)', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Theek hai'});
      expect(reply.suggestedOptions, isEmpty);
    });

    test('a non-list suggested_options degrades to empty, reply survives', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Theek hai',
        'suggested_options': 'nonsense',
      });
      expect(reply.reply, 'Theek hai');
      expect(reply.suggestedOptions, isEmpty);
    });
  });

  // #896 — `tts_text` is the Devanagari rendering of `reply` for read-aloud.
  // Additive/optional: absent, null or blank -> null (an older API build), and
  // read-aloud then speaks the romanized `reply`. Never displayed.
  group('tts_text parsing (#896)', () {
    test('a present Devanagari string parses onto ttsText; reply stays romanized',
        () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Aap kaunsa kaam karte hain?',
        'tts_text': 'आप कौनसा काम करते हैं?',
      });
      expect(reply.reply, 'Aap kaunsa kaam karte hain?',
          reason: 'the shown text is unchanged (romanized)');
      expect(reply.ttsText, 'आप कौनसा काम करते हैं?',
          reason: 'the SPOKEN text is the Devanagari sibling');
    });

    test('an absent tts_text -> null (older API build), reply unchanged', () {
      final ChatReply reply =
          ChatReply.fromJson(<String, dynamic>{'reply': 'Theek hai'});
      expect(reply.ttsText, isNull);
      expect(reply.reply, 'Theek hai');
    });

    test('a null or blank tts_text -> null (never an empty spoken string)', () {
      for (final Object? bad in <Object?>[null, '', '   ']) {
        final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
          'reply': 'ok',
          'tts_text': bad,
        });
        expect(reply.ttsText, isNull, reason: 'blank/null tts_text: $bad');
      }
    });

    test('a non-string tts_text degrades to null, the reply survives (#371)', () {
      final ChatReply reply = ChatReply.fromJson(<String, dynamic>{
        'reply': 'Bada bhai ka jawaab',
        'tts_text': 42,
      });
      expect(reply.reply, 'Bada bhai ka jawaab');
      expect(reply.ttsText, isNull);
    });
  });
}
