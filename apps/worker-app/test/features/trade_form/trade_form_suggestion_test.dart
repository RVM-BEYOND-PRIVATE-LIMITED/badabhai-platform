import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/selection_cards.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_question_body.dart';

/// Ruling D2 — "facts render prefilled, capability chips render HIGHLIGHTED BUT
/// UNTICKED, because a pre-ticked chip puts a capability on a man's profile
/// that he never claimed" — and ruling D7: a question may carry BOTH an answer
/// and a suggestion, the stored answer always wins, and both are shown.
///
/// #1499 / ADR-0041 RI-4. Options render as the Master UI Kit's option cards;
/// a résumé hint is the [TradeFormSuggestedOption] frame around a card.
const String _kConfirm = 'Aapke resume mein ye tha — sahi hai';

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

Map<String, dynamic> _screen({
  required String key,
  required String answerType,
  List<String> optionKeys = const <String>[],
  Map<String, dynamic>? answer,
  Map<String, dynamic>? suggestion,
  bool searchable = false,
}) =>
    <String, dynamic>{
      'type': 'question',
      'question': <String, dynamic>{
        'question_key': key,
        'prompt_text': 'Prompt for $key',
        'why_text': null,
        'answer_type': answerType,
        'options': <dynamic>[
          for (final String k in optionKeys)
            <String, dynamic>{
              'option_key': k,
              'label_text': 'Label $k',
              'is_none_of_above': false,
            },
        ],
      },
      'ui': <String, dynamic>{'searchable': searchable},
      'answer': answer,
      if (suggestion != null) 'suggestion': suggestion,
    };

Map<String, dynamic> _suggestion({
  List<String> optionKeys = const <String>[],
  String? text,
  num? number,
  bool? boolValue,
  double confidence = 0.8,
}) =>
    <String, dynamic>{
      'values': <String, dynamic>{
        'option_keys': optionKeys,
        'text': text,
        'number': number,
        'bool': boolValue,
      },
      'source': 'resume',
      'confidence': confidence,
    };

Future<TradeForm?> _load(List<Map<String, dynamic>> screens) {
  final ApiClient api = ApiClient(
    baseUrl: 'http://test',
    client: MockClient((http.Request req) async => http.Response(
          jsonEncode(<String, dynamic>{
            'kind': 'cnc_turner',
            'pack_id': 'qp_cnc_turning',
            'pack_version': 1,
            'sections': <dynamic>[
              <String, dynamic>{
                'id': 'capability',
                'title': 'Capability',
                'screens': screens,
              },
            ],
          }),
          200,
        )),
  );
  return TradeFormRepositoryImpl(api, _session()).loadForm();
}

TradeFormQuestionStep _firstQuestion(TradeForm form) =>
    form.sections.first.screens.whereType<TradeFormQuestionStep>().first;

Future<void> _pumpQuestion(
  WidgetTester tester,
  TradeFormQuestionStep step,
) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: TradeFormQuestionBody(
          step: step,
          enabled: true,
          isLastStep: false,
          onSubmitChips: (_) {},
          onSubmitBoolean: (_) {},
          onSubmitText: (_) {},
          onDecline: () {},
        ),
      ),
    ),
  );
  await tester.pump();
}

MultiSelectQuestionCard _multiCard(WidgetTester tester, String label) =>
    tester.widget<MultiSelectQuestionCard>(find.ancestor(
      of: find.text(label),
      matching: find.byType(MultiSelectQuestionCard),
    ));

SingleSelectQuestionCard _singleCard(WidgetTester tester, String label) =>
    tester.widget<SingleSelectQuestionCard>(find.ancestor(
      of: find.text(label),
      matching: find.byType(SingleSelectQuestionCard),
    ));

/// Whether the card carrying [label] sits inside the résumé-hint frame.
bool _isHinted(WidgetTester tester, String label) => find
    .ancestor(
      of: find.text(label),
      matching: find.byType(TradeFormSuggestedOption),
    )
    .evaluate()
    .isNotEmpty;

/// The fill a card actually paints — the only honest way to assert "hinted but
/// unticked", because the distinction IS the paint. The nearest [Material]
/// above a card's title is that card's own surface.
Color _cardFill(WidgetTester tester, String label) => tester
    .widget<Material>(
      find.ancestor(of: find.text(label), matching: find.byType(Material)).first,
    )
    .color!;

/// The docked bar's next button.
ElevatedButton _submitButton(WidgetTester tester, String label) =>
    tester.widget<ElevatedButton>(find.widgetWithText(ElevatedButton, label));

void main() {
  group('parsing', () {
    test('a suggestion is parsed and is NOT an answer', () async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe', 'vtl'],
          suggestion: _suggestion(optionKeys: <String>['cnc_lathe']),
        ),
      ]);

      final TradeFormQuestionStep step = _firstQuestion(form!);
      expect(step.hasSuggestion, isTrue);
      expect(step.suggestion!.optionKeys, <String>['cnc_lathe']);
      expect(step.suggestion!.confidence, 0.8);
      // THE distinction: a suggestion has no status, so it can never be read
      // as a settled answer. `answer` stays null.
      expect(step.answer, isNull);
      expect(step.isAnswered, isFalse);
    });

    test('an absent suggestion reads as null — every question, every box today',
        () async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
        ),
      ]);

      final TradeFormQuestionStep step = _firstQuestion(form!);
      expect(step.suggestion, isNull);
      expect(step.hasSuggestion, isFalse);
    });

    test('an EMPTY suggestion is the same as none', () async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
          suggestion: _suggestion(),
        ),
      ]);

      // One null for the renderer to branch on, not two.
      expect(_firstQuestion(form!).suggestion, isNull);
    });

    test('a missing confidence reads as 0 and does not lose the suggestion',
        () async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        <String, dynamic>{
          ..._screen(
            key: 'iti_project',
            answerType: 'text',
          ),
          'suggestion': <String, dynamic>{
            'values': <String, dynamic>{
              'option_keys': <String>[],
              'text': 'Drill jig banaya tha',
              'number': null,
              'bool': null,
            },
            'source': 'resume',
          },
        },
      ]);

      final TradeFormQuestionStep step = _firstQuestion(form!);
      // The number is observability, not a gate — its absence must not lose
      // the one thing the worker can actually use.
      expect(step.suggestion!.confidence, 0);
      expect(step.suggestion!.text, 'Drill jig banaya tha');
    });

    test('a question may carry BOTH an answer and a suggestion', () async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe', 'vtl'],
          answer: <String, dynamic>{
            'status': 'answered',
            'option_keys': <String>['vtl'],
            'text': null,
            'number': null,
            'bool': null,
          },
          suggestion: _suggestion(optionKeys: <String>['cnc_lathe']),
        ),
      ]);

      final TradeFormQuestionStep step = _firstQuestion(form!);
      // Nothing overwrites anything (ruling D7).
      expect(step.answer!.optionKeys, <String>['vtl']);
      expect(step.suggestion!.optionKeys, <String>['cnc_lathe']);
    });
  });

  group('ruling D2 — capability options are HIGHLIGHTED BUT UNTICKED', () {
    testWidgets('a suggested multi-select card is hinted, never selected', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe', 'vtl'],
          suggestion: _suggestion(optionKeys: <String>['cnc_lathe']),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // THE assertion of the whole ruling: pointed at, not claimed.
      expect(_isHinted(tester, 'Label cnc_lathe'), isTrue);
      expect(_multiCard(tester, 'Label cnc_lathe').isSelected, isFalse);

      // And it looks different from both a plain card and a chosen one, or the
      // distinction is invisible and therefore not a distinction: a plain card
      // carries no hint frame, and the hinted card does NOT paint the selected
      // fill.
      expect(_isHinted(tester, 'Label vtl'), isFalse);
      expect(find.text(kTradeFormSuggestedTag), findsOneWidget);
      expect(
        _cardFill(tester, 'Label cnc_lathe'),
        isNot(OnboardingColors.selectedCardBg),
      );
      expect(_cardFill(tester, 'Label cnc_lathe'), OnboardingColors.paperWhite);
    });

    testWidgets('the submit button stays DISABLED on a suggestion alone', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe', 'vtl'],
          suggestion: _suggestion(optionKeys: <String>['cnc_lathe']),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // This is the failure mode the ruling is about: a screen that LOOKS
      // answered gets submitted unread, and a capability the worker never
      // claimed lands on his profile. A suggestion must not satisfy the gate.
      expect(_submitButton(tester, 'Aage badhein').onPressed, isNull);
    });

    testWidgets('a suggested BOOLEAN highlights without answering', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'drawing_reading',
          answerType: 'boolean',
          suggestion: _suggestion(boolValue: true),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // A yes/no on these packs is a capability claim, so the same rule binds.
      expect(_isHinted(tester, 'Haan'), isTrue);
      expect(_singleCard(tester, 'Haan').isSelected, isFalse);
      expect(_isHinted(tester, 'Nahi'), isFalse);
      expect(_singleCard(tester, 'Nahi').isSelected, isFalse);
      // Not answered, so nothing to send.
      expect(_submitButton(tester, 'Aage badhein').onPressed, isNull);
    });

    testWidgets('a suggested SEARCHABLE card is hinted and never hidden', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'material_worked',
          answerType: 'multi_select',
          searchable: true,
          optionKeys: <String>['mild_steel', 'brass'],
          suggestion: _suggestion(optionKeys: <String>['brass']),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      expect(_isHinted(tester, 'Label brass'), isTrue);
      expect(_multiCard(tester, 'Label brass').isSelected, isFalse);

      // A query that does not match the hint must not filter it away — a hint
      // the worker cannot find is not a hint.
      await tester.enterText(find.byType(TextField), 'mild');
      await tester.pump();
      expect(find.text('Label brass'), findsOneWidget);
      expect(_isHinted(tester, 'Label brass'), isTrue);
    });
  });

  group('ruling D2 — facts DO render prefilled', () {
    testWidgets('a text fact prefills the field', (WidgetTester tester) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'iti_project',
          answerType: 'text',
          suggestion: _suggestion(text: 'Drill jig banaya tha'),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // A transcription is safe to prefill: a wrong one is visibly wrong and
      // trivially corrected, which is not true of a tick.
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Drill jig banaya tha',
      );
      // And the submit gate opens, because there IS something in the field.
      expect(_submitButton(tester, 'Aage badhein').onPressed, isNotNull);
    });

    testWidgets('a numeric fact prefills without a trailing .0', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'years',
          answerType: 'number',
          suggestion: _suggestion(number: 4),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // "4.0 saal" in a field a worker is meant to confirm reads like a
      // machine talking.
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '4',
      );
    });
  });

  group('ruling D7 — the stored answer always wins, and both are shown', () {
    testWidgets('a saved text answer beats the suggestion in the field', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'iti_project',
          answerType: 'text',
          answer: <String, dynamic>{
            'status': 'answered',
            'option_keys': <String>[],
            'text': 'Jo maine likha tha',
            'number': null,
            'bool': null,
          },
          suggestion: _suggestion(text: 'Jo resume mein tha'),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'Jo maine likha tha',
      );
      // BOTH shown: a worker who is disagreeing is entitled to see what with.
      expect(find.textContaining(_kConfirm), findsOneWidget);
      expect(find.text('Jo resume mein tha'), findsOneWidget);
    });

    testWidgets('a card that is both answered and suggested reads as SELECTED',
        (WidgetTester tester) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe', 'vtl'],
          answer: <String, dynamic>{
            'status': 'answered',
            'option_keys': <String>['cnc_lathe'],
            'text': null,
            'number': null,
            'bool': null,
          },
          suggestion: _suggestion(optionKeys: <String>['cnc_lathe', 'vtl']),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // He chose this one: the kit's selected fill, and it never dims back to
      // a hint.
      expect(_multiCard(tester, 'Label cnc_lathe').isSelected, isTrue);
      expect(
        _cardFill(tester, 'Label cnc_lathe'),
        OnboardingColors.selectedCardBg,
      );
      // The résumé also pointed at this one — still not a tick.
      expect(_multiCard(tester, 'Label vtl').isSelected, isFalse);
      expect(_isHinted(tester, 'Label vtl'), isTrue);
    });
  });

  group('the confirm line', () {
    testWidgets('asks rather than states', (WidgetTester tester) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
          suggestion: _suggestion(optionKeys: <String>['cnc_lathe']),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // A screen that presents a suggestion as a finding gets agreement
      // instead of an answer.
      expect(find.textContaining(_kConfirm), findsOneWidget);
    });

    testWidgets('is absent when there is no suggestion', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // ADDITIVE: a question with no suggestion renders exactly the form it
      // rendered before #1499 — no confirm line and no hint frame.
      expect(find.textContaining(_kConfirm), findsNothing);
      expect(find.byType(TradeFormSuggestedOption), findsNothing);
    });

    testWidgets('never prints the confidence number', (
      WidgetTester tester,
    ) async {
      final TradeForm? form = await _load(<Map<String, dynamic>>[
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
          suggestion: _suggestion(
            optionKeys: <String>['cnc_lathe'],
            confidence: 0.42,
          ),
        ),
      ]);
      await _pumpQuestion(tester, _firstQuestion(form!));

      // Observability, not copy: a percentage invites a worker to argue with a
      // number instead of answering a question.
      expect(find.textContaining('0.42'), findsNothing);
      expect(find.textContaining('42'), findsNothing);
    });
  });
}
