import 'package:badabhai_worker_app/core/api/api_client.dart'
    show QualificationOptionsDto, WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_screen.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_progress_bar.dart';
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

/// The mounted [TradeFormProgressBar]'s own `answered`/`total` — used by the
/// #1384 "tracks the whole walk" tests to assert the rendered fraction
/// directly rather than inferring it from `FractionallySizedBox.widthFactor`
/// internals.
TradeFormProgressBar _progressBar(WidgetTester tester) =>
    tester.widget<TradeFormProgressBar>(find.byType(TradeFormProgressBar));

/// #1384 item 2 — the preferences marker is now FOUR internal pages
/// (languages+documents / shift+jobType+cities / relocate+accommodation+
/// salary / education), each walked via its own "Aage badhein" tap; only the
/// FOURTH tap (on the last internal page) actually calls
/// `TradeFormCubit.savePreferencesAndAdvance` and moves the OUTER walk.
/// Every test that used to reach/save the preferences marker in one tap
/// drives all four here instead of duplicating this four-tap sequence.
Future<void> _walkThroughPreferencesPages(WidgetTester tester) async {
  for (int i = 0; i < 4; i++) {
    await tester.ensureVisible(find.text('Aage badhein'));
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
  }
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

/// A multi-select question carrying a none-of-above option — hoisted to file
/// scope (was local to the #1382 none-of-above group) so the #1384
/// saved-answer pre-fill tests below can reuse it too.
const VoiceQuestion _questionWithNoneOfAbove = VoiceQuestion(
  id: 'turning_machine',
  prompt: 'Aap kaunsi turning machine chalate hain?',
  kind: VoiceQuestionKind.multiSelect,
  options: <VoiceChoice>[
    VoiceChoice(key: 'cnc_lathe', label: 'CNC lathe'),
    VoiceChoice(key: 'conventional_lathe', label: 'Conventional lathe'),
    VoiceChoice(
        key: 'none_of_these', label: 'In me se koi nahi', isNoneOfAbove: true),
  ],
);

/// The searchable equivalent of [_questionWithNoneOfAbove] — past
/// `BbSearchableMultiSelect`'s trigger, same shape as [_searchableQuestion]
/// plus a none-of-above option, for the #1384 searchable-path pre-fill test.
const VoiceQuestion _searchableQuestionWithNoneOfAbove = VoiceQuestion(
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
    VoiceChoice(
        key: 'none_of_these', label: 'In me se koi nahi', isNoneOfAbove: true),
  ],
);

const WorkPrefOptionsDto _prefOptions = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
);

const QualificationOptionsDto _qualOptions = QualificationOptionsDto(
  educationCredential: <String, String>{'iti': 'ITI', 'diploma': 'Diploma'},
  educationCouncil: <String, String>{'ncvt': 'NCVT'},
);

/// A single-section form whose ONLY (and therefore LAST) step is the
/// qualifications marker — the #1384 tests below reach it on the very first
/// pump, no walking required.
TradeForm _qualificationsForm({List<String> suggested = const <String>[]}) =>
    TradeForm(
      kind: 'cnc_turner',
      packId: 'qp_cnc_turning',
      packVersion: 1,
      sections: <TradeFormSection>[
        TradeFormSection(
          id: 'qualifications',
          title: 'Qualification, documents & languages',
          screens: <TradeFormStep>[
            TradeFormQualificationsStep(suggestedCertificates: suggested),
          ],
        ),
      ],
    );

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const TradeFormAnswer.declined());
    registerFallbackValue(const TradeFormPreferences());
    registerFallbackValue(<TradeFormEmploymentEntry>[]);
    registerFallbackValue(const TradeFormQualifications());
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(() => repo.loadPreferenceOptions()).thenAnswer((_) async => _prefOptions);
    when(() => repo.savePreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    when(() => repo.loadQualificationOptions()).thenAnswer((_) async => _qualOptions);
    when(() => repo.saveQualifications(any())).thenAnswer((_) async {});
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

    // Now on the preferences marker screen — its first internal page
    // (languages + documents).
    expect(find.text('Hindi'), findsOneWidget);
    await _walkThroughPreferencesPages(tester);
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
    await _walkThroughPreferencesPages(tester); // walk + save preferences
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
                      question: _questionWithNoneOfAbove, searchable: false),
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

    testWidgets(
        'a declined non-searchable answer pre-selects the none-of-above '
        'chip after goBack, not blank (#1384)', (WidgetTester tester) async {
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
                    question: _questionWithNoneOfAbove,
                    searchable: false,
                    // A declined save is how BOTH the "Pata nahi" button and
                    // the none-of-above chip land on the wire (see
                    // TradeFormAnswerStatus.declined's own doc) — optionKeys
                    // deliberately left empty here, matching what a real GET
                    // returns for either origin.
                    answer: TradeFormSavedAnswer(
                      status: TradeFormAnswerStatus.declined,
                    ),
                  ),
                  const TradeFormQuestionStep(
                      question: _searchableQuestion, searchable: true),
                ],
              ),
            ],
          ));

      await pump(tester);
      expect(find.text('Aap kaunsi dhaatu par kaam karte hain?'), findsOneWidget);

      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('Aap kaunsi turning machine chalate hain?'), findsOneWidget);
      expect(_chipSelected(tester, 'In me se koi nahi'), isTrue,
          reason: 'a declined saved answer must render the none-of-above '
              'chip selected, not blank/untouched');
      expect(_chipSelected(tester, 'CNC lathe'), isFalse);
    });

    testWidgets(
        'a declined searchable answer pre-selects the none-of-above chip '
        'after goBack, not blank (#1384)', (WidgetTester tester) async {
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
                    question: _searchableQuestionWithNoneOfAbove,
                    searchable: true,
                    answer: TradeFormSavedAnswer(
                      status: TradeFormAnswerStatus.declined,
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
      expect(_chipSelected(tester, 'In me se koi nahi'), isTrue,
          reason: 'a declined saved answer must render the none-of-above '
              'chip selected, not blank/untouched');
      expect(_chipSelected(tester, 'Brass'), isFalse);
    });

    testWidgets(
        'a declined answer on a question with NO none-of-above option '
        'stays blank, not a crash (#1384)', (WidgetTester tester) async {
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
                    question: _plainQuestion, // no isNoneOfAbove option
                    searchable: false,
                    answer: TradeFormSavedAnswer(
                      status: TradeFormAnswerStatus.declined,
                    ),
                  ),
                  const TradeFormQuestionStep(
                      question: _searchableQuestion, searchable: true),
                ],
              ),
            ],
          ));

      await pump(tester);
      expect(find.text('Aap kaunsi dhaatu par kaam karte hain?'), findsOneWidget);

      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('Aap kaunsi turning machine chalate hain?'), findsOneWidget);
      expect(_chipSelected(tester, 'CNC lathe'), isFalse,
          reason: 'nothing to guess at when the question has no '
              'none-of-above option — no crash, no false selection');
    });
  });

  group('progress bar tracks the whole walk, not just answered questions '
      '(#1384)', () {
    testWidgets(
        'the bar advances through a MARKER-SCREEN save even though '
        'state.answered/state.total (question-only) do not change',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'x',
            status: TradeFormAnswerStatus.declined,
            answered: 2,
            total: 2,
          ));

      await pump(tester);
      // _form() flattens to 4 steps: 2 questions + preferences + employment.
      // On the very first step (currentIndex 0) the bar reads a sliver, not
      // empty.
      expect(_progressBar(tester).answered, 1);
      expect(_progressBar(tester).total, 4);

      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q1
      await tester.pumpAndSettle();
      expect(_progressBar(tester).answered, 2);
      expect(_progressBar(tester).total, 4);

      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q2
      await tester.pumpAndSettle();

      // Now on the preferences marker screen. `state.answered`/`state.total`
      // are the server's question-only counters (2/2 per the mock above,
      // #1375) — frozen from here on — but the bar still reads 3/4, the
      // worker's actual position in the walk.
      expect(find.text('Hindi'), findsOneWidget);
      expect(_progressBar(tester).answered, 3);
      expect(_progressBar(tester).total, 4);

      // Walking the preferences marker's OWN internal pages must not move
      // this OUTER bar either — it stays at 3/4 until the marker actually
      // saves (the 4th internal-page tap).
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // internal page 0 -> 1
      await tester.pumpAndSettle();
      expect(_progressBar(tester).answered, 3);
      expect(_progressBar(tester).total, 4);

      for (int i = 0; i < 3; i++) {
        await tester.ensureVisible(find.text('Aage badhein'));
        await tester.tap(find.text('Aage badhein'));
        await tester.pumpAndSettle();
      }
      verify(() => repo.savePreferences(any())).called(1);

      // THE REGRESSION CHECK: a pure marker-screen save (no question
      // answered) still moved the bar — onto the employment marker, reading
      // fully complete rather than frozen at 3/4.
      expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
      expect(_progressBar(tester).answered, 4);
      expect(_progressBar(tester).total, 4);
    });
  });

  group('the qualifications marker screen (#1384/#1385)', () {
    Future<GoRouter> pumpToBuilding(WidgetTester tester) async {
      final GoRouter router = GoRouter(
        initialLocation: '/trade-form',
        routes: <RouteBase>[
          GoRoute(path: '/trade-form', builder: (_, __) => const TradeFormScreen()),
          GoRoute(
              path: '/building', builder: (_, __) => const Scaffold(body: Text('BUILDING'))),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pumpAndSettle();
      return router;
    }

    testWidgets(
        'suggested-certificate chips render and tapping one fills the name '
        'field — autocomplete, not a closed set', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm(
            suggested: <String>[
              'Fanuc Oi-TF Programming',
              'Mastercam Advanced Multiaxis',
            ],
          ));

      await pump(tester);
      await tester.ensureVisible(find.text('Aur ek certificate jodein'));
      await tester.tap(find.text('Aur ek certificate jodein'));
      await tester.pumpAndSettle();

      // Both suggestions show (browsable before typing anything).
      expect(find.text('Fanuc Oi-TF Programming'), findsOneWidget);
      expect(find.text('Mastercam Advanced Multiaxis'), findsOneWidget);

      await tester.tap(find.text('Fanuc Oi-TF Programming'));
      await tester.pumpAndSettle();

      // Now matches TWICE: the suggestion chip AND the filled text field.
      expect(find.text('Fanuc Oi-TF Programming'), findsNWidgets(2));
    });

    testWidgets(
        'a worker can add up to the 8-certificate cap; the add affordance '
        'disappears there and returns after a removal',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());

      await pump(tester);
      for (int i = 0; i < 8; i++) {
        await tester.ensureVisible(find.text('Aur ek certificate jodein'));
        await tester.tap(find.text('Aur ek certificate jodein'));
        await tester.pumpAndSettle();
      }

      expect(find.text('Aur ek certificate jodein'), findsNothing);
      expect(find.byTooltip('Hataayein'), findsNWidgets(8));

      await tester.ensureVisible(find.byTooltip('Hataayein').first);
      await tester.tap(find.byTooltip('Hataayein').first);
      await tester.pumpAndSettle();

      expect(find.text('Aur ek certificate jodein'), findsOneWidget);
    });

    testWidgets(
        'a worker can add up to the 4-education cap; the add affordance '
        'disappears there', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());

      await pump(tester);
      // #1384 item 2 — education is the marker's SECOND internal page.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
      for (int i = 0; i < 4; i++) {
        await tester.ensureVisible(find.text('Aur ek entry jodein'));
        await tester.tap(find.text('Aur ek entry jodein'));
        await tester.pumpAndSettle();
      }

      expect(find.text('Aur ek entry jodein'), findsNothing);
    });

    testWidgets(
        'education credential/council chips render from '
        'loadQualificationOptions and become selected on tap',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());

      await pump(tester);
      // #1384 item 2 — education is the marker's SECOND internal page.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Aur ek entry jodein'));
      await tester.tap(find.text('Aur ek entry jodein'));
      await tester.pumpAndSettle();

      expect(find.text('ITI'), findsOneWidget);
      expect(find.text('NCVT'), findsOneWidget);
      expect(_chipSelected(tester, 'ITI'), isFalse);

      await tester.tap(find.text('ITI'));
      await tester.pumpAndSettle();

      expect(_chipSelected(tester, 'ITI'), isTrue);
    });

    testWidgets(
        'a server 400 (e.g. a phone number in a free-text field) is '
        'surfaced with the server\'s own message, not swallowed',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());
      when(() => repo.saveQualifications(any())).thenThrow(
          const InvalidRequestFailure('remove contact details from the issuer'));

      await pump(tester);
      await tester.ensureVisible(find.text('Aur ek certificate jodein'));
      await tester.tap(find.text('Aur ek certificate jodein'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'ITI Certificate');
      await tester.pumpAndSettle();
      // #1384 item 2 — "Ho gaya" only renders on the marker's LAST internal
      // page (education); this "Aage badhein" tap is purely internal
      // pagination and must NOT reach the server.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      expect(find.text('remove contact details from the issuer'), findsOneWidget);
    });

    testWidgets(
        'touching only certificates saves with certificatesTouched true and '
        'educationsTouched false, then finishes (#1367)',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());

      final GoRouter router = await pumpToBuilding(tester);
      await tester.ensureVisible(find.text('Aur ek certificate jodein'));
      await tester.tap(find.text('Aur ek certificate jodein'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'ITI Certificate');
      await tester.pumpAndSettle();
      // #1384 item 2 — walk to the marker's LAST internal page (education)
      // before the button's tap actually saves.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final TradeFormQualifications sent = verify(
              () => repo.saveQualifications(captureAny()))
          .captured
          .single as TradeFormQualifications;
      expect(sent.certificatesTouched, isTrue);
      expect(sent.certificates.single.name, 'ITI Certificate');
      expect(sent.educationsTouched, isFalse);
      expect(router.routerDelegate.currentConfiguration.uri.path, '/building');
    });

    testWidgets(
        'leaving both sections untouched still finishes, without ever '
        'calling saveQualifications', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());

      final GoRouter router = await pumpToBuilding(tester);
      // #1384 item 2 — walk to the marker's LAST internal page (education);
      // this "Aage badhein" tap is purely internal and must not touch
      // saveQualifications either.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      verifyNever(() => repo.saveQualifications(any()));
      expect(router.routerDelegate.currentConfiguration.uri.path, '/building');
    });
  });

  group('going Back into an already-passed marker keeps what was typed '
      '(#1384 item 1)', () {
    testWidgets(
        'a preferences chip picked, saved, then goBack — the chip is still '
        'shown selected, not reset to the marker\'s blank default',
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

      await pump(tester);
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q2
      await tester.pumpAndSettle();

      // On the preferences marker — pick a language chip, but do NOT save
      // yet, so this test also proves the fix is keyed off the CUBIT's own
      // banked state (only written on a SUCCESSFUL save), not off whatever
      // the unmounted widget happened to hold in memory.
      expect(find.text('Hindi'), findsOneWidget);
      expect(_chipSelected(tester, 'Hindi'), isFalse);
      await tester.tap(find.text('Hindi'));
      await tester.pump();
      expect(_chipSelected(tester, 'Hindi'), isTrue);

      // Walk the marker's own internal pages (#1384 item 2) — only the
      // FOURTH tap (the last internal page) actually saves.
      await _walkThroughPreferencesPages(tester);
      final TradeFormPreferences sent = verify(
              () => repo.savePreferences(captureAny()))
          .captured
          .single as TradeFormPreferences;
      expect(sent.languages, <String>{'hindi'});

      // Now on the employment marker — go back a WHOLE outer step, straight
      // to the preferences marker. `_prefsKey`'s previous State was fully
      // unmounted the moment the walk advanced past it (see the class doc
      // on `_WizardScaffoldState`) — a bare GlobalKey cannot survive that,
      // so this only passes because `TradeFormState.savedPreferences` seeds
      // the freshly (re)mounted widget. The employment marker has no
      // employers yet (a single internal page), so the SAME "Wapas" tap
      // falls through to the outer `cubit.goBack()` immediately.
      expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      // The freshly (re)mounted preferences widget starts its OWN internal
      // page back at 0 (languages + documents) — exactly where 'Hindi' lives.
      expect(find.text('Hindi'), findsOneWidget);
      expect(_chipSelected(tester, 'Hindi'), isTrue,
          reason: 'a chip already saved once must still show selected after '
              'goBack, not reset to the marker\'s blank default');
    });
  });

  group('preferences marker split across internal pages (#1384 item 2)', () {
    testWidgets(
        'a field entered on an EARLY internal page is still present in '
        'what finally reaches onSave after walking every internal page',
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

      await pump(tester);
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q2
      await tester.pumpAndSettle();

      // Page 0 (languages + documents) — the EARLIEST page.
      expect(find.text('Hindi'), findsOneWidget);
      await tester.tap(find.text('Hindi'));
      await tester.pump();
      await tester.tap(find.text('Aadhaar'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 1 (shift + job type + cities).
      expect(find.text('Day'), findsOneWidget);
      await tester.tap(find.text('Day'));
      await tester.pump();
      await tester.tap(find.text('Permanent'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).first, 'Faridabad');
      await tester.tap(find.text('+'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 2 (relocate + accommodation + salary) — untouched, all optional.
      expect(find.text('Doosre sheher ja sakte hain?'), findsOneWidget);
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 3 (education) — the LAST internal page; this tap actually saves.
      expect(find.text('Institute ka naam'), findsOneWidget);
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      final TradeFormPreferences sent = verify(
              () => repo.savePreferences(captureAny()))
          .captured
          .single as TradeFormPreferences;
      // Fields entered on page 0 (the EARLIEST page) — the whole point of
      // this test — survived three MORE internal-page transitions.
      expect(sent.languages, <String>{'hindi'});
      expect(sent.documentsReady, <String>{'aadhaar'});
      // Fields entered on page 1 also made it through.
      expect(sent.shift, 'day');
      expect(sent.jobType, 'permanent');
      expect(sent.preferredCities, <String>['Faridabad']);
    });

    testWidgets(
        'the header back arrow walks internal pages BACKWARD before '
        'falling through to the outer step, keeping what was typed',
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

      await pump(tester);
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q2
      await tester.pumpAndSettle();

      // Page 0 — tick a language chip.
      await tester.tap(find.text('Hindi'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Now on page 1 (shift + job type + cities) — the outer step never
      // moved (still the preferences marker), so "Wapas" must go back to
      // page 0, NOT pop the whole screen or walk to a previous question.
      expect(find.text('Day'), findsOneWidget);
      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('Hindi'), findsOneWidget,
          reason: 'internal back must land on page 0, not a previous '
              'question or a popped screen');
      expect(_chipSelected(tester, 'Hindi'), isTrue,
          reason: 'the field entered before walking forward must still be '
              'there after walking back');
    });
  });

  group('employment marker paginated per employer (#1384 item 2)', () {
    testWidgets(
        'two employers each get their own internal page; both reach onSave',
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

      await pump(tester);
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Pata nahi').first);
      await tester.tap(find.text('Pata nahi').first); // decline q2
      await tester.pumpAndSettle();
      await _walkThroughPreferencesPages(tester);

      // Now on the employment marker's single (empty) page.
      expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein')); // employer #1
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      await tester.pump();

      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein')); // employer #2
      await tester.pumpAndSettle();

      // Employer #1's card is gone from THIS page — proof this is a
      // per-employer internal page, not a stacked scroll of both cards.
      expect(find.text('Acme'), findsNothing);

      await tester.enterText(find.byType(TextField).at(0), 'Beta Corp');
      await tester.enterText(find.byType(TextField).at(1), 'Welder');
      await tester.pump();

      // This IS the marker's last internal page AND the outer walk's last
      // step — "Ho gaya", not "Aage badhein".
      expect(find.text('Ho gaya'), findsOneWidget);
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final List<TradeFormEmploymentEntry> sent = verify(
              () => repo.saveEmployment(captureAny()))
          .captured
          .single as List<TradeFormEmploymentEntry>;
      expect(sent, hasLength(2));
      expect(sent[0].employerName, 'Acme');
      expect(sent[0].roleLabel, 'Fitter');
      expect(sent[1].employerName, 'Beta Corp');
      expect(sent[1].roleLabel, 'Welder');
    });
  });
}
