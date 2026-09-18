import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto, SessionFillDto, SessionFillEntryDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_repository.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/cubit/finishing_cubit.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/finishing_screen.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/widgets/finishing_controls.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/form_flow_parts.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/selection_cards.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_reader.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements FinishingRepository {}

/// Records what the screen asks the device voice to do.
class _FakeSpeech implements SpeechReader {
  final List<String> spoken = <String>[];
  int stops = 0;

  @override
  Future<void> speak(String text) async => spoken.add(text);

  @override
  Future<void> stop() async => stops++;
}

const WorkPrefOptionsDto _options = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi', 'english': 'English'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
);

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const WorkPreferences());
    registerFallbackValue(<EmploymentEntry>[]);
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(() => repo.loadOptions()).thenAnswer((_) async => _options);
    when(() => repo.loadSessionFill()).thenAnswer((_) async => null);
    when(() => repo.saveWorkPreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    locator.registerFactory<FinishingCubit>(() => FinishingCubit(repo));
  });

  tearDown(() => locator.reset());

  Future<GoRouter> pump(WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/finishing',
      routes: <RouteBase>[
        GoRoute(
            path: '/finishing', builder: (_, __) => const FinishingScreen()),
        GoRoute(
            path: '/building',
            builder: (_, __) => const Scaffold(body: Text('BUILDING'))),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    return router;
  }

  testWidgets('renders the language chips from the options endpoint',
      (WidgetTester tester) async {
    await pump(tester);
    expect(find.text('Hindi'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    // and the advance CTA
    expect(find.text('Aage badhein'), findsOneWidget);
  });

  testWidgets('Aage badhein advances to the next page', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tester.tap(find.text('Hindi')); // pick a language
    await tester.pump();
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
    // page 2 = documents, rendered from options.documents_ready
    expect(find.text('Aadhaar'), findsOneWidget);
  });

  testWidgets(
      'a shift the chat already recorded is not asked again; job type stays',
      (WidgetTester tester) async {
    locator.unregister<FinishingCubit>();
    locator.registerFactory<FinishingCubit>(() => FinishingCubit(
          repo,
          knownFacts: InMemoryKnownWorkerFactsStore(
              <WorkerFact>[WorkerFact.shift]),
        ));
    await pump(tester);
    // languages → documents → shift & job type
    for (int i = 0; i < 2; i++) {
      await tester.tap(find.text('Aage badhein'));
      await tester.pumpAndSettle();
    }

    expect(find.text('Permanent'), findsOneWidget);
    expect(find.text('Day'), findsNothing);
  });

  testWidgets('a load failure shows a retry', (WidgetTester tester) async {
    when(() => repo.loadOptions()).thenThrow(Exception('boom'));
    await pump(tester);
    expect(find.text('Dobara koshish karein'), findsWidgets);
  });

  // #1312 — salary is a BAND, not a free-text number.

  Future<void> advance(WidgetTester tester) async {
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
  }

  WorkPreferences lastSavedPrefs() {
    final List<dynamic> captured =
        verify(() => repo.saveWorkPreferences(captureAny())).captured;
    return captured.last as WorkPreferences;
  }

  testWidgets(
      'choosing a salary band sends its upper bound as salary_expected_max',
      (WidgetTester tester) async {
    await pump(tester);
    // languages → documents → shift/type → cities → SALARY (#1471: salary,
    // education and education-detail are three pages now, not one).
    for (int i = 0; i < 4; i++) {
      await advance(tester);
    }
    // The ₹15–20 hazaar band — its UPPER bound (20000) is what the wire carries.
    await tester.tap(find.text('₹15–20 hazaar'));
    await tester.pump();
    // salary → education → education detail → history, then finish
    for (int i = 0; i < 3; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, 20000);
    expect(prefs.toUpdateBody()['salary_expected_max'], 20000);
  });

  testWidgets('skipping the salary page sends no salary_expected_max key',
      (WidgetTester tester) async {
    await pump(tester);
    // Walk every page without touching the band picker, then submit.
    for (int i = 0; i < FinishingPage.values.length - 1; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, isNull);
    // The wire key must stay ABSENT (not 0) — the server field is optional.
    expect(prefs.toUpdateBody().containsKey('salary_expected_max'), isFalse);
  });

  // #1471 — the reported bug. "Salary aur padhai" put FIVE questions on one
  // page (salary band, credential, council, year, institute), so the worker had
  // to scroll a form they cannot read to reach the button. Three pages now, one
  // idea each, and each must FIT a real handset without scrolling.
  group('salary and padhai are three pages that fit (#1471)', () {
    // Fit is a question about the phone, so measure with the fonts the app
    // bundles (Anek Latin / Inter), not the test font, whose glyphs are far
    // wider — under it "Availability & terms" wraps the header to two lines
    // and the salary page scrolls 7dp that no device shows.
    setUpAll(() async {
      Future<void> load(String family, List<String> files) async {
        final FontLoader loader = FontLoader(family);
        for (final String f in files) {
          loader.addFont(rootBundle.load(f));
        }
        await loader.load();
      }

      await load('Anek Latin', <String>[
        'assets/fonts/AnekLatin-SemiBold.ttf',
        'assets/fonts/AnekLatin-Bold.ttf',
        'assets/fonts/AnekLatin-ExtraBold.ttf',
      ]);
      await load('Inter', <String>[
        'assets/fonts/Inter-Regular.ttf',
        'assets/fonts/Inter-Medium.ttf',
        'assets/fonts/Inter-SemiBold.ttf',
        'assets/fonts/Inter-Bold.ttf',
      ]);
    });

    /// Every page of the wizard, in order, with the reported handset's size.
    Future<void> pumpAtPage(WidgetTester tester, int page) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3.0; // 360 x 800 logical — a real phone
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await pump(tester);
      for (int i = 0; i < page; i++) {
        await advance(tester);
      }
    }

    /// The body scrolls only when its content is taller than its viewport.
    bool bodyOverflows(WidgetTester tester) {
      final ScrollableState sc = tester.state<ScrollableState>(
          find.byType(Scrollable).last);
      return sc.position.maxScrollExtent > 0;
    }

    testWidgets('the salary page asks ONLY the money question',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 4);

      expect(find.text('Mahine ki salary'), findsOneWidget); // headline
      expect(find.text('₹15–20 hazaar'), findsOneWidget);
      // The education questions have moved off this page entirely.
      expect(find.text('Agar ITI ya Diploma hai to kaun sa?'), findsNothing);
      expect(find.text('Council / board'), findsNothing);
      expect(find.text('Institute ka naam'), findsNothing);
      expect(bodyOverflows(tester), isFalse,
          reason: 'the salary page must not need scrolling');
    });

    testWidgets('the education page asks the two CHIP questions',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 5);

      expect(find.text('ITI ya Diploma'), findsOneWidget); // headline
      expect(find.text('Agar ITI ya Diploma hai to kaun sa?'), findsOneWidget);
      expect(find.text('Council / board'), findsOneWidget);
      // No money, no keyboard fields.
      expect(find.text('₹15–20 hazaar'), findsNothing);
      expect(find.text('Institute ka naam'), findsNothing);
      // HONEST RESIDUAL. `council` has EIGHT options. In the form-flow layout
      // the chrome (Shift Blue header + progress strip + docked bar) leaves
      // ~540dp of body on a 360x800 handset, and the question headline sits in
      // the body. The credential + council cards sit two per row there, each
      // stacking its icon tile above the title, so this page needs a short
      // flick: ~131dp measured with the bundled fonts. On a narrower phone or a
      // large font the cards fall back to one per row and the page scrolls
      // further.
      // It was FIVE questions deep before the split.
      // Bounded here so it cannot quietly grow again; removing the flick
      // entirely everywhere means either giving `council` its own page (four,
      // not three) or turning it into a picker, and both are the owner's call.
      final ScrollableState sc =
          tester.state<ScrollableState>(find.byType(Scrollable).last);
      expect(sc.position.maxScrollExtent, lessThan(200),
          reason: 'the education page must stay within one short flick');
    });

    testWidgets('the detail page holds the two TEXT fields, and only those',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 6);

      expect(find.text('Padhai ki detail'), findsOneWidget); // headline
      expect(find.text('Kis saal poora hua'), findsWidgets);
      expect(find.text('Institute ka naam'), findsWidgets);
      expect(find.text('₹15–20 hazaar'), findsNothing);
      expect(find.text('Council / board'), findsNothing);
      expect(bodyOverflows(tester), isFalse,
          reason: 'the education-detail page must not need scrolling');
    });

    // The master-kit header's STEP badge replaced the dot rail as the progress
    // indicator; it must still count all eight pages.
    testWidgets('the step badge counts all eight pages',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 4);
      expect(FinishingPage.values.length, 8);
      // The header renders the badge uppercase, followed by the page category
      // (form-flow mockups: "STEP 5 OF 6 • TOOLING & FIXTURES").
      expect(find.text('STEP 5 OF 8 • AVAILABILITY & TERMS'),
          findsOneWidget); // page index 4
    });

    testWidgets('every answer still reaches the wire from its new page',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 4);
      await tester.tap(find.text('₹15–20 hazaar')); // salary page
      await tester.pump();
      await advance(tester);
      await tester.tap(find.text('ITI')); // education page
      await tester.pump();
      await advance(tester);
      await tester.enterText(find.byType(TextField).first, '2018'); // detail
      await tester.pump();
      await advance(tester);
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final WorkPreferences prefs = lastSavedPrefs();
      expect(prefs.salaryExpectedMax, 20000);
      expect(prefs.educationCredential, isNotNull);
      expect(prefs.educationYear, 2018);
    });
  });

  // The form-flow mockups (14 Turning Operations, 15 Workholding, 16 Measuring
  // Instruments): step line with category, progress strip, an icon tile on
  // every option card, the multi-select hint, and the listen button.
  group('form-flow chrome (mockups 14/15/16)', () {
    Future<void> goToPage(WidgetTester tester, FinishingPage page) async {
      for (int i = 0; i < page.index; i++) {
        await advance(tester);
      }
    }

    testWidgets('every option card on every page renders a leading icon',
        (WidgetTester tester) async {
      await pump(tester);
      // Options per page: languages 2, documents 1, shift 1 + job type 1,
      // salary 6 bands, education 2 credentials + 8 councils.
      const Map<FinishingPage, int> expectedCards = <FinishingPage, int>{
        FinishingPage.languages: 2,
        FinishingPage.documents: 1,
        FinishingPage.shiftAndType: 2,
        FinishingPage.salary: 6,
        FinishingPage.education: 10,
      };
      for (final FinishingPage page in FinishingPage.values) {
        if (page.index > 0) await advance(tester);
        final List<MultiSelectQuestionCard> multi = tester
            .widgetList<MultiSelectQuestionCard>(
                find.byType(MultiSelectQuestionCard))
            .toList();
        final List<SingleSelectQuestionCard> single = tester
            .widgetList<SingleSelectQuestionCard>(
                find.byType(SingleSelectQuestionCard))
            .toList();
        final Finder grid = find.byType(FinishingGridOptionCard);
        expect(multi.length + single.length + grid.evaluate().length,
            expectedCards[page] ?? 0,
            reason: '$page option-card count');
        for (final MultiSelectQuestionCard c in multi) {
          expect(c.leadingIcon, isNotNull, reason: '$page "${c.title}"');
        }
        for (final SingleSelectQuestionCard c in single) {
          expect(c.leadingIcon, isNotNull, reason: '$page "${c.title}"');
        }
        for (final Element e in grid.evaluate()) {
          final FinishingGridOptionCard c = e.widget as FinishingGridOptionCard;
          // The tile really draws the glyph, not just carries it.
          expect(
              find.descendant(
                  of: find.byWidget(c), matching: find.byIcon(c.icon)),
              findsOneWidget,
              reason: '$page "${c.title}"');
        }
      }
    });

    testWidgets('the header step line carries the page category',
        (WidgetTester tester) async {
      await pump(tester);
      expect(find.text('STEP 1 OF 8 • LANGUAGES'), findsOneWidget);
      await goToPage(tester, FinishingPage.shiftAndType);
      expect(find.text('STEP 3 OF 8 • AVAILABILITY & TERMS'), findsOneWidget);
      await advance(tester); // cities
      expect(find.text('STEP 4 OF 8 • LOCATION'), findsOneWidget);
    });

    testWidgets('the progress strip shows the topic and the true percent',
        (WidgetTester tester) async {
      await pump(tester);
      expect(find.byType(FormProgressStrip), findsOneWidget);
      expect(find.text('LANGUAGES SPOKEN'), findsOneWidget);
      expect(find.text('13% COMPLETED'), findsOneWidget); // 1 of 8
      await goToPage(tester, FinishingPage.salary);
      expect(find.text('SALARY EXPECTATION'), findsOneWidget);
      expect(find.text('63% COMPLETED'), findsOneWidget); // 5 of 8
      // Last page: the green "100% complete" pill.
      for (int i = FinishingPage.salary.index;
          i < FinishingPage.history.index;
          i++) {
        await advance(tester);
      }
      expect(find.text('PAST JOBS'), findsOneWidget);
      expect(find.text('100% complete'), findsOneWidget);
    });

    testWidgets('the multi-select hint appears only on multi-select pages',
        (WidgetTester tester) async {
      const String hint = 'Multiple options select kar sakte hain';
      await pump(tester);
      expect(find.text(hint), findsOneWidget); // languages
      await advance(tester);
      expect(find.text(hint), findsOneWidget); // documents
      await advance(tester);
      expect(find.text(hint), findsNothing); // shift & job type: single
      await advance(tester);
      expect(find.text(hint), findsNothing); // cities
      await advance(tester);
      expect(find.text(hint), findsNothing); // salary: single
      await advance(tester);
      expect(find.text(hint), findsNothing); // education: single
    });

    testWidgets('no listen button when no SpeechReader is registered',
        (WidgetTester tester) async {
      await pump(tester);
      expect(find.byIcon(Icons.volume_up_outlined), findsNothing);
      expect(find.text('SUNIE'), findsNothing);
    });

    testWidgets('the listen button reads the page, and advancing stops it',
        (WidgetTester tester) async {
      final _FakeSpeech speech = _FakeSpeech();
      locator.registerSingleton<SpeechReader>(speech);
      await pump(tester);

      expect(find.byIcon(Icons.volume_up_outlined), findsOneWidget);
      await tester.tap(find.byIcon(Icons.volume_up_outlined));
      await tester.pump();
      expect(speech.spoken, hasLength(1));
      expect(speech.spoken.single, contains('Aap kaun si bhasha bolte hain?'));
      expect(speech.spoken.single, contains('Jitni bhasha aati hain, sab chunein.'));

      final int stopsBefore = speech.stops;
      await advance(tester);
      expect(speech.stops, greaterThan(stopsBefore),
          reason: 'next must silence the previous page');

      // Page two reads its own prompt.
      await tester.tap(find.byIcon(Icons.volume_up_outlined));
      await tester.pump();
      expect(speech.spoken.last, contains('Kaun se document taiyaar hain?'));

      // Back to the previous page also stops playback.
      final int stopsBeforeBack = speech.stops;
      await tester.tap(find.byTooltip('Wapas'));
      await tester.pumpAndSettle();
      expect(speech.stops, greaterThan(stopsBeforeBack));
    });

    testWidgets('no page overflows at 320x568 with a 2.0 text scale',
        (WidgetTester tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1.0;
      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      // No SpeechReader here on purpose: this checks the finishing layout.

      await pump(tester);
      expect(tester.takeException(), isNull, reason: 'languages');
      for (int i = 1; i < FinishingPage.values.length; i++) {
        await advance(tester);
        expect(tester.takeException(), isNull,
            reason: '${FinishingPage.values[i]}');
      }
      // The history page with an employer card open.
      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: 'history with a card');
    });
  });

  testWidgets('re-tapping the chosen band clears it (a real skip)',
      (WidgetTester tester) async {
    await pump(tester);
    for (int i = 0; i < 4; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('₹15–20 hazaar'));
    await tester.pump();
    // Tap the same band again — it deselects, so no salary is sent.
    await tester.tap(find.text('₹15–20 hazaar'));
    await tester.pump();
    for (int i = 0; i < 3; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, isNull);
    expect(prefs.toUpdateBody().containsKey('salary_expected_max'), isFalse);
  });

  /// #1575 — net-new-only rendering on the real screen.
  group('settled-vs-missing fill view', () {
  SessionFillDto fill({
    List<SessionFillEntryDto> entries = const <SessionFillEntryDto>[],
    List<String> settled = const <String>[],
  }) =>
      SessionFillDto(entries: entries, settled: settled);

  SessionFillEntryDto entry(
    String fact, {
    String status = 'answered',
    bool dropped = false,
  }) =>
      SessionFillEntryDto(
        fact: fact,
        questionKey: fact,
        status: status,
        source: 'chat',
        droppedByProjector: dropped,
        isCore: false,
      );

  testWidgets('a settled languages page never renders', (
    WidgetTester tester,
  ) async {
    when(() => repo.loadSessionFill()).thenAnswer((_) async => fill(
          settled: const <String>['languages'],
        ));
    await pump(tester);

    // The first page is documents now, not languages.
    expect(find.text('Hindi'), findsNothing);
    expect(find.text('Aadhaar'), findsOneWidget);
    expect(find.text('STEP 1 OF 7 • DOCUMENTS'), findsOneWidget);
  });

  testWidgets('an unanswered fact shows its phrasing on the page', (
    WidgetTester tester,
  ) async {
    when(() => repo.loadSessionFill()).thenAnswer((_) async => fill(
          entries: <SessionFillEntryDto>[
            entry('languages', status: 'unanswered'),
          ],
        ));
    await pump(tester);

    expect(find.text('Hindi'), findsOneWidget);
    expect(
      find.text('Ye sawaal pehle chhoot gaya tha — ab jawaab dein.'),
      findsOneWidget,
    );
  });

  testWidgets('a projector-dropped answer shows the re-add phrasing', (
    WidgetTester tester,
  ) async {
    when(() => repo.loadSessionFill()).thenAnswer((_) async => fill(
          entries: <SessionFillEntryDto>[
            entry('languages', status: 'missing', dropped: true),
          ],
        ));
    await pump(tester);

    expect(find.text('Hindi'), findsOneWidget);
    expect(
      find.text('Hum ye jawaab use nahi kar paaye — phir se jodein.'),
      findsOneWidget,
    );
  });
  });
}
