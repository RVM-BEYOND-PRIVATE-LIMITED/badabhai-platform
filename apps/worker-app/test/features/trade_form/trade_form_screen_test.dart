import 'package:badabhai_worker_app/core/api/api_client.dart'
    show CityOptionDto, QualificationOptionsDto, WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/form_flow_parts.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/onboarding_body.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/questionnaire_bottom_bar.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/selection_cards.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/shift_blue_header.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/cubit/trade_form_cubit.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/trade_form_screen.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_employment_page.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_reader.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import '../../support/kit_matrix.dart';

class _MockRepo extends Mock implements TradeFormRepository {}

/// The question screen's explicit decline link (the form-flow mockups'
/// "ⓘ Pata nahi / Baad mein batayein").
const String _kDecline = 'Pata nahi / Baad mein batayein';

/// The multi-select hint pill under a question.
const String _kMultiHint = 'Multiple options select kar sakte hain';

/// A hand fake for the on-device read-aloud: records what was spoken and how
/// often playback was stopped. [speak] completes at once — nothing here waits
/// on playback.
class _FakeSpeechReader implements SpeechReader {
  final List<String> spoken = <String>[];
  int stopCalls = 0;

  @override
  Future<void> speak(String text) async => spoken.add(text);

  @override
  Future<void> stop() async => stopCalls++;
}

/// `isSelected` for the kit option card titled [label] — a
/// [MultiSelectQuestionCard] or a [SingleSelectQuestionCard] — used by the
/// #1382 saved-answer-prefill and none-of-above tests below to assert
/// selection state directly rather than inferring it from colour/decoration.
bool _optionSelected(WidgetTester tester, String label) {
  final Finder multi = find.byWidgetPredicate(
    (Widget w) => w is MultiSelectQuestionCard && w.title == label,
  );
  if (multi.evaluate().isNotEmpty) {
    return tester.widget<MultiSelectQuestionCard>(multi).isSelected;
  }
  return tester
      .widget<SingleSelectQuestionCard>(find.byWidgetPredicate(
        (Widget w) => w is SingleSelectQuestionCard && w.title == label,
      ))
      .isSelected;
}

/// The docked [QuestionnaireBottomBar] currently on screen.
QuestionnaireBottomBar _bottomBar(WidgetTester tester) =>
    tester.widget<QuestionnaireBottomBar>(find.byType(QuestionnaireBottomBar));

/// The mounted [FormProgressStrip]'s own `position`/`total` — used by the
/// #1384 "tracks the whole walk" tests to assert the rendered fraction
/// directly rather than inferring it from `FractionallySizedBox.widthFactor`
/// internals.
FormProgressStrip _progressStrip(WidgetTester tester) =>
    tester.widget<FormProgressStrip>(find.byType(FormProgressStrip));

/// The preferences marker is SIX internal pages (languages / documents /
/// shift / jobType / cities / relocate+accommodation+salary —
/// languages+documents was its own further split so a worker never faces
/// more than one question group at a time), each walked via its own "Aage
/// badhein" tap; only the LAST tap (on the last internal page) actually
/// calls `TradeFormCubit.savePreferencesAndAdvance` and moves the OUTER
/// walk. Every test that used to reach/save the preferences marker in one
/// tap drives all six here instead of duplicating this sequence.
///
/// USED TO be nine pages (credential / council / kis saal poora hua +
/// institute) — dropped because they duplicated the SAME "ITI ya Diploma?"
/// ask the `qualifications` marker's education entries already own; see
/// `TradeFormPreferencesPageState.pageCount`'s own doc.
Future<void> _walkThroughPreferencesPages(WidgetTester tester) async {
  for (int i = 0; i < 6; i++) {
    await tester.ensureVisible(find.text('Aage badhein'));
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
  }
}

/// Picks a start date on the employment card through the month/year sheet:
/// the field reads "Nahi bataya" until set, then a year chip, then a month
/// chip. Issue #issue2 makes the start date required on any used card.
Future<void> _pickStartDate(
  WidgetTester tester, {
  String year = '2021',
  String month = 'Jan',
}) async {
  await tester.ensureVisible(find.text('Nahi bataya').first);
  await tester.tap(find.text('Nahi bataya').first);
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.text(year));
  await tester.tap(find.text(year));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.text(month));
  await tester.tap(find.text(month));
  await tester.pumpAndSettle();
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

// #1429 — every fixture city is tagged the SAME test state so existing test
// flows only need one state pick (via `_pickCityState`) before adding
// several cities, rather than re-picking a real (and here irrelevant) state
// per city.
const String _kTestCityState = 'Haryana';

const WorkPrefOptionsDto _prefOptions = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
  cities: <CityOptionDto>[
    CityOptionDto(
        value: 'Delhi', aliases: <String>['dilli'], state: _kTestCityState),
    CityOptionDto(
        value: 'Faridabad', aliases: <String>[], state: _kTestCityState),
    CityOptionDto(
        value: 'Ghaziabad', aliases: <String>[], state: _kTestCityState),
    CityOptionDto(
        value: 'Gurugram',
        aliases: <String>['gurgaon'],
        state: _kTestCityState),
    CityOptionDto(
        value: 'Noida', aliases: <String>[], state: _kTestCityState),
    CityOptionDto(
        value: 'Mumbai', aliases: <String>[], state: _kOtherCityState),
    CityOptionDto(
        value: 'Pune', aliases: <String>[], state: _kOtherCityState),
  ],
  states: <String>[_kTestCityState, _kOtherCityState, _kCitylessState],
);

/// A second state WITH cities, so "cities are filtered to the picked state"
/// is a real assertion rather than one that passes for want of any other
/// state's data.
const String _kOtherCityState = 'Maharashtra';

/// A state the gazetteer has NO city for — 23 of the real 36 states/UTs are
/// in this position, so the picker must stay answerable there.
const String _kCitylessState = 'Bihar';

/// Picks [state] via the cities page's state-then-city cascade (#1429) — the
/// worker must be on the preferences marker's cities internal page (page 4)
/// already; opens the `BbSearchableDropdownField` sheet and taps the option.
Future<void> _pickCityState(WidgetTester tester, String state) async {
  await tester.tap(find.text('STATE CHUNEIN'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(state));
  await tester.pumpAndSettle();
}

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

  testWidgets('a non-searchable question renders kit option cards; ticking '
      'one and pressing the docked bar submits and advances',
      (WidgetTester tester) async {
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
    // turning_machine is multi-select: a card tap only SELECTS it — an
    // explicit "Aage badhein" (the docked QuestionnaireBottomBar) sends it.
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

    expect(find.text('Type karke dhoondein'), findsOneWidget); // search box hint
    expect(find.text(_kDecline), findsOneWidget); // decline affordance
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
    // The form-flow chrome is tall enough that the link can start under the
    // docked bar on the test surface — scroll it into view first.
    await tester.ensureVisible(find.text(_kDecline));
    await tester.tap(find.text(_kDecline));
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
    await tester.ensureVisible(find.text(_kDecline).first);
    await tester.tap(find.text(_kDecline).first); // decline q1
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text(_kDecline).first);
    await tester.tap(find.text(_kDecline).first); // decline q2 (searchable)
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
    await tester.ensureVisible(find.text(_kDecline).first);
    await tester.tap(find.text(_kDecline).first); // decline q1
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text(_kDecline).first);
    await tester.tap(find.text(_kDecline).first); // decline q2
    await tester.pumpAndSettle();
    await _walkThroughPreferencesPages(tester); // walk + save preferences
    expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);

    // The employment marker is the LAST step — the button reads "Ho gaya".
    expect(find.text('Ho gaya'), findsOneWidget);
    await tester.ensureVisible(find.text('Ho gaya'));
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    // No employer was added, edited or removed and nothing was banked, so the
    // whole-history replace is skipped rather than sending [] over it.
    verifyNever(() => repo.saveEmployment(any()));
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
      await tester.ensureVisible(find.text('Conventional lathe'));
      await tester.tap(find.text('Conventional lathe'));
      await tester.pump();
      expect(_optionSelected(tester, 'CNC lathe'), isTrue);

      // The form-flow strip + multi-select hint push the third card toward
      // the docked bar — scroll it into view so the tap lands on the card.
      await tester.ensureVisible(find.text('In me se koi nahi'));
      await tester.tap(find.text('In me se koi nahi'));
      await tester.pump();

      expect(_optionSelected(tester, 'CNC lathe'), isFalse);
      expect(_optionSelected(tester, 'Conventional lathe'), isFalse);
      expect(_optionSelected(tester, 'In me se koi nahi'), isTrue);

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
      expect(_optionSelected(tester, 'CNC lathe'), isTrue,
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
      expect(_optionSelected(tester, 'Brass'), isTrue,
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
                    // A declined save is how BOTH the "Pata nahi / Baad mein
                    // batayein" link and
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
      expect(_optionSelected(tester, 'In me se koi nahi'), isTrue,
          reason: 'a declined saved answer must render the none-of-above '
              'chip selected, not blank/untouched');
      expect(_optionSelected(tester, 'CNC lathe'), isFalse);
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
      expect(_optionSelected(tester, 'In me se koi nahi'), isTrue,
          reason: 'a declined saved answer must render the none-of-above '
              'chip selected, not blank/untouched');
      expect(_optionSelected(tester, 'Brass'), isFalse);
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
      expect(_optionSelected(tester, 'CNC lathe'), isFalse,
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
      expect(_progressStrip(tester).position, 1);
      expect(_progressStrip(tester).total, 4);

      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q1
      await tester.pumpAndSettle();
      expect(_progressStrip(tester).position, 2);
      expect(_progressStrip(tester).total, 4);

      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q2
      await tester.pumpAndSettle();

      // Now on the preferences marker screen. `state.answered`/`state.total`
      // are the server's question-only counters (2/2 per the mock above,
      // #1375) — frozen from here on — but the bar still reads 3/4, the
      // worker's actual position in the walk.
      expect(find.text('Hindi'), findsOneWidget);
      expect(_progressStrip(tester).position, 3);
      expect(_progressStrip(tester).total, 4);

      // Walking the preferences marker's OWN internal pages must not move
      // this OUTER bar either — it stays at 3/4 until the marker actually
      // saves (the LAST internal-page tap).
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // internal page 0 -> 1
      await tester.pumpAndSettle();
      expect(_progressStrip(tester).position, 3);
      expect(_progressStrip(tester).total, 4);

      for (int i = 0; i < 5; i++) {
        await tester.ensureVisible(find.text('Aage badhein'));
        await tester.tap(find.text('Aage badhein'));
        await tester.pumpAndSettle();
      }
      verify(() => repo.savePreferences(any())).called(1);

      // THE REGRESSION CHECK: a pure marker-screen save (no question
      // answered) still moved the bar — onto the employment marker, reading
      // fully complete rather than frozen at 3/4.
      expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
      expect(_progressStrip(tester).position, 4);
      expect(_progressStrip(tester).total, 4);
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

      // The full-width progress strip sits above the body now, so the chip
      // row can start behind the docked bar — scroll it into view first.
      await tester.ensureVisible(find.text('Fanuc Oi-TF Programming'));
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
      // #1384 item 2 — education is the marker's 2nd-4th internal pages
      // (credential+subject / council / year+institute), each its own page.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> credential+subject
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Aur ek entry jodein'));
      await tester.tap(find.text('Aur ek entry jodein'));
      await tester.pumpAndSettle();

      expect(find.text('ITI'), findsOneWidget);
      expect(_optionSelected(tester, 'ITI'), isFalse);
      await tester.ensureVisible(find.text('ITI'));
      await tester.tap(find.text('ITI'));
      await tester.pumpAndSettle();
      expect(_optionSelected(tester, 'ITI'), isTrue);

      // ITI names a trade, so the subject is now shown and REQUIRED on this
      // page (a used row must be complete before the wizard advances).
      await tester.enterText(find.byType(TextField).first, 'Machinist');
      await tester.pump();

      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> council
      await tester.pumpAndSettle();

      expect(find.text('NCVT'), findsOneWidget);
      expect(_optionSelected(tester, 'NCVT'), isFalse);
      await tester.tap(find.text('NCVT'));
      await tester.pumpAndSettle();
      expect(_optionSelected(tester, 'NCVT'), isTrue);
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
      // A used certificate row must be complete: name, issuer and year.
      await tester.enterText(find.byType(TextField).at(0), 'ITI Certificate');
      await tester.enterText(find.byType(TextField).at(1), 'Govt ITI');
      await tester.enterText(find.byType(TextField).at(2), '2019');
      await tester.pumpAndSettle();
      // #1465 — with NO education added, the marker is TWO internal pages:
      // certificates -> credential+subject. The council and year+institute
      // pages render one row per education entry, so with none they would be
      // blank and the wizard does not walk them at all. That single "Aage
      // badhein" is purely internal pagination and must NOT reach the server.
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
      // A used certificate row must be complete: name, issuer and year.
      await tester.enterText(find.byType(TextField).at(0), 'ITI Certificate');
      await tester.enterText(find.byType(TextField).at(1), 'Govt ITI');
      await tester.enterText(find.byType(TextField).at(2), '2019');
      await tester.pumpAndSettle();
      // #1465 — no education, so the marker's LAST internal page is
      // credential+subject, one hop away.
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
      // #1465 — nothing touched at all, so there is no education and the
      // marker is two pages; the one "Aage badhein" is purely internal and
      // must not touch saveQualifications either.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      verifyNever(() => repo.saveQualifications(any()));
      expect(router.routerDelegate.currentConfiguration.uri.path, '/building');
    });

    testWidgets(
        'an institute name typed lowercase is title-cased before it reaches '
        'saveQualifications', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());

      final GoRouter router = await pumpToBuilding(tester);
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> credential+subject
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Aur ek entry jodein'));
      await tester.tap(find.text('Aur ek entry jodein'));
      await tester.pumpAndSettle();

      // A used education row is complete: credential + subject (ITI names one)
      // -> council -> year + institute.
      await tester.ensureVisible(find.text('ITI'));
      await tester.tap(find.text('ITI'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'Machinist');
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> council
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('NCVT'));
      await tester.tap(find.text('NCVT'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> year+institute
      await tester.pumpAndSettle();
      // Now on year+institute. Two fields (year, then institute).
      expect(find.text('Institute ka naam'), findsOneWidget);
      await tester.enterText(find.byType(TextField).first, '2018');
      await tester.enterText(find.byType(TextField).last, 'rvm cad pvt ltd');
      await tester.pump();
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final TradeFormQualifications sent = verify(
              () => repo.saveQualifications(captureAny()))
          .captured
          .single as TradeFormQualifications;
      expect(sent.educations.single.institute, 'Rvm Cad Pvt Ltd');
      expect(router.routerDelegate.currentConfiguration.uri.path, '/building');
    });

    testWidgets(
        'a trade/subject typed lowercase is title-cased before it reaches '
        'saveQualifications', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _qualificationsForm());

      final GoRouter router = await pumpToBuilding(tester);
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> credential+subject
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Aur ek entry jodein'));
      await tester.tap(find.text('Aur ek entry jodein'));
      await tester.pumpAndSettle();

      // "Trade ya subject" only shows once a subject-bearing credential
      // (ITI/Diploma/Graduate/12th pass) is picked — hidden until then.
      expect(find.text('Trade ya subject'), findsNothing);
      await tester.ensureVisible(find.text('ITI'));
      await tester.tap(find.text('ITI'));
      await tester.pumpAndSettle();
      expect(find.text('Trade ya subject'), findsOneWidget);
      await tester.enterText(find.byType(TextField).first, 'electric');
      await tester.pump();

      // Walk the remaining pages (council, then year+institute), completing the
      // used row, to save.
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> council
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('NCVT'));
      await tester.tap(find.text('NCVT'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein')); // -> year+institute
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, '2018');
      await tester.enterText(find.byType(TextField).last, 'Govt ITI');
      await tester.pump();
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final TradeFormQualifications sent = verify(
              () => repo.saveQualifications(captureAny()))
          .captured
          .single as TradeFormQualifications;
      expect(sent.educations.single.field, 'Electric');
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q2
      await tester.pumpAndSettle();

      // On the preferences marker — pick a language chip, but do NOT save
      // yet, so this test also proves the fix is keyed off the CUBIT's own
      // banked state (only written on a SUCCESSFUL save), not off whatever
      // the unmounted widget happened to hold in memory.
      expect(find.text('Hindi'), findsOneWidget);
      expect(_optionSelected(tester, 'Hindi'), isFalse);
      await tester.tap(find.text('Hindi'));
      await tester.pump();
      expect(_optionSelected(tester, 'Hindi'), isTrue);

      // Walk the marker's own internal pages (#1384 item 2) — only the
      // LAST tap (the last internal page) actually saves.
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
      expect(_optionSelected(tester, 'Hindi'), isTrue,
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q2
      await tester.pumpAndSettle();

      // Page 0 (languages) — the EARLIEST page.
      expect(find.text('Hindi'), findsOneWidget);
      await tester.tap(find.text('Hindi'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 1 (documents) — its own page.
      expect(find.text('Aadhaar'), findsOneWidget);
      await tester.tap(find.text('Aadhaar'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 2 (shift) — its own page.
      expect(find.text('Day'), findsOneWidget);
      await tester.tap(find.text('Day'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 3 (job type) — its own page.
      expect(find.text('Permanent'), findsOneWidget);
      await tester.tap(find.text('Permanent'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 4 (cities) — its own page. Resolves against the gazetteer
      // fixture (`_prefOptions.cities` includes Faridabad).
      expect(find.text('Kahan kaam karna chahte hain?'), findsOneWidget);
      await _pickCityState(tester, _kTestCityState);
      await tester.enterText(find.byType(TextField).first, 'Faridabad');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      // Flush the resolved-add banner's 2s auto-dismiss timer.
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Page 5 (relocate + accommodation + salary) — the LAST internal page;
      // this tap actually saves.
      expect(find.text('Doosre sheher ja sakte hain?'), findsOneWidget);
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      final TradeFormPreferences sent = verify(
              () => repo.savePreferences(captureAny()))
          .captured
          .single as TradeFormPreferences;
      // Fields entered on page 0 (the EARLIEST page) — the whole point of
      // this test — survived several MORE internal-page transitions.
      expect(sent.languages, <String>{'hindi'});
      expect(sent.documentsReady, <String>{'aadhaar'});
      // Fields entered on pages 2-4 also made it through.
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q2
      await tester.pumpAndSettle();

      // Page 0 — tick a language chip.
      await tester.tap(find.text('Hindi'));
      await tester.pump();
      await tester.ensureVisible(find.text('Aage badhein'));
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      // Now on page 1 (documents) — the outer step never moved (still the
      // preferences marker), so "Wapas" must go back to page 0, NOT pop
      // the whole screen or walk to a previous question.
      expect(find.text('Aadhaar'), findsOneWidget);
      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('Hindi'), findsOneWidget,
          reason: 'internal back must land on page 0, not a previous '
              'question or a popped screen');
      expect(_optionSelected(tester, 'Hindi'), isTrue,
          reason: 'the field entered before walking forward must still be '
              'there after walking back');
    });
  });

  group('preferred cities: 5-city cap + horizontal list', () {
    testWidgets(
        'no "+" add button — a worker cannot enter a custom city, only pick '
        'a suggestion', (WidgetTester tester) async {
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
      for (int i = 0; i < 4; i++) {
        await tester.ensureVisible(find.text('Aage badhein'));
        await tester.tap(find.text('Aage badhein'));
        await tester.pumpAndSettle();
      }

      expect(find.text('Kahan kaam karna chahte hain?'), findsOneWidget);
      expect(find.text('+'), findsNothing);
      await _pickCityState(tester, _kTestCityState);
      await tester.enterText(find.byType(TextField).first, 'gurugram');
      await tester.pump();
      expect(find.text('+'), findsNothing);
    });

    Future<void> walkToCitiesPage(WidgetTester tester) async {
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q2
      await tester.pumpAndSettle();
      // Page 0 (languages) -> 1 (documents) -> 2 (shift) -> 3 (jobType) ->
      // 4 (cities).
      for (int i = 0; i < 4; i++) {
        await tester.ensureVisible(find.text('Aage badhein'));
        await tester.tap(find.text('Aage badhein'));
        await tester.pumpAndSettle();
      }
      // #1429 — the city search only opens once a state is picked.
      await _pickCityState(tester, _kTestCityState);
    }

    Future<void> addCityText(WidgetTester tester, String city) async {
      await tester.enterText(find.byType(TextField).first, city);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      // A resolved add shows a self-dismissing MaterialBanner (2s) — flush
      // that timer now so it never leaks past this test as a pending timer.
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
    }

    testWidgets(
        'a 6th city cannot be added; the add row disappears at the cap and '
        'only the first 5 reach onSave',
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
      await walkToCitiesPage(tester);

      expect(find.text('Kahan kaam karna chahte hain?'), findsOneWidget);
      for (final String city in <String>[
        'Faridabad',
        'Gurugram',
        'Noida',
        'Delhi',
        'Ghaziabad',
      ]) {
        await addCityText(tester, city);
      }

      // At the 5-city cap: the add row (just the text field — no "+" button,
      // #1406/#1410 already closed custom free text) is gone — the same
      // "affordance disappears at the cap" convention as certificates/
      // educations.
      expect(find.byType(TextField), findsNothing);

      // Rendered as a horizontal ListView, not a Wrap — the whole point of
      // this change.
      final ListView list = tester.widget<ListView>(find.byType(ListView));
      expect(list.scrollDirection, Axis.horizontal);

      // Removing one must bring the add row back and free a slot.
      await tester.ensureVisible(find.byIcon(Icons.close).first);
      // The page scrolls now: let the scroll settle (the field vanishing at
      // the cap shrinks it) — a Scrollable ignores taps while it moves.
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.close).first);
      await tester.pump();
      expect(find.byType(TextField), findsOneWidget);
      await addCityText(tester, 'Faridabad');
      expect(find.byType(TextField), findsNothing);

      // Walk to the marker's last internal page and save: page 4 (cities)
      // -> 5 (relocate) is 1 tap, then one more tap WHILE on page 5 saves.
      for (int i = 0; i < 2; i++) {
        await tester.ensureVisible(find.text('Aage badhein'));
        await tester.tap(find.text('Aage badhein'));
        await tester.pumpAndSettle();
      }

      final TradeFormPreferences sent = verify(
              () => repo.savePreferences(captureAny()))
          .captured
          .single as TradeFormPreferences;
      expect(sent.preferredCities, hasLength(5));
      expect(
          sent.preferredCities,
          <String>['Gurugram', 'Noida', 'Delhi', 'Ghaziabad', 'Faridabad']);
    });

    testWidgets(
        'a city not in the gazetteer shows an inline error and is never '
        'added (#1406/#1410) — no more silent free text',
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
      await walkToCitiesPage(tester);

      await addCityText(tester, 'Kota');

      expect(
          find.textContaining('nahi mila'),
          findsOneWidget,
          reason: 'the original #1406 bug: a city outside the gazetteer '
              'must say so, not silently accept it and 400 on save');
      // The text field is still there (not at the cap) and nothing was
      // added to the selected-cities list.
      expect(find.byType(ListView), findsNothing);
    });

    testWidgets(
        'typing an alias ("dilli") resolves and adds the canonical spelling '
        '("Delhi") — never the alias itself',
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
      await walkToCitiesPage(tester);

      await addCityText(tester, 'dilli');

      expect(find.text('Delhi'), findsOneWidget);
      expect(find.text('dilli'), findsNothing);
    });

    testWidgets(
        'tapping a suggestion chip adds that city directly, without typing '
        'the full name',
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
      await walkToCitiesPage(tester);

      // Empty query browses the whole (small) gazetteer — tap "Gurugram"
      // straight off the suggestion row, no typing at all. The state picker
      // above pushed this row lower on screen (#1429), so scroll it into
      // view first.
      await tester.ensureVisible(find.text('Gurugram'));
      await tester.tap(find.text('Gurugram'));
      await tester.pump();
      expect(find.text('Sheher add ho gaya'), findsOneWidget);
      // Flush the resolved-add banner's 2s auto-dismiss timer.
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.text('Sheher add ho gaya'), findsNothing);

      final ListView list = tester.widget<ListView>(find.byType(ListView));
      expect(list.scrollDirection, Axis.horizontal);
      expect(find.descendant(
              of: find.byType(ListView), matching: find.text('Gurugram')),
          findsOneWidget);
      // The suggestion row must not still offer a city already picked.
      expect(
          find.descendant(
              of: find.byType(Wrap), matching: find.text('Gurugram')),
          findsNothing);
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q2
      await tester.pumpAndSettle();
      await _walkThroughPreferencesPages(tester);

      // Now on the employment marker's single (empty) page.
      expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein')); // employer #1
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      await tester.enterText(find.byType(TextField).at(2), 'Naye parts banate the');
      await tester.pump();
      // #issue2 — every used card needs a start date before the walk can
      // finish, including the one no longer on screen when "Ho gaya" is hit.
      await _pickStartDate(tester, year: '2021', month: 'Jan');

      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein')); // employer #2
      await tester.pumpAndSettle();

      // Employer #1's card is gone from THIS page — proof this is a
      // per-employer internal page, not a stacked scroll of both cards.
      expect(find.text('Acme'), findsNothing);

      await tester.enterText(find.byType(TextField).at(0), 'Beta Corp');
      await tester.enterText(find.byType(TextField).at(1), 'Welder');
      await tester.enterText(find.byType(TextField).at(2), 'Gate pe welding karta tha');
      await tester.pump();
      await _pickStartDate(tester, year: '2022', month: 'Feb');

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

  // #issue2 — a saved work history with no start (and no end) is what printed
  // "Duration not stated" on the résumé. Every card the worker actually USED
  // must carry a start, and an end unless it is his current job; a blank card
  // is not an answer and must never block finishing.
  group('employment dates are required on a used card (#issue2)', () {
    Future<void> walkToEmploymentPage(WidgetTester tester) async {
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
      await _walkThroughPreferencesPages(tester);
      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein'));
      await tester.pumpAndSettle();
    }

    Future<void> fillUsedCard(WidgetTester tester) async {
      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      await tester.enterText(find.byType(TextField).at(2), 'Naye parts banate the');
      await tester.pump();
    }

    testWidgets(
        'a used card with no start date blocks the finish and saves nothing',
        (WidgetTester tester) async {
      await walkToEmploymentPage(tester);
      await fillUsedCard(tester);

      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      expect(
          find.text('Kab shuru kiya — saal aur mahina chunein.'), findsOneWidget);
      verifyNever(() => repo.saveEmployment(any()));

      // Dismiss the banner, pick the start date, and the same finish works.
      await tester.tap(find.text('Theek hai'));
      await tester.pumpAndSettle();
      await _pickStartDate(tester);
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();
      verify(() => repo.saveEmployment(any())).called(1);
    });

    testWidgets('turning "Abhi yahin" OFF requires an end date',
        (WidgetTester tester) async {
      await walkToEmploymentPage(tester);
      await fillUsedCard(tester);
      await _pickStartDate(tester);

      await tester.ensureVisible(find.text('Abhi yahin kaam kar rahe hain'));
      await tester.tap(find.text('Abhi yahin kaam kar rahe hain'));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      expect(
        find.text(
            'Kab tak kaam kiya — saal aur mahina chunein, ya "Abhi yahin" ON rakhein.'),
        findsOneWidget,
      );
      verifyNever(() => repo.saveEmployment(any()));

      // The end field is the only one still reading "Nahi bataya".
      await tester.tap(find.text('Theek hai'));
      await tester.pumpAndSettle();
      await _pickStartDate(tester, year: '2023', month: 'Mar');
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();
      verify(() => repo.saveEmployment(any())).called(1);
    });

    testWidgets('a blank added card can be finished with no dates at all',
        (WidgetTester tester) async {
      await walkToEmploymentPage(tester);

      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      // A card with nothing on it is not an answer, so it is never blocked —
      // skipping work history entirely still works.
      expect(
          find.text('Kab shuru kiya — saal aur mahina chunein.'), findsNothing);
    });
  });

  // #issue2 follow-up — "required" alone still lets an unusable date through:
  // a future month, a 1900 typo, or an end before its start are all refused,
  // and the picker itself never OFFERS a future year or month so the worker
  // cannot even reach one. The two hard bounds are asserted directly against
  // the page's own blocker, because a picker cannot produce them anyway.
  group('valid-date bounds on a used card (#issue2)', () {
    const List<String> months = <String>[
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];

    Widget host(
      GlobalKey<TradeFormEmploymentPageState> key,
      List<TradeFormEmploymentEntry> entries,
    ) {
      return kitTestApp(
        Scaffold(
          // The wizard hosts this page inside its scroll body; the page itself
          // is an unbounded Column, so the test stand-in must scroll it too.
          body: SingleChildScrollView(
            child: TradeFormEmploymentPage(
              key: key,
              enabled: true,
              onSave: (_) {},
              loadOptions: () async => const WorkPrefOptionsDto(
                languages: <String, String>{},
                documentsReady: <String, String>{},
                jobType: <String, String>{},
                shift: <String, String>{},
              ),
              initialEntries: entries,
            ),
          ),
        ),
      );
    }

    testWidgets('a start in the future is refused before it can print',
        (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      final String future = '${DateTime.now().year + 1}-01';
      await tester.pumpWidget(
        host(key, <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Acme',
            roleLabel: 'Fitter',
            workDone: 'Naye parts banate the',
            startYm: future,
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(
        key.currentState!.currentPageError(),
        'Aage ke mahine ki taareekh nahi ho sakti — aaj tak ka chunein.',
      );
    });

    testWidgets('a start before 1950 is refused as a typo',
        (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(
        host(key, const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Acme',
            roleLabel: 'Fitter',
            workDone: 'Naye parts banate the',
            startYm: '1900-01',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(
        key.currentState!.currentPageError(),
        'Itna purana saal sahi nahi lagta — sahi saal chunein.',
      );
    });

    testWidgets('an end before its start is refused', (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(
        host(key, const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Acme',
            roleLabel: 'Fitter',
            workDone: 'Naye parts banate the',
            startYm: '2020-06',
            endYm: '2019-05',
            stillWorking: false,
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(
        key.currentState!.currentPageError(),
        'Khatam hone ki date shuru hone ke baad honi chahiye.',
      );
    });

    testWidgets('the picker offers no future year and no future month',
        (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(
        host(key, const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(employerName: '', roleLabel: ''),
        ]),
      );
      await tester.pumpAndSettle();

      final int nowYear = DateTime.now().year;
      final int nowMonth = DateTime.now().month;

      await tester.ensureVisible(find.text('Nahi bataya').first);
      await tester.tap(find.text('Nahi bataya').first);
      await tester.pumpAndSettle();

      expect(find.text('$nowYear'), findsOneWidget);
      expect(find.text('${nowYear + 1}'), findsNothing);

      await tester.ensureVisible(find.text('$nowYear'));
      await tester.tap(find.text('$nowYear'));
      await tester.pumpAndSettle();

      expect(find.text(months[nowMonth - 1]), findsOneWidget);
      if (nowMonth < 12) {
        expect(find.text(months[nowMonth]), findsNothing);
      }
    });

    // A used card must carry every field the sheet prints — the company name,
    // the role and the work description. Only city/state may be left empty.
    testWidgets('a used card missing its work description is blocked',
        (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(
        host(key, const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Acme',
            roleLabel: 'Fitter',
            startYm: '2020-01',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(
        key.currentState!.currentPageError(),
        'Aap kya kaam karte the — likhein.',
      );
    });

    testWidgets('a used card missing its role is blocked',
        (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(
        host(key, const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Acme',
            roleLabel: '',
            workDone: 'Naye parts banate the',
            startYm: '2020-01',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(
        key.currentState!.currentPageError(),
        'Aapka kaam / role likhein.',
      );
    });

    testWidgets('a used card missing its company name is blocked',
        (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(
        host(key, const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: '',
            roleLabel: 'Fitter',
            workDone: 'Naye parts banate the',
            startYm: '2020-01',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(key.currentState!.currentPageError(), 'Company ka naam likhein.');
    });

    testWidgets('a used card passes once name/role/work/start are set — '
        'city and state stay optional', (WidgetTester tester) async {
      final GlobalKey<TradeFormEmploymentPageState> key =
          GlobalKey<TradeFormEmploymentPageState>();
      await tester.pumpWidget(
        host(key, const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Acme',
            roleLabel: 'Fitter',
            workDone: 'Naye parts banate the',
            startYm: '2020-01',
            employerCity: 'Pune',
            employerState: 'Maharashtra',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(key.currentState!.currentPageError(), isNull);
    });
  });

  group('employer location: state-then-city picker, real gazetteer (#1429)', () {
    Future<void> walkToEmploymentPage(WidgetTester tester) async {
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first);
      await tester.pumpAndSettle();
      await _walkThroughPreferencesPages(tester);
      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein'));
      await tester.pumpAndSettle();
    }

    testWidgets(
        'a blank entry defaults to the picker — both dropdowns show their '
        'placeholder, no free-text city/state fields until "Khud likhein"',
        (WidgetTester tester) async {
      await walkToEmploymentPage(tester);

      // Both closed dropdowns render their placeholder text — the options
      // themselves are inside the (closed) sheet, not inline.
      expect(find.text('STATE CHUNEIN'), findsOneWidget);
      expect(find.text('SHEHER CHUNEIN'), findsOneWidget);
      expect(find.text('Haryana'), findsNothing);
      expect(find.text('Maharashtra'), findsNothing);
      // Only name, role, and work-done — no free-text city/state yet.
      expect(find.byType(TextField), findsNWidgets(3));
    });

    testWidgets(
        'picking a state then a city (via the searchable dropdown sheets) '
        'fills employerCity/employerState, filtered to that state',
        (WidgetTester tester) async {
      await walkToEmploymentPage(tester);

      await tester.ensureVisible(find.text('STATE CHUNEIN'));
      await tester.tap(find.text('STATE CHUNEIN'));
      await tester.pumpAndSettle();

      expect(find.text('Haryana'), findsOneWidget);
      expect(find.text('Maharashtra'), findsOneWidget);

      await tester.tap(find.text('Haryana'));
      await tester.pumpAndSettle();

      // The state dropdown now shows the picked value, not the placeholder.
      expect(find.text('Haryana'), findsOneWidget);
      expect(find.text('STATE CHUNEIN'), findsNothing);

      await tester.ensureVisible(find.text('SHEHER CHUNEIN'));
      await tester.tap(find.text('SHEHER CHUNEIN'));
      await tester.pumpAndSettle();

      expect(find.text('Gurugram'), findsOneWidget);
      expect(find.text('Faridabad'), findsOneWidget);
      // The other state's cities must not leak into this state's sheet —
      // a real assertion now that the fixture actually HAS another state
      // with cities of its own.
      expect(find.text('Mumbai'), findsNothing);
      expect(find.text('Pune'), findsNothing);

      await tester.tap(find.text('Gurugram'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      await tester.enterText(find.byType(TextField).at(2), 'Naye parts banate the');
      await tester.pump();
      await _pickStartDate(tester);
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final List<TradeFormEmploymentEntry> sent = verify(
              () => repo.saveEmployment(captureAny()))
          .captured
          .single as List<TradeFormEmploymentEntry>;
      expect(sent.single.employerCity, 'Gurugram');
      expect(sent.single.employerState, 'Haryana');
    });

    // 23 of the real 36 states/UTs have no gazetteer city, because the
    // gazetteer is a closed set of manufacturing hubs rather than a map of
    // India. Picking one of those must land on a field the worker can
    // answer, never an empty menu.
    testWidgets(
        'a state the gazetteer has no city for falls back to a typed city, '
        'not an empty dropdown', (WidgetTester tester) async {
      await walkToEmploymentPage(tester);

      await tester.ensureVisible(find.text('STATE CHUNEIN'));
      await tester.tap(find.text('STATE CHUNEIN'));
      await tester.pumpAndSettle();
      expect(find.text(_kCitylessState), findsOneWidget);
      await tester.tap(find.text(_kCitylessState));
      await tester.pumpAndSettle();

      // No city dropdown to open — a text field took its place.
      expect(find.text('SHEHER CHUNEIN'), findsNothing);

      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      // The city field is the third: employer, role, then city. Work-done is
      // the fourth and is required on a used card.
      await tester.enterText(find.byType(TextField).at(2), 'Muzaffarpur');
      await tester.enterText(find.byType(TextField).at(3), 'Naye parts banate the');
      await tester.pump();
      await _pickStartDate(tester);
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final List<TradeFormEmploymentEntry> sent = verify(
              () => repo.saveEmployment(captureAny()))
          .captured
          .single as List<TradeFormEmploymentEntry>;
      expect(sent.single.employerCity, 'Muzaffarpur');
      expect(sent.single.employerState, _kCitylessState);
    });

    testWidgets(
        'the city dropdown search box filters to a typed query',
        (WidgetTester tester) async {
      await walkToEmploymentPage(tester);

      await tester.ensureVisible(find.text('STATE CHUNEIN'));
      await tester.tap(find.text('STATE CHUNEIN'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Haryana'));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('SHEHER CHUNEIN'));
      await tester.tap(find.text('SHEHER CHUNEIN'));
      await tester.pumpAndSettle();

      expect(find.text('Gurugram'), findsOneWidget);
      expect(find.text('Faridabad'), findsOneWidget);

      await tester.enterText(find.byType(TextField).last, 'Fari');
      await tester.pump();

      expect(find.text('Faridabad'), findsOneWidget);
      expect(find.text('Gurugram'), findsNothing);
    });

    testWidgets(
        '"Khud likhein" reveals free-text fallback fields for an employer '
        'outside the 2-state demo set', (WidgetTester tester) async {
      await walkToEmploymentPage(tester);

      await tester.ensureVisible(find.text('Khud likhein'));
      await tester.tap(find.text('Khud likhein'));
      await tester.pump();

      expect(find.text('Sheher'), findsWidgets); // label + hint text, both "Sheher"
      expect(find.text('State'), findsWidgets); // label + hint text, both "State"
      // name, role, state, city, work-done — State (Rajya) ALWAYS precedes
      // Sheher (City) in the kit layout.
      expect(find.byType(TextField), findsNWidgets(5));

      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      await tester.enterText(find.byType(TextField).at(2), 'Rajasthan');
      await tester.enterText(find.byType(TextField).at(3), 'Kota');
      await tester.enterText(find.byType(TextField).at(4), 'Naye parts banate the');
      await tester.pump();
      await _pickStartDate(tester);
      await tester.ensureVisible(find.text('Ho gaya'));
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final List<TradeFormEmploymentEntry> sent = verify(
              () => repo.saveEmployment(captureAny()))
          .captured
          .single as List<TradeFormEmploymentEntry>;
      expect(sent.single.employerCity, 'Kota');
      expect(sent.single.employerState, 'Rajasthan');
    });
  });

  // #1384 item 3 — the ONE true final submit of the walk must be told apart
  // from every ordinary "next". The Master UI Kit's docked bar has a single
  // button colour, so the distinction is now its own label AND a dropped
  // forward arrow (a button that finishes the walk does not point onward).
  group('the true final-submit button is distinct (#1384 item 3)', () {
    testWidgets(
        'a marker-is-last-step case renders "Ho gaya" with no forward arrow',
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
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q1
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text(_kDecline).first);
      await tester.tap(find.text(_kDecline).first); // decline q2
      await tester.pumpAndSettle();
      await _walkThroughPreferencesPages(tester);

      // Employment (no employers yet) is the walk's LAST step, on its own
      // (only) internal page — the TRUE final button.
      expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
      final QuestionnaireBottomBar bar = _bottomBar(tester);
      expect(bar.nextLabel, 'Ho gaya');
      expect(bar.showArrow, isFalse);
      expect(bar.onNext, isNotNull);
      expect(find.text('Aage badhein'), findsNothing);
      expect(
        find.descendant(
          of: find.byType(QuestionnaireBottomBar),
          matching: find.byIcon(Icons.arrow_forward_rounded),
        ),
        findsNothing,
      );
    });

    testWidgets(
        'a question-is-last-step case renders "Submit karein" with no forward '
        'arrow, not "Aage badhein"', (WidgetTester tester) async {
      final TradeForm questionOnlyForm = TradeForm(
        kind: 'cnc_turner',
        packId: 'qp_cnc_turning',
        packVersion: 1,
        sections: <TradeFormSection>[
          TradeFormSection(
            id: 'capability',
            title: 'Machines, controllers & capability',
            screens: <TradeFormStep>[
              const TradeFormQuestionStep(
                  question: _plainQuestion, searchable: false),
            ],
          ),
        ],
      );
      when(() => repo.loadForm()).thenAnswer((_) async => questionOnlyForm);

      await pump(tester);
      // _plainQuestion is multi-select — a card tap only selects; the docked
      // bar submits.
      await tester.tap(find.text('CNC lathe'));
      await tester.pump();

      expect(find.text('Submit karein'), findsOneWidget);
      expect(find.text('Aage badhein'), findsNothing);
      final QuestionnaireBottomBar bar = _bottomBar(tester);
      expect(bar.nextLabel, 'Submit karein');
      expect(bar.showArrow, isFalse);
      expect(bar.onNext, isNotNull);
    });

    testWidgets(
        'a non-last question step reads "Aage badhein" with the forward arrow',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());

      await pump(tester);
      // _form()'s first question (turning_machine, multi-select) is NOT the
      // walk's last step — one more question and two markers follow.
      await tester.tap(find.text('CNC lathe'));
      await tester.pump();

      final QuestionnaireBottomBar bar = _bottomBar(tester);
      expect(bar.nextLabel, 'Aage badhein');
      expect(bar.showArrow, isTrue);
      expect(bar.onNext, isNotNull);
      // The ordinary next never borrows the final submit's copy.
      expect(find.text('Submit karein'), findsNothing);
    });
  });

  // KIT REDESIGN CHANGE — the Master UI Kit pins a Next bar under a radio
  // list, so a single-select / boolean tap now only SELECTS, and the docked
  // "Aage badhein" submits. It used to submit on the tap itself. The payload
  // on the wire is unchanged: `[key]` for single-select, `true|false` for
  // boolean.
  group('single-select + boolean: a tap SELECTS, the docked bar submits', () {
    const VoiceQuestion singleQuestion = VoiceQuestion(
      id: 'turning_experience',
      prompt: 'Turning ka kitna experience hai?',
      kind: VoiceQuestionKind.singleSelect,
      options: <VoiceChoice>[
        VoiceChoice(key: 'opt_a', label: 'Option A'),
        VoiceChoice(key: 'opt_b', label: 'Option B'),
      ],
    );
    const VoiceQuestion booleanQuestion = VoiceQuestion(
      id: 'drawing_reading',
      prompt: 'Kya aap drawing padh sakte hain?',
      kind: VoiceQuestionKind.boolean,
    );

    TradeForm selectForm({TradeFormSavedAnswer? singleAnswer}) => TradeForm(
          kind: 'cnc_turner',
          packId: 'qp_cnc_turning',
          packVersion: 1,
          sections: <TradeFormSection>[
            TradeFormSection(
              id: 'capability',
              title: 'Machines, controllers & capability',
              screens: <TradeFormStep>[
                TradeFormQuestionStep(
                  question: singleQuestion,
                  searchable: false,
                  answer: singleAnswer,
                ),
                const TradeFormQuestionStep(
                    question: booleanQuestion, searchable: false),
                // A trailing marker so answering the boolean never hits
                // `done` — this group is about the tap/submit split, not
                // #1367's last-step navigation.
                const TradeFormPreferencesStep(),
              ],
            ),
          ],
        );

    testWidgets(
        'a single-select tap selects without submitting; the bar sends exactly '
        'the one picked key', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => selectForm());
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'x',
            status: TradeFormAnswerStatus.answered,
            answered: 1,
            total: 2,
          ));

      await pump(tester);
      expect(find.text('Turning ka kitna experience hai?'), findsOneWidget);
      // Nothing picked yet — nothing to send.
      expect(_bottomBar(tester).onNext, isNull);

      await tester.tap(find.text('Option A'));
      await tester.pump();
      verifyNever(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          ));
      expect(_optionSelected(tester, 'Option A'), isTrue);

      // A radio: a second tap MOVES the pick.
      await tester.tap(find.text('Option B'));
      await tester.pump();
      expect(_optionSelected(tester, 'Option A'), isFalse);
      expect(_optionSelected(tester, 'Option B'), isTrue);

      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      final TradeFormAnswer sent = verify(() => repo.submitAnswer(
            questionKey: 'turning_experience',
            answer: captureAny(named: 'answer'),
          )).captured.single as TradeFormAnswer;
      expect(sent.kind, TradeFormAnswerKind.chips);
      expect(sent.optionKeys, <String>['opt_b']);
      // Advanced to the boolean question.
      expect(find.text('Kya aap drawing padh sakte hain?'), findsOneWidget);
    });

    testWidgets(
        'a boolean tap selects Haan/Nahi without submitting; the bar sends it',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => selectForm(
            singleAnswer: const TradeFormSavedAnswer(
              status: TradeFormAnswerStatus.answered,
              optionKeys: <String>['opt_a'],
            ),
          ));
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
      // Resumability skips the answered single-select — lands on the boolean.
      expect(find.text('Kya aap drawing padh sakte hain?'), findsOneWidget);
      expect(_bottomBar(tester).onNext, isNull);

      await tester.tap(find.text('Haan'));
      await tester.pump();
      verifyNever(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          ));
      expect(_optionSelected(tester, 'Haan'), isTrue);
      expect(_optionSelected(tester, 'Nahi'), isFalse);

      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();

      final TradeFormAnswer sent = verify(() => repo.submitAnswer(
            questionKey: 'drawing_reading',
            answer: captureAny(named: 'answer'),
          )).captured.single as TradeFormAnswer;
      expect(sent.kind, TradeFormAnswerKind.boolean);
      expect(sent.boolValue, isTrue);
    });

    testWidgets(
        'a saved single-select answer comes back PRE-SELECTED after goBack, '
        'ready to resubmit', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => selectForm(
            singleAnswer: const TradeFormSavedAnswer(
              status: TradeFormAnswerStatus.answered,
              optionKeys: <String>['opt_b'],
            ),
          ));

      await pump(tester);
      expect(find.text('Kya aap drawing padh sakte hain?'), findsOneWidget);

      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();

      expect(find.text('Turning ka kitna experience hai?'), findsOneWidget);
      expect(_optionSelected(tester, 'Option B'), isTrue,
          reason: 'the saved pick must render selected, not blank');
      expect(_optionSelected(tester, 'Option A'), isFalse);
      expect(_bottomBar(tester).onNext, isNotNull);
    });
  });

  // The form-flow mockups ("15. Workholding Selection", "16. Measuring
  // Instruments", "14. Turning Operations"): a yellow section title under a
  // step + CATEGORY line, the white strip with the topic and the percent, an
  // icon tile on every option card, the multi-select hint, and a listen button
  // that exists only when the device read-aloud is wired. Visual only — every
  // behaviour above is unchanged.
  group('form-flow design (Workholding / Measuring / Operations mockups)', () {
    const VoiceQuestion singleQuestion = VoiceQuestion(
      id: 'turning_experience',
      prompt: 'Turning ka kitna experience hai?',
      whyText: 'Isse sahi level ka kaam dikhaya jaata hai.',
      kind: VoiceQuestionKind.singleSelect,
      options: <VoiceChoice>[
        VoiceChoice(key: 'below_1', label: '1 saal se kam'),
        VoiceChoice(key: 'one_to_three', label: '1 se 3 saal'),
      ],
    );
    const VoiceQuestion booleanQuestion = VoiceQuestion(
      id: 'drawing_reading',
      prompt: 'Kya aap drawing padh sakte hain?',
      kind: VoiceQuestionKind.boolean,
    );

    /// multi-select -> single-select -> boolean -> preferences marker: one of
    /// every card kind, then a marker with both a multi and a single list.
    TradeForm designForm() => const TradeForm(
          kind: 'cnc_turner',
          packId: 'qp_cnc_turning',
          packVersion: 1,
          sections: <TradeFormSection>[
            TradeFormSection(
              id: 'capability',
              title: 'Machines, controllers & capability',
              screens: <TradeFormStep>[
                TradeFormQuestionStep(
                    question: _plainQuestion, searchable: false),
                TradeFormQuestionStep(
                    question: singleQuestion, searchable: false),
                TradeFormQuestionStep(
                    question: booleanQuestion, searchable: false),
              ],
            ),
            TradeFormSection(
              id: 'terms',
              title: 'Availability & terms',
              screens: <TradeFormStep>[TradeFormPreferencesStep()],
            ),
          ],
        );

    void stubAnswers() {
      when(() => repo.submitAnswer(
            questionKey: any(named: 'questionKey'),
            answer: any(named: 'answer'),
          )).thenAnswer((_) async => const TradeFormAnswerResult(
            questionKey: 'x',
            status: TradeFormAnswerStatus.declined,
            answered: 1,
            total: 3,
          ));
    }

    Future<void> decline(WidgetTester tester) async {
      await tester.ensureVisible(find.text(_kDecline));
      await tester.tap(find.text(_kDecline));
      await tester.pumpAndSettle();
    }

    Future<void> next(WidgetTester tester) async {
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
    }

    void expectEveryCardHasAnIcon(WidgetTester tester) {
      final List<IconData?> icons = <IconData?>[
        for (final MultiSelectQuestionCard c in tester
            .widgetList<MultiSelectQuestionCard>(
                find.byType(MultiSelectQuestionCard)))
          c.leadingIcon,
        for (final SingleSelectQuestionCard c in tester
            .widgetList<SingleSelectQuestionCard>(
                find.byType(SingleSelectQuestionCard)))
          c.leadingIcon,
      ];
      expect(icons, isNotEmpty);
      expect(icons, everyElement(isNotNull));
    }

    testWidgets(
        'the header carries a yellow section title and a step line with the '
        'category; the strip sits under it with the topic and the percent',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => _form());
      stubAnswers();

      await pump(tester);

      final ShiftBlueHeader header =
          tester.widget<ShiftBlueHeader>(find.byType(ShiftBlueHeader));
      expect(header.title, 'Machines, controllers & capability');
      expect(header.titleColor, OnboardingColors.safetyYellow);
      // turning_machine -> ('Machines', 'Machines & equipment'); _form() is
      // four steps, so step 1 of 4 is 25%.
      expect(find.text('STEP 1 OF 4 • MACHINES'), findsOneWidget);
      expect(find.text('MACHINES & EQUIPMENT'), findsOneWidget);
      expect(find.text('25% COMPLETED'), findsOneWidget);
      // Full width under the header — never inside the padded body.
      expect(
        find.ancestor(
          of: find.byType(FormProgressStrip),
          matching: find.byType(OnboardingBody),
        ),
        findsNothing,
      );

      await decline(tester);
      await decline(tester);

      // A marker page: the same header + strip, from its fixed topic pair.
      expect(find.text('Hindi'), findsOneWidget);
      expect(find.text('STEP 3 OF 4 • AVAILABILITY & TERMS'), findsOneWidget);
      expect(find.text('AVAILABILITY & PREFERENCES'), findsOneWidget);
      expect(find.text('75% COMPLETED'), findsOneWidget);

      await _walkThroughPreferencesPages(tester);

      // The last step: the green "100% complete" pill.
      expect(find.text('Aapne pehle kahan kaam kiya?'), findsOneWidget);
      expect(find.text('STEP 4 OF 4 • WORK HISTORY'), findsOneWidget);
      expect(find.text('100% complete'), findsOneWidget);
      expect(find.text('100% COMPLETED'), findsNothing);
    });

    testWidgets(
        'every option card renders a leading icon — multi, single, boolean '
        'and the marker lists', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => designForm());
      stubAnswers();

      await pump(tester);
      expect(find.byType(MultiSelectQuestionCard), findsOneWidget);
      expectEveryCardHasAnIcon(tester);
      await decline(tester);

      expect(find.text('Turning ka kitna experience hai?'), findsOneWidget);
      expect(find.byType(SingleSelectQuestionCard), findsNWidgets(2));
      expectEveryCardHasAnIcon(tester);
      await decline(tester);

      expect(find.text('Kya aap drawing padh sakte hain?'), findsOneWidget);
      expect(find.byType(SingleSelectQuestionCard), findsNWidgets(2)); // Haan/Nahi
      expectEveryCardHasAnIcon(tester);
      await decline(tester);

      // Preferences page 0 (languages, multi) ... page 2 (shift, single).
      expect(find.text('Hindi'), findsOneWidget);
      expectEveryCardHasAnIcon(tester);
      await next(tester);
      await next(tester);
      expect(find.text('Day'), findsOneWidget);
      expectEveryCardHasAnIcon(tester);
    });

    testWidgets('the multi-select hint appears on multi-select lists only',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => designForm());
      stubAnswers();

      await pump(tester);
      expect(find.text(_kMultiHint), findsOneWidget); // multi-select question
      await decline(tester);
      expect(find.text('Turning ka kitna experience hai?'), findsOneWidget);
      expect(find.text(_kMultiHint), findsNothing); // single-select
      await decline(tester);
      expect(find.text('Kya aap drawing padh sakte hain?'), findsOneWidget);
      expect(find.text(_kMultiHint), findsNothing); // boolean
      await decline(tester);

      expect(find.text('Hindi'), findsOneWidget);
      expect(find.text(_kMultiHint), findsOneWidget); // languages (multi)
      await next(tester);
      await next(tester);
      expect(find.text('Day'), findsOneWidget);
      expect(find.text(_kMultiHint), findsNothing); // shift (single)
    });

    testWidgets(
        'the searchable multi-select question shows the hint too, and its '
        'decline link reads "Pata nahi / Baad mein batayein"',
        (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => const TradeForm(
            kind: 'cnc_turner',
            packId: 'qp_cnc_turning',
            packVersion: 1,
            sections: <TradeFormSection>[
              TradeFormSection(
                id: 'capability',
                title: 'Machines, controllers & capability',
                screens: <TradeFormStep>[
                  TradeFormQuestionStep(
                      question: _searchableQuestion, searchable: true),
                ],
              ),
            ],
          ));

      await pump(tester);
      expect(find.text('Type karke dhoondein'), findsOneWidget);
      expect(find.text(_kMultiHint), findsOneWidget);
      expect(find.byType(FormDeclineLink), findsOneWidget);
      expect(find.text(_kDecline), findsOneWidget);
    });

    testWidgets(
        'no SpeechReader registered: no listen button on a question or a '
        'marker — never a dead button', (WidgetTester tester) async {
      when(() => repo.loadForm()).thenAnswer((_) async => designForm());
      stubAnswers();

      await pump(tester);
      expect(_bottomBar(tester).onListen, isNull);
      expect(find.byIcon(Icons.volume_up_outlined), findsNothing);

      await decline(tester);
      await decline(tester);
      await decline(tester);
      expect(find.text('Hindi'), findsOneWidget);
      expect(_bottomBar(tester).onListen, isNull);
      expect(find.byIcon(Icons.volume_up_outlined), findsNothing);
    });

    testWidgets(
        'SpeechReader registered: listen speaks the prompt (and why text), '
        'playback stops on submit, and a marker reads its page heading',
        (WidgetTester tester) async {
      final _FakeSpeechReader reader = _FakeSpeechReader();
      locator.registerSingleton<SpeechReader>(reader);
      when(() => repo.loadForm()).thenAnswer((_) async => designForm());
      stubAnswers();

      await pump(tester);
      expect(find.byIcon(Icons.volume_up_outlined), findsOneWidget);
      await tester.tap(find.byIcon(Icons.volume_up_outlined));
      await tester.pump();
      expect(reader.spoken, hasLength(1));
      expect(reader.spoken.single,
          contains('Aap kaunsi turning machine chalate hain?'));
      // The worker's own picks are never read aloud — only the question.
      expect(reader.spoken.single, isNot(contains('CNC lathe')));

      // Submitting stops any reading in flight.
      await tester.tap(find.text('CNC lathe'));
      await tester.pump();
      final int stopsBeforeSubmit = reader.stopCalls;
      await next(tester);
      expect(reader.stopCalls, greaterThan(stopsBeforeSubmit));

      // The why text is read after the prompt.
      expect(find.text('Turning ka kitna experience hai?'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.volume_up_outlined));
      await tester.pump();
      expect(reader.spoken.last, contains('Turning ka kitna experience hai?'));
      expect(reader.spoken.last,
          contains('Isse sahi level ka kaam dikhaya jaata hai.'));

      await decline(tester);
      await decline(tester);

      // A marker page reads its own visible heading.
      expect(find.text('Hindi'), findsOneWidget);
      expect(find.byIcon(Icons.volume_up_outlined), findsOneWidget);
      await tester.tap(find.byIcon(Icons.volume_up_outlined));
      await tester.pump();
      expect(reader.spoken.last, contains('Aap kaun si bhasha bolte hain?'));
    });

    testWidgets(
        'no overflow at 320x568 and 2.0 text scale — every question kind and '
        'a marker page', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1.0;
      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      // No SpeechReader registered: this checks the screen's own layout.
      when(() => repo.loadForm()).thenAnswer((_) async => designForm());
      stubAnswers();

      await pump(tester);
      expect(tester.takeException(), isNull);
      expect(find.text(_kMultiHint), findsOneWidget);
      await decline(tester);
      expect(tester.takeException(), isNull);
      await decline(tester);
      expect(tester.takeException(), isNull);
      await decline(tester);
      expect(find.text('Hindi'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await next(tester);
      await next(tester);
      expect(find.text('Day'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
