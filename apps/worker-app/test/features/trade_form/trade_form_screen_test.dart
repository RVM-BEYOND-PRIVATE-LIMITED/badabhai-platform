import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_screen.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements TradeFormRepository {}

/// [BbChip.selected] for the chip carrying [label] — used by the #1382
/// saved-answer-prefill and none-of-above tests below to assert selection
/// state directly rather than inferring it from colour/decoration.
bool _chipSelected(WidgetTester tester, String label) {
  return tester
      .widget<BbChip>(find.byWidgetPredicate(
        (Widget w) => w is BbChip && w.label == label,
      ))
      .selected;
}

const VoiceQuestion _plainQuestion = VoiceQuestion(
  id: 'turning_machine',
  prompt: 'Aap kaunsi turning machine chalate hain?',
  kind: VoiceQuestionKind.multiSelect,
  options: <VoiceChoice>[VoiceChoice(key: 'cnc_lathe', label: 'CNC lathe')],
);

/// 14 options — past `BbSearchableMultiSelect`'s trigger, mirroring the real
/// server-computed `ui.searchable` threshold.
const VoiceQuestion _searchableQuestion = VoiceQuestion(
  id: 'material_worked',
  prompt: 'Aap kaunsi dhaatu par kaam karte hain?',
  kind: VoiceQuestionKind.multiSelect,
  options: <VoiceChoice>[
    VoiceChoice(key: 'mild_steel', label: 'Mild steel'),
    VoiceChoice(key: 'stainless_steel', label: 'Stainless steel'),
    VoiceChoice(key: 'brass', label: 'Brass'),
    VoiceChoice(key: 'aluminium', label: 'Aluminium'),
    VoiceChoice(key: 'cast_iron', label: 'Cast iron'),
    VoiceChoice(key: 'copper', label: 'Copper'),
    VoiceChoice(key: 'bronze', label: 'Bronze'),
    VoiceChoice(key: 'alloy_steel', label: 'Alloy steel'),
    VoiceChoice(key: 'tool_steel', label: 'Tool steel'),
    VoiceChoice(key: 'titanium', label: 'Titanium'),
    VoiceChoice(key: 'nickel_alloy', label: 'Nickel alloy'),
    VoiceChoice(key: 'plastic', label: 'Plastic'),
    VoiceChoice(key: 'die_steel', label: 'Die steel'),
    VoiceChoice(key: 'ceramic', label: 'Ceramic'),
  ],
);

TradeForm _form() => const TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 'capability',
          title: 'Machines, controllers & capability',
          screens: <TradeFormStep>[
            TradeFormQuestionStep(question: _plainQuestion, searchable: false),
            TradeFormQuestionStep(question: _searchableQuestion, searchable: true),
          ],
        ),
        TradeFormSection(
          id: 'terms',
          title: 'Availability & terms',
          screens: <TradeFormStep>[TradeFormPreferencesStep()],
        ),
        TradeFormSection(
          id: 'work_history',
          title: 'Work history',
          screens: <TradeFormStep>[TradeFormEmploymentStep()],
        ),
      ],
    );

const WorkPrefOptionsDto _prefOptions = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
);

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const TradeFormAnswer.declined());
    registerFallbackValue(const TradeFormPreferences());
    registerFallbackValue(<TradeFormEmploymentEntry>[]);
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(() => repo.loadPreferenceOptions()).thenAnswer((_) async => _prefOptions);
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    locator.registerFactory<TradeFormCubit>(() => TradeFormCubit(repo));
  });

  tearDown(() => locator.reset());

  Future<void> pump(WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/trade-form',
      routes: <RouteBase>[
        GoRoute(
          path: '/trade-form',
          builder: (_, __) => const TradeFormScreen(),
        ),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
  }

  testWidgets('a 404 shows the honest "nothing to fill here" state',
      (WidgetTester tester) async {
    when(() => repo.loadForm()).thenAnswer((_) async => null);

    await pump(tester);

    expect(find.text('Yahan abhi bharne ke liye kuch nahi hai'), findsOneWidget);
    // Never a blank/empty ready form.
    expect(find.text('Aage badhein'), findsNothing);
  });

  testWidgets('a non-searchable question renders VoiceChoiceChips, tapping '
      'a chip submits and advances', (WidgetTester tester) async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'turning_machine',
          status: TradeFormAnswerStatus.answered,
          answered: 1,
          total: 2,
        ));

    await pump(tester);

    expect(find.text('Aap kaunsi turning machine chalate hain?'), findsOneWidget);
    // turning_machine is multi-select: a chip tap only SELECTS it — an
    // explicit "Aage badhein" (VoiceChoiceChips' own submit button) sends it.
    await tester.tap(find.text('CNC lathe'));
    await tester.pump();
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();

    verify(() => repo.submitAnswer(
          questionKey: 'turning_machine',
          answer: any(named: 'answer'),
        )).called(1);
    // Advanced to the searchable question.
    expect(find.text('Aap kaunsi dhaatu par kaam karte hain?'), findsOneWidget);
  });

  testWidgets('a searchable question renders the search box; the decline '
      'affordance is always present', (WidgetTester tester) async {
    when(() => repo.loadForm()).thenAnswer((_) async => TradeForm(
          kind: _form().kind,
          packId: _form().packId,
          packVersion: _form().packVersion,
          sections: <TradeFormSection>[
            TradeFormSection(
              id: 'capability',
              title: 'Machines, controllers & capability',
              screens: <TradeFormStep>[
                const TradeFormQuestionStep(
                    question: _searchableQuestion, searchable: true),
              ],
            ),
          ],
        ));

    await pump(tester);

    expect(find.text('Type karke dhoondein'), findsOneWidget); // BbSearchField hint
    expect(find.text('Pata nahi'), findsOneWidget); // decline affordance
  });

  testWidgets('declining a question submits {kind: declined} and advances',
      (WidgetTester tester) async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'turning_machine',
          status: TradeFormAnswerStatus.declined,
          answered: 1,
          total: 2,
        ));

    await pump(tester);
    await tester.tap(find.text('Pata nahi'));
    await tester.pumpAndSettle();

    final TradeFormAnswer sent = verify(() => repo.submitAnswer(
          questionKey: 'turning_machine',
          answer: captureAny(named: 'answer'),
        )).captured.single as TradeFormAnswer;
    expect(sent.kind, TradeFormAnswerKind.declined);
  });

  testWidgets(
      'walking through both questions reaches the preferences then '
      'employment marker screens', (WidgetTester tester) async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'x',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));

    await pump(tester);
    await tester.ensureVisible(find.text('Pata nahi').first);
    await tester.tap(find.text('Pata nahi').first); // decline q1
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Pata nahi').first);
    await tester.tap(find.text('Pata nahi').first); // decline q2 (searchable)
    await tester.pumpAndSettle();

    // Now on the preferences marker screen.
    expect(find.text('Hindi'), findsOneWidget);
    await tester.ensureVisible(find.text('Aage badhein'));
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
    verify(() => repo.savePreferences(any())).called(1);

    // Now on the employment marker screen.
    expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
  });

  testWidgets(
      'finishing the LAST marker screen ("Ho gaya") navigates to '
      'Routes.building instead of spinning forever (#1367)',
      (WidgetTester tester) async {
    when(() => repo.loadForm()).thenAnswer((_) async => _form());
    when(() => repo.submitAnswer(
          questionKey: any(named: 'questionKey'),
          answer: any(named: 'answer'),
        )).thenAnswer((_) async => const TradeFormAnswerResult(
          questionKey: 'x',
          status: TradeFormAnswerStatus.answered,
          answered: 2,
          total: 2,
        ));

    final GoRouter router = GoRouter(
      initialLocation: '/trade-form',
      routes: <RouteBase>[
        GoRoute(
          path: '/trade-form',
          builder: (_, __) => const TradeFormScreen(),
        ),
        GoRoute(
          path: '/building',
          builder: (_, __) => const Scaffold(body: Text('BUILDING')),
        ),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();

    // Walk to the employment marker exactly like the previous test.
    await tester.ensureVisible(find.text('Pata nahi').first);
    await tester.tap(find.text('Pata nahi').first); // decline q1
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Pata nahi').first);
    await tester.tap(find.text('Pata nahi').first); // decline q2
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Aage badhein'));
    await tester.tap(find.text('Aage badhein')); // save preferences
    await tester.pumpAndSettle();
    expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);

    // The employment marker is the LAST step — the button reads "Ho gaya".
    expect(find.text('Ho gaya'), findsOneWidget);
    await tester.ensureVisible(find.text('Ho gaya'));
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    verify(() => repo.saveEmployment(any())).called(1);
    expect(router.routerDelegate.currentConfiguration.uri.path, '/building');
    expect(find.text('BUILDING'), findsOneWidget);
  });

  group('none-of-above mutual exclusion, end to end (#1382)', () {
    const VoiceQuestion questionWithNoneOfAbove = VoiceQuestion(
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

    testWidgets(
        'tapping the none-of-above chip clears real selections and submits '
        'only itself', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => TradeForm(
            kind: 'cnc_turner',
            packId: 'qp_cnc_turning',
            packVersion: 1,
            sections: <TradeFormSection>[
              TradeFormSection(
                id: 'capability',
                title: 'Machines, controllers & capability',
                screens: <TradeFormStep>[
                  const TradeFormQuestionStep(
                      question: questionWithNoneOfAbove, searchable: false),
                  // A trailing step (a DIFFERENT question id — never
                  // `turning_machine`) so answering the above never hits
                  // `done` (this test is about the exclusion rule, not
                  // #1367's last-step navigation).
                  const TradeFormQuestionStep(
                      question: _searchableQuestion, searchable: true),
                ],
              ),
            ],
          ));
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'turning_machine',
            status: TradeFormAnswerStatus.answered,
            answered: 1,
            total: 2,
          ));

      await pump(tester);
      await tester.tap(find.text('CNC lathe'));
      await tester.tap(find.text('Conventional lathe'));
      await tester.pump();
      expect(_chipSelected(tester, 'CNC lathe'), isTrue);

      await tester.tap(find.text('In me se koi nahi'));
      await tester.pump();

      expect(_chipSelected(tester, 'CNC lathe'), isFalse);
      expect(_chipSelected(tester, 'Conventional lathe'), isFalse);
      expect(_chipSelected(tester, 'In me se koi nahi'), isTrue);

      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      final TradeFormAnswer sent = verify(() => repo.submitAnswer(
            questionKey: 'turning_machine',
            answer: captureAny(named: 'answer'),
          )).captured.single as TradeFormAnswer;
      expect(sent.optionKeys, <String>['none_of_these']);
    });
  });

  group('saved-answer pre-fill + goBack round trip (#1382)', () {
    const VoiceQuestion textQuestion = VoiceQuestion(
      id: 'iti_project_work',
      prompt: 'ITI me kya banaya tha?',
      kind: VoiceQuestionKind.open,
    );

    testWidgets(
        'a saved non-searchable multi-select answer is pre-selected after '
        'goBack, not blank', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => TradeForm(
            kind: 'cnc_turner',
            packId: 'qp_cnc_turning',
            packVersion: 1,
            sections: <TradeFormSection>[
              TradeFormSection(
                id: 'capability',
                title: 'Machines, controllers & capability',
                screens: <TradeFormStep>[
                  const TradeFormQuestionStep(
                    question: _plainQuestion,
                    searchable: false,
                    answer: TradeFormSavedAnswer(
                      status: TradeFormAnswerStatus.answered,
                      optionKeys: <String>['cnc_lathe'],
                    ),
                  ),
                  const TradeFormQuestionStep(
                      question: _searchableQuestion, searchable: true),
                ],
              ),
            ],
          ));

      await pump(tester);
      // Resumability skips the answered turning_machine question — lands on
      // the unanswered searchable one first.
      expect(find.text('Aap kaunsi dhaatu par kaam karte hain?'), findsOneWidget);

      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('Aap kaunsi turning machine chalate hain?'), findsOneWidget);
      expect(_chipSelected(tester, 'CNC lathe'), isTrue,
          reason: 'the saved answer must render pre-selected, not blank');
    });

    testWidgets(
        'a saved searchable multi-select answer is pre-selected after '
        'goBack, not blank', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => TradeForm(
            kind: 'cnc_turner',
            packId: 'qp_cnc_turning',
            packVersion: 1,
            sections: <TradeFormSection>[
              TradeFormSection(
                id: 'capability',
                title: 'Machines, controllers & capability',
                screens: <TradeFormStep>[
                  const TradeFormQuestionStep(
                    question: _searchableQuestion,
                    searchable: true,
                    answer: TradeFormSavedAnswer(
                      status: TradeFormAnswerStatus.answered,
                      optionKeys: <String>['brass'],
                    ),
                  ),
                  const TradeFormQuestionStep(
                      question: _plainQuestion, searchable: false),
                ],
              ),
            ],
          ));

      await pump(tester);
      expect(find.text('Aap kaunsi turning machine chalate hain?'), findsOneWidget);

      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('Aap kaunsi dhaatu par kaam karte hain?'), findsOneWidget);
      expect(_chipSelected(tester, 'Brass'), isTrue,
          reason: 'the saved answer must render pre-selected, not blank');
    });

    testWidgets(
        'a saved text answer pre-fills the open field after goBack, not '
        'blank', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => TradeForm(
            kind: 'cnc_turner',
            packId: 'qp_cnc_turning',
            packVersion: 1,
            sections: <TradeFormSection>[
              TradeFormSection(
                id: 'qualifications',
                title: 'Qualification, documents & languages',
                screens: <TradeFormStep>[
                  const TradeFormQuestionStep(
                    question: textQuestion,
                    searchable: false,
                    answer: TradeFormSavedAnswer(
                      status: TradeFormAnswerStatus.answered,
                      text: 'Bush banaya tha',
                    ),
                  ),
                  const TradeFormQuestionStep(
                      question: _plainQuestion, searchable: false),
                ],
              ),
            ],
          ));

      await pump(tester);
      expect(find.text('Aap kaunsi turning machine chalate hain?'), findsOneWidget);

      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('ITI me kya banaya tha?'), findsOneWidget);
      expect(find.text('Bush banaya tha'), findsOneWidget,
          reason: 'the saved text answer must pre-fill the field, not be blank');
    });
  });
}
