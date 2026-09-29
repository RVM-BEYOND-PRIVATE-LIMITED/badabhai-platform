import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/selection_cards.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_question_body.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

/// #1519 — "typed custom answer, everywhere". The server takes
/// `{kind: 'text', text}` on single/multi-select questions, stores it in place
/// of any chips, and replays it as `answer.other_text` (with `option_keys: []`
/// and `text: null`). These pin the client half: parse it, offer
/// "Koi aur — khud likhein", send it as text, and never reopen such a question
/// looking blank.
SessionRepository _session() =>
    SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

Map<String, dynamic> _screen({
  required String key,
  required String answerType,
  List<String> optionKeys = const <String>[],
  Object? answer,
  bool searchable = false,
}) => <String, dynamic>{
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
};

Future<TradeFormQuestionStep> _loadOne(Map<String, dynamic> screen) async {
  final ApiClient api = ApiClient(
    baseUrl: 'http://test',
    client: MockClient(
      (http.Request req) async => http.Response(
        jsonEncode(<String, dynamic>{
          'kind': 'cnc_turner',
          'pack_id': 'qp_cnc_turning',
          'pack_version': 1,
          'sections': <dynamic>[
            <String, dynamic>{
              'id': 'capability',
              'title': 'Capability',
              'screens': <dynamic>[screen],
            },
          ],
        }),
        200,
      ),
    ),
  );
  final TradeForm? form = await TradeFormRepositoryImpl(
    api,
    _session(),
  ).loadForm();
  return form!.sections.first.screens.whereType<TradeFormQuestionStep>().first;
}

/// What the docked bar / callbacks reported.
class _Sent {
  List<String>? chips;
  String? text;
}

Future<_Sent> _pump(WidgetTester tester, TradeFormQuestionStep step) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  tester.view.physicalSize = const Size(900, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final _Sent sent = _Sent();
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: TradeFormQuestionBody(
          step: step,
          enabled: true,
          isLastStep: false,
          onSubmitChips: (List<String> keys) => sent.chips = keys,
          onSubmitBoolean: (_) {},
          onSubmitText: (String text) => sent.text = text,
          onDecline: () {},
        ),
      ),
    ),
  );
  await tester.pump();
  return sent;
}

ElevatedButton _next(WidgetTester tester) => tester.widget<ElevatedButton>(
  find.widgetWithText(ElevatedButton, 'Aage badhein'),
);

Future<void> _tapNext(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(ElevatedButton, 'Aage badhein'));
  await tester.pump();
}

bool _multiSelected(WidgetTester tester, String label) => tester
    .widget<MultiSelectQuestionCard>(
      find.ancestor(
        of: find.text(label),
        matching: find.byType(MultiSelectQuestionCard),
      ),
    )
    .isSelected;

bool _singleSelected(WidgetTester tester, String label) => tester
    .widget<SingleSelectQuestionCard>(
      find.ancestor(
        of: find.text(label),
        matching: find.byType(SingleSelectQuestionCard),
      ),
    )
    .isSelected;

/// The one [TextField] the "Koi aur" box adds (no search box on these).
TextField _otherBox(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField));

class _MockRepo extends Mock implements TradeFormRepository {}

void main() {
  group('parsing answer.other_text', () {
    test('a typed answer on a chip question is read into otherText', () async {
      final TradeFormQuestionStep step = await _loadOne(
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
          answer: <String, dynamic>{
            'status': 'answered',
            'option_keys': <String>[],
            'text': null,
            'number': null,
            'bool': null,
            'other_text': 'Batliboi lathe',
          },
        ),
      );

      expect(step.isAnswered, isTrue);
      expect(step.answer!.otherText, 'Batliboi lathe');
      expect(step.answer!.hasOtherText, isTrue);
      expect(step.answer!.text, isNull);
      expect(step.answer!.optionKeys, isEmpty);
    });

    test('an ABSENT other_text key (older server) reads as null', () async {
      final TradeFormQuestionStep step = await _loadOne(
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
          answer: <String, dynamic>{
            'status': 'answered',
            'option_keys': <String>['cnc_lathe'],
            'text': null,
            'number': null,
            'bool': null,
          },
        ),
      );

      expect(step.answer!.otherText, isNull);
      expect(step.answer!.hasOtherText, isFalse);
      expect(step.answer!.optionKeys, <String>['cnc_lathe']);
    });

    test('a null other_text reads as null', () async {
      final TradeFormQuestionStep step = await _loadOne(
        _screen(
          key: 'turning_machine',
          answerType: 'multi_select',
          optionKeys: <String>['cnc_lathe'],
          answer: <String, dynamic>{
            'status': 'declined',
            'option_keys': <String>[],
            'text': null,
            'number': null,
            'bool': null,
            'other_text': null,
          },
        ),
      );

      expect(step.answer!.isDeclined, isTrue);
      expect(step.answer!.otherText, isNull);
      expect(step.answer!.hasOtherText, isFalse);
    });

    test('the typed answer goes on the wire as {kind: text}', () {
      expect(
        const TradeFormAnswer.text('Batliboi lathe').toJson(),
        <String, dynamic>{'kind': 'text', 'text': 'Batliboi lathe'},
      );
    });
  });

  group('"Koi aur — khud likhein" on a multi-select question', () {
    Future<TradeFormQuestionStep> multi({Object? answer}) => _loadOne(
      _screen(
        key: 'turning_machine',
        answerType: 'multi_select',
        optionKeys: <String>['cnc_lathe', 'vtl'],
        answer: answer,
      ),
    );

    testWidgets('is offered, closed, and opens a text box when tapped', (
      WidgetTester tester,
    ) async {
      await _pump(tester, await multi());

      expect(find.text(kTradeFormOtherAnswerLabel), findsOneWidget);
      expect(_multiSelected(tester, kTradeFormOtherAnswerLabel), isFalse);
      expect(find.byType(TextField), findsNothing);

      await tester.tap(find.text(kTradeFormOtherAnswerLabel));
      await tester.pump();

      expect(_multiSelected(tester, kTradeFormOtherAnswerLabel), isTrue);
      expect(find.byType(TextField), findsOneWidget);
      // Nothing typed yet: the server rejects an empty answer, so nothing to send.
      expect(_next(tester).onPressed, isNull);
    });

    testWidgets('sends the typed words (trimmed) as text, never as chips', (
      WidgetTester tester,
    ) async {
      final _Sent sent = await _pump(tester, await multi());
      await tester.tap(find.text('Label cnc_lathe'));
      await tester.pump();

      await tester.tap(find.text(kTradeFormOtherAnswerLabel));
      await tester.pump();
      // Exclusive: the server keeps ONE value, so the chip is unticked.
      expect(_multiSelected(tester, 'Label cnc_lathe'), isFalse);

      await tester.enterText(find.byType(TextField), '  Batliboi lathe  ');
      await tester.pump();
      expect(_next(tester).onPressed, isNotNull);
      await _tapNext(tester);

      expect(sent.text, 'Batliboi lathe');
      expect(sent.chips, isNull);
    });

    testWidgets('a chip tap unpicks "Koi aur" and the chips are sent', (
      WidgetTester tester,
    ) async {
      final _Sent sent = await _pump(tester, await multi());
      await tester.tap(find.text(kTradeFormOtherAnswerLabel));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'Batliboi lathe');
      await tester.pump();

      await tester.tap(find.text('Label vtl'));
      await tester.pump();

      expect(_multiSelected(tester, kTradeFormOtherAnswerLabel), isFalse);
      expect(find.byType(TextField), findsNothing);
      await _tapNext(tester);
      expect(sent.chips, <String>['vtl']);
      expect(sent.text, isNull);
    });

    testWidgets('a saved typed answer reopens picked, with his words, ready', (
      WidgetTester tester,
    ) async {
      final _Sent sent = await _pump(
        tester,
        await multi(
          answer: <String, dynamic>{
            'status': 'answered',
            'option_keys': <String>[],
            'text': null,
            'number': null,
            'bool': null,
            'other_text': 'Batliboi lathe',
          },
        ),
      );

      // Never blank: the option is picked and the box shows what he wrote.
      expect(_multiSelected(tester, kTradeFormOtherAnswerLabel), isTrue);
      expect(_otherBox(tester).controller!.text, 'Batliboi lathe');
      expect(_next(tester).onPressed, isNotNull);

      await _tapNext(tester);
      expect(sent.text, 'Batliboi lathe');
    });
  });

  group('"Koi aur — khud likhein" on a single-select question', () {
    Future<TradeFormQuestionStep> single({Object? answer}) => _loadOne(
      _screen(
        key: 'turning_experience',
        answerType: 'single_select',
        optionKeys: <String>['below_1', 'one_to_three'],
        answer: answer,
      ),
    );

    testWidgets('is a radio: picking it clears the chip, a chip clears it', (
      WidgetTester tester,
    ) async {
      final _Sent sent = await _pump(tester, await single());
      expect(find.byType(SingleSelectQuestionCard), findsNWidgets(3));

      await tester.tap(find.text('Label below_1'));
      await tester.pump();
      await tester.tap(find.text(kTradeFormOtherAnswerLabel));
      await tester.pump();
      expect(_singleSelected(tester, 'Label below_1'), isFalse);
      expect(_singleSelected(tester, kTradeFormOtherAnswerLabel), isTrue);

      // A second tap on a radio keeps it picked.
      await tester.tap(find.text(kTradeFormOtherAnswerLabel));
      await tester.pump();
      expect(_singleSelected(tester, kTradeFormOtherAnswerLabel), isTrue);

      await tester.enterText(find.byType(TextField), 'Das saal');
      await tester.pump();
      await _tapNext(tester);
      expect(sent.text, 'Das saal');
      expect(sent.chips, isNull);
    });

    testWidgets('a saved typed answer reopens picked with the text', (
      WidgetTester tester,
    ) async {
      await _pump(
        tester,
        await single(
          answer: <String, dynamic>{
            'status': 'answered',
            'option_keys': <String>[],
            'text': null,
            'number': null,
            'bool': null,
            'other_text': 'Das saal',
          },
        ),
      );

      expect(_singleSelected(tester, kTradeFormOtherAnswerLabel), isTrue);
      expect(_singleSelected(tester, 'Label below_1'), isFalse);
      expect(_otherBox(tester).controller!.text, 'Das saal');
      expect(_next(tester).onPressed, isNotNull);
    });
  });

  group('questions that are not chip questions', () {
    testWidgets('a yes/no question has no "Koi aur"', (
      WidgetTester tester,
    ) async {
      await _pump(
        tester,
        await _loadOne(_screen(key: 'drawing_reading', answerType: 'boolean')),
      );
      expect(find.text(kTradeFormOtherAnswerLabel), findsNothing);
    });

    testWidgets('an open question has no "Koi aur"', (
      WidgetTester tester,
    ) async {
      await _pump(
        tester,
        await _loadOne(_screen(key: 'iti_project_work', answerType: 'text')),
      );
      expect(find.text(kTradeFormOtherAnswerLabel), findsNothing);
    });
  });

  group('a searchable list whose search finds nothing', () {
    Future<TradeFormQuestionStep> searchable() => _loadOne(
      _screen(
        key: 'material_worked',
        answerType: 'multi_select',
        optionKeys: <String>['mild_steel', 'brass'],
        searchable: true,
      ),
    );

    testWidgets('offers what he typed as his answer, and sends it', (
      WidgetTester tester,
    ) async {
      final _Sent sent = await _pump(tester, await searchable());

      await tester.enterText(find.byType(TextField), 'Inconel ');
      await tester.pump();

      expect(
        find.text('Koi option nahi mila. Doosra shabd try karein.'),
        findsOneWidget,
      );
      final Finder use = find.text(tradeFormUseSearchAsAnswerLabel('Inconel'));
      expect(use, findsOneWidget);

      await tester.tap(use);
      await tester.pump();

      // Picked, with the words in the box — sent only by the docked bar.
      expect(_multiSelected(tester, kTradeFormOtherAnswerLabel), isTrue);
      expect(sent.text, isNull);
      final TextField box = tester.widget<TextField>(
        find.byType(TextField).last,
      );
      expect(box.controller!.text, 'Inconel');

      await _tapNext(tester);
      expect(sent.text, 'Inconel');
      expect(sent.chips, isNull);
    });

    testWidgets('is not offered while the search still matches an option', (
      WidgetTester tester,
    ) async {
      await _pump(tester, await searchable());

      await tester.enterText(find.byType(TextField), 'brass');
      await tester.pump();

      expect(find.text('Label brass'), findsOneWidget);
      expect(find.text(tradeFormUseSearchAsAnswerLabel('brass')), findsNothing);
    });
  });

  group('TradeFormCubit.answerQuestion banks a typed chip answer', () {
    late _MockRepo repo;

    setUpAll(() => registerFallbackValue(const TradeFormAnswer.declined()));

    setUp(() {
      repo = _MockRepo();
      when(() => repo.loadSavedPreferences()).thenAnswer((_) async => null);
      when(
        () => repo.loadSavedEmployment(),
      ).thenAnswer((_) async => const TradeFormStoredEmployment());
      when(() => repo.loadSavedQualifications()).thenAnswer((_) async => null);
    });

    const VoiceQuestion chips = VoiceQuestion(
      id: 'turning_machine',
      prompt: 'Aap kaunsi turning machine chalate hain?',
      kind: VoiceQuestionKind.multiSelect,
      options: <VoiceChoice>[VoiceChoice(key: 'cnc_lathe', label: 'CNC lathe')],
    );
    const VoiceQuestion open = VoiceQuestion(
      id: 'iti_project_work',
      prompt: 'ITI me kya banaya tha?',
      kind: VoiceQuestionKind.open,
    );

    TradeForm form() => const TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 'capability',
          title: 'Capability',
          screens: <TradeFormStep>[
            TradeFormQuestionStep(question: chips, searchable: false),
            TradeFormQuestionStep(question: open, searchable: false),
          ],
        ),
      ],
    );

    TradeFormSavedAnswer bankedFor(TradeFormCubit cubit, String id) => cubit
        .state
        .flatSteps
        .map((TradeFormFlatStep f) => f.step)
        .whereType<TradeFormQuestionStep>()
        .firstWhere((TradeFormQuestionStep q) => q.question.id == id)
        .answer!;

    test(
      'as otherText — the way the server replays it — not as text',
      () async {
        when(() => repo.loadForm()).thenAnswer((_) async => form());
        when(
          () => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          ),
        ).thenAnswer(
          (_) async => const TradeFormAnswerResult(
            questionKey: 'turning_machine',
            status: TradeFormAnswerStatus.answered,
            answered: 1,
            total: 2,
          ),
        );
        final TradeFormCubit cubit = TradeFormCubit(repo);
        await cubit.load();

        await cubit.answerQuestion(
          cubit.state.currentStep as TradeFormQuestionStep,
          const TradeFormAnswer.text('Batliboi lathe'),
        );

        verify(
          () => repo.submitAnswer(
            questionKey: 'turning_machine',
            answer: const TradeFormAnswer.text('Batliboi lathe'),
          ),
        ).called(1);
        final TradeFormSavedAnswer banked = bankedFor(cubit, 'turning_machine');
        expect(banked.otherText, 'Batliboi lathe');
        expect(banked.text, isNull);
        expect(banked.hasOtherText, isTrue);
      },
    );

    test('an open question still banks plain text', () async {
      when(() => repo.loadForm()).thenAnswer((_) async => form());
      when(
        () => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        ),
      ).thenAnswer(
        (_) async => const TradeFormAnswerResult(
          questionKey: 'iti_project_work',
          status: TradeFormAnswerStatus.answered,
          answered: 1,
          total: 2,
        ),
      );
      final TradeFormCubit cubit = TradeFormCubit(repo);
      await cubit.load();
      await cubit.declineQuestion(
        cubit.state.currentStep as TradeFormQuestionStep,
      );

      await cubit.answerQuestion(
        cubit.state.flatSteps
            .map((TradeFormFlatStep f) => f.step)
            .whereType<TradeFormQuestionStep>()
            .firstWhere((TradeFormQuestionStep q) => q.question.id == open.id),
        const TradeFormAnswer.text('Flange banaya'),
      );

      final TradeFormSavedAnswer banked = bankedFor(cubit, 'iti_project_work');
      expect(banked.text, 'Flange banaya');
      expect(banked.otherText, isNull);
    });
  });

  group('MockApiClient parity', () {
    test('a typed answer on a chip question replays as other_text', () async {
      final MockApiClient api = MockApiClient()..mockHasTradeForm = true;
      await api.getTradeForm(authToken: 'tok');

      await api.submitTradeFormAnswer(
        authToken: 'tok',
        body: <String, dynamic>{
          'question_key': 'turning_machine',
          'answer': <String, dynamic>{
            'kind': 'text',
            'text': ' Batliboi lathe ',
          },
        },
      );
      await api.submitTradeFormAnswer(
        authToken: 'tok',
        body: <String, dynamic>{
          'question_key': 'iti_project_work',
          'answer': <String, dynamic>{'kind': 'text', 'text': 'Flange banaya'},
        },
      );

      final Map<String, dynamic> json = await api.getTradeForm(
        authToken: 'tok',
      );
      Map<String, dynamic> answerFor(String key) {
        for (final dynamic section in json['sections'] as List<dynamic>) {
          for (final dynamic screen
              in (section as Map<String, dynamic>)['screens']
                  as List<dynamic>) {
            final Map<String, dynamic> s = screen as Map<String, dynamic>;
            final Object? q = s['question'];
            if (q is Map && q['question_key'] == key) {
              return (s['answer'] as Map).cast<String, dynamic>();
            }
          }
        }
        throw StateError('no $key');
      }

      final Map<String, dynamic> chip = answerFor('turning_machine');
      expect(chip['status'], 'answered');
      expect(chip['other_text'], 'Batliboi lathe');
      expect(chip['text'], isNull);
      expect(chip['option_keys'], isEmpty);

      final Map<String, dynamic> open = answerFor('iti_project_work');
      expect(open['text'], 'Flange banaya');
      expect(open['other_text'], isNull);
    });
  });
}
