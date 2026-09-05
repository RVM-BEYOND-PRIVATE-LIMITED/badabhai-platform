import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/widgets/voice_choice_chips.dart';

/// [BbChip.selected] for the chip carrying [label] — the direct way to assert
/// a pre-tick without depending on colour/decoration internals.
bool _chipSelected(WidgetTester tester, String label) {
  return tester
      .widget<BbChip>(find.byWidgetPredicate(
        (Widget w) => w is BbChip && w.label == label,
      ))
      .selected;
}

void main() {
  group('applyNoneOfAboveRule (#1382)', () {
    const List<VoiceChoice> options = <VoiceChoice>[
      VoiceChoice(key: 'cnc_lathe', label: 'CNC lathe'),
      VoiceChoice(key: 'conventional_lathe', label: 'Conventional lathe'),
      VoiceChoice(key: 'none_of_these', label: 'In me se koi nahi', isNoneOfAbove: true),
    ];

    test('selecting the none-of-above option clears every other selection',
        () {
      final List<String> next = applyNoneOfAboveRule(
        current: <String>['cnc_lathe', 'conventional_lathe'],
        key: 'none_of_these',
        options: options,
      );
      expect(next, <String>['none_of_these']);
    });

    test('selecting a real option clears a previously-selected none-of-above',
        () {
      final List<String> next = applyNoneOfAboveRule(
        current: <String>['none_of_these'],
        key: 'cnc_lathe',
        options: options,
      );
      expect(next, <String>['cnc_lathe']);
    });

    test('a normal select accumulates when no none-of-above is involved', () {
      final List<String> next = applyNoneOfAboveRule(
        current: <String>['cnc_lathe'],
        key: 'conventional_lathe',
        options: options,
      );
      expect(next, <String>['cnc_lathe', 'conventional_lathe']);
    });

    test('deselecting is untouched by the rule (toggle-off, not exclusion)',
        () {
      final List<String> next = applyNoneOfAboveRule(
        current: <String>['none_of_these'],
        key: 'none_of_these',
        options: options,
      );
      expect(next, isEmpty);
    });
  });

  Future<void> pump(
    WidgetTester tester, {
    required VoiceQuestion question,
    required ValueChanged<List<String>> onChips,
    required ValueChanged<bool> onBoolean,
    List<String>? initialSelected,
  }) {
    return tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: VoiceChoiceChips(
          question: question,
          onChips: onChips,
          onBoolean: onBoolean,
          initialSelected: initialSelected,
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

  testWidgets(
      'REGRESSION: multi-select selection does NOT leak into the next question',
      (t) async {
    List<String>? keys;
    const VoiceQuestion q1 = VoiceQuestion(
      id: 'q1',
      prompt: 'Kaunse kaam?',
      kind: VoiceQuestionKind.multiSelect,
      options: <VoiceChoice>[
        VoiceChoice(key: 'welding', label: 'Welding'),
        VoiceChoice(key: 'fitting', label: 'Fitting'),
      ],
    );
    const VoiceQuestion q2 = VoiceQuestion(
      id: 'q2', // a DIFFERENT question, same widget position, no ValueKey
      prompt: 'Aur kya?',
      kind: VoiceQuestionKind.multiSelect,
      options: <VoiceChoice>[
        VoiceChoice(key: 'painting', label: 'Painting'),
      ],
    );

    await pump(t,
        question: q1,
        onChips: (List<String> k) => keys = k,
        onBoolean: (_) {});
    await t.tap(find.text('Welding'));
    await t.pump();

    // The parent rebuilds in place with Q2 — State is reused, initState does
    // not re-run. Only didUpdateWidget can clear the carried selection.
    await pump(t,
        question: q2,
        onChips: (List<String> k) => keys = k,
        onBoolean: (_) {});
    await t.tap(find.text('Painting'));
    await t.pump();
    await t.tap(find.text(kVoiceMultiSubmit));
    await t.pump();

    expect(keys, <String>['painting'],
        reason: 'Q1\'s "welding" must not ride along with Q2\'s answer');
  });

  group('VoiceChoiceChips none-of-above mutual exclusion (#1382)', () {
    const VoiceQuestion q = VoiceQuestion(
      id: 'turning_machine',
      prompt: 'Aap kaunsi turning machine chalate hain?',
      kind: VoiceQuestionKind.multiSelect,
      options: <VoiceChoice>[
        VoiceChoice(key: 'cnc_lathe', label: 'CNC lathe'),
        VoiceChoice(key: 'conventional_lathe', label: 'Conventional lathe'),
        VoiceChoice(
            key: 'none_of_these',
            label: 'In me se koi nahi',
            isNoneOfAbove: true),
      ],
    );

    testWidgets('tapping none-of-above clears every other selection',
        (t) async {
      List<String>? keys;
      await pump(t, question: q, onChips: (List<String> k) => keys = k, onBoolean: (_) {});

      await t.tap(find.text('CNC lathe'));
      await t.tap(find.text('Conventional lathe'));
      await t.pump();
      expect(_chipSelected(t, 'CNC lathe'), isTrue);
      expect(_chipSelected(t, 'Conventional lathe'), isTrue);

      await t.tap(find.text('In me se koi nahi'));
      await t.pump();

      expect(_chipSelected(t, 'CNC lathe'), isFalse);
      expect(_chipSelected(t, 'Conventional lathe'), isFalse);
      expect(_chipSelected(t, 'In me se koi nahi'), isTrue);

      await t.tap(find.text(kVoiceMultiSubmit));
      expect(keys, <String>['none_of_these']);
    });

    testWidgets('tapping a real option clears a selected none-of-above',
        (t) async {
      List<String>? keys;
      await pump(t, question: q, onChips: (List<String> k) => keys = k, onBoolean: (_) {});

      await t.tap(find.text('In me se koi nahi'));
      await t.pump();
      expect(_chipSelected(t, 'In me se koi nahi'), isTrue);

      await t.tap(find.text('CNC lathe'));
      await t.pump();

      expect(_chipSelected(t, 'In me se koi nahi'), isFalse);
      expect(_chipSelected(t, 'CNC lathe'), isTrue);

      await t.tap(find.text(kVoiceMultiSubmit));
      expect(keys, <String>['cnc_lathe']);
    });
  });

  group('VoiceChoiceChips initialSelected seeding (#1382)', () {
    const VoiceQuestion q = VoiceQuestion(
      id: 'material_worked',
      prompt: 'Aap kaunsi dhaatu par kaam karte hain?',
      kind: VoiceQuestionKind.multiSelect,
      options: <VoiceChoice>[
        VoiceChoice(key: 'mild_steel', label: 'Mild steel'),
        VoiceChoice(key: 'brass', label: 'Brass'),
      ],
    );

    testWidgets('a saved answer pre-ticks its chips on mount', (t) async {
      await pump(
        t,
        question: q,
        onChips: (_) {},
        onBoolean: (_) {},
        initialSelected: const <String>['mild_steel'],
      );

      expect(_chipSelected(t, 'Mild steel'), isTrue);
      expect(_chipSelected(t, 'Brass'), isFalse);
    });

    testWidgets('no initialSelected still starts empty (unchanged default)',
        (t) async {
      await pump(t, question: q, onChips: (_) {}, onBoolean: (_) {});

      expect(_chipSelected(t, 'Mild steel'), isFalse);
      expect(_chipSelected(t, 'Brass'), isFalse);
    });
  });
}
