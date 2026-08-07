import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/widgets/voice_choice_chips.dart';

void main() {
  Future<void> pump(
    WidgetTester tester, {
    required VoiceQuestion question,
    required ValueChanged<List<String>> onChips,
    required ValueChanged<bool> onBoolean,
  }) {
    return tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: VoiceChoiceChips(
          question: question,
          onChips: onChips,
          onBoolean: onBoolean,
        ),
      ),
    ));
  }

  testWidgets('a boolean question is answerable with a single tap', (t) async {
    bool? value;
    await pump(
      t,
      question: const VoiceQuestion(
          id: 'b', prompt: 'Kaam karte hain?', kind: VoiceQuestionKind.boolean),
      onChips: (_) {},
      onBoolean: (bool v) => value = v,
    );

    expect(find.text(kVoiceBooleanYes), findsOneWidget);
    expect(find.text(kVoiceBooleanNo), findsOneWidget);
    await t.tap(find.text(kVoiceBooleanYes));
    expect(value, isTrue);
  });

  testWidgets('a single-select tap submits exactly that one key', (t) async {
    List<String>? keys;
    await pump(
      t,
      question: const VoiceQuestion(
        id: 's',
        prompt: 'Shift?',
        kind: VoiceQuestionKind.singleSelect,
        options: <VoiceChoice>[
          VoiceChoice(key: 'day', label: 'Din'),
          VoiceChoice(key: 'night', label: 'Raat'),
        ],
      ),
      onChips: (List<String> k) => keys = k,
      onBoolean: (_) {},
    );

    await t.tap(find.text('Raat'));
    expect(keys, <String>['night']);
  });

  testWidgets('multi-select accumulates taps and submits N keys', (t) async {
    List<String>? keys;
    await pump(
      t,
      question: const VoiceQuestion(
        id: 'm',
        prompt: 'Kaunse kaam?',
        kind: VoiceQuestionKind.multiSelect,
        options: <VoiceChoice>[
          VoiceChoice(key: 'welding', label: 'Welding'),
          VoiceChoice(key: 'fitting', label: 'Fitting'),
          VoiceChoice(key: 'painting', label: 'Painting'),
        ],
      ),
      onChips: (List<String> k) => keys = k,
      onBoolean: (_) {},
    );

    await t.tap(find.text('Welding'));
    await t.tap(find.text('Painting'));
    await t.pump();
    await t.tap(find.text(kVoiceMultiSubmit));
    expect(keys, <String>['welding', 'painting']);
  });

  testWidgets('multi-select submit is disabled until something is chosen',
      (t) async {
    List<String>? keys;
    await pump(
      t,
      question: const VoiceQuestion(
        id: 'm',
        prompt: 'Kaunse kaam?',
        kind: VoiceQuestionKind.multiSelect,
        options: <VoiceChoice>[VoiceChoice(key: 'welding', label: 'Welding')],
      ),
      onChips: (List<String> k) => keys = k,
      onBoolean: (_) {},
    );

    await t.tap(find.text(kVoiceMultiSubmit));
    await t.pump();
    expect(keys, isNull, reason: 'a zero-key multi submit is never valid');
  });
}
