import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_menu.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_employment_page.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_work_dictation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../support/kit_matrix.dart';

/// #1516 — the Work History page offers unconfirmed résumé/chat jobs as
/// SEPARATE "Kya ye aapka kaam tha?" cards. Accepting one opens a new card the
/// worker still completes; nothing is sent until the page's own save; a
/// dismissal is local; and a job already on a card is never offered again.
const TradeFormEmploymentSuggestion _fromResume = TradeFormEmploymentSuggestion(
  source: TradeFormEmploymentSuggestionSource.resume,
  employerName: 'Sandhar Technologies',
  roleLabel: 'CNC Operator',
);

const TradeFormEmploymentSuggestion _fromChat = TradeFormEmploymentSuggestion(
  source: TradeFormEmploymentSuggestionSource.chat,
  roleLabel: 'VMC Setter',
  workDone: 'Job setting karte the',
);

/// A résumé row that stated the calendar years but no months (#2444/#2445).
const TradeFormEmploymentSuggestion _fromResumeDated =
    TradeFormEmploymentSuggestion(
  source: TradeFormEmploymentSuggestionSource.resume,
  employerName: 'Sandhar Technologies',
  roleLabel: 'CNC Operator',
  startYear: 2019,
  endYear: 2021,
  workDone: 'Parts banate the',
);

const TradeFormEmploymentEntry _savedJob = TradeFormEmploymentEntry(
  employerName: 'Acme',
  roleLabel: 'Fitter',
  startYm: '2019-01',
  endYm: '2020-01',
  stillWorking: false,
  workDone: 'Parts banate the',
);

class _Host {
  final GlobalKey<TradeFormEmploymentPageState> key =
      GlobalKey<TradeFormEmploymentPageState>();
  final List<List<TradeFormEmploymentEntry>> saves =
      <List<TradeFormEmploymentEntry>>[];
  int skips = 0;
  final List<(int, int)> pages = <(int, int)>[];

  Widget build({
    List<TradeFormEmploymentEntry>? entries,
    List<TradeFormEmploymentSuggestion> suggestions =
        const <TradeFormEmploymentSuggestion>[],
    TradeFormTierScope tierScope = TradeFormTierScope.unscoped,
    String? sectionKey,
  }) {
    return kitTestApp(
      Scaffold(
        body: SingleChildScrollView(
          child: TradeFormEmploymentPage(
            key: key,
            enabled: true,
            onSave: (List<TradeFormEmploymentEntry> e) =>
                saves.add(List<TradeFormEmploymentEntry>.of(e)),
            onSkip: () => skips++,
            onPageChanged: (int page, int count) => pages.add((page, count)),
            loadOptions: () async => const WorkPrefOptionsDto(
              languages: <String, String>{},
              documentsReady: <String, String>{},
              jobType: <String, String>{},
              shift: <String, String>{},
            ),
            initialEntries: entries,
            suggestions: suggestions,
            tierScope: tierScope,
            sectionKey: sectionKey,
          ),
        ),
      ),
    );
  }
}

String _fieldText(WidgetTester tester, int index) =>
    tester.widget<TextField>(find.byType(TextField).at(index)).controller!.text;

void main() {
  testWidgets('each suggestion is its own card, its source in plain words',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(suggestions: const <TradeFormEmploymentSuggestion>[
        _fromResume,
        _fromChat,
      ]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Kya ye aapka kaam tha?'), findsNWidgets(2));
    expect(find.text('Aapke resume se'), findsOneWidget);
    expect(find.text('Aapki chat se'), findsOneWidget);
    expect(find.text('CNC Operator'), findsOneWidget);
    expect(find.text('Sandhar Technologies'), findsOneWidget);
    expect(find.text('VMC Setter'), findsOneWidget);
    expect(find.text('Job setting karte the'), findsOneWidget);
    // Never a raw wire token.
    expect(find.text('resume'), findsNothing);
    expect(find.text('chat'), findsNothing);
    // A suggestion is not a saved card: no employer text fields yet.
    expect(find.byType(TextField), findsNothing);
    expect(find.text('Jodein'), findsNWidgets(2));
    expect(find.text('Aur ek jagah jodein'), findsOneWidget);
  });

  testWidgets('"Jodein" opens a NEW prefilled card and sends nothing',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        entries: const <TradeFormEmploymentEntry>[_savedJob],
        suggestions: const <TradeFormEmploymentSuggestion>[_fromResume],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Jodein'));
    await tester.pumpAndSettle();

    // Landed on the new (second) card, prefilled with what the résumé said.
    expect(host.pages.last, (1, 2));
    expect(_fieldText(tester, 0), 'Sandhar Technologies');
    expect(_fieldText(tester, 1), 'CNC Operator');
    // The suggestion card is gone — the job is now a card, never both.
    expect(find.text('Kya ye aapka kaam tha?'), findsNothing);
    expect(host.saves, isEmpty);
    expect(host.skips, 0);
  });

  testWidgets('a dated résumé suggestion prints its years on the card',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        suggestions: const <TradeFormEmploymentSuggestion>[_fromResumeDated],
      ),
    );
    await tester.pumpAndSettle();

    // Years the document stated, and nothing it did not: never "Jan 2019".
    expect(find.text('2019 – 2021'), findsOneWidget);
    expect(find.text('Jan 2019 – Jan 2021'), findsNothing);
  });

  testWidgets(
      'accepting a dated suggestion prefills the year and still asks the month',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        suggestions: const <TradeFormEmploymentSuggestion>[_fromResumeDated],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Jodein'));
    await tester.pumpAndSettle();

    // Both years are on the card, and BOTH months are still missing — the page
    // never prints a January it was not given.
    expect(find.text('2019 · mahina chunein'), findsOneWidget);
    expect(find.text('2021 · mahina chunein'), findsOneWidget);
    expect(find.text('Jan 2019'), findsNothing);
    expect(find.text('Jan 2021'), findsNothing);
    expect(
      host.key.currentState!.currentPageError(),
      'Kab shuru kiya — saal aur mahina chunein.',
    );

    // The picker opens on the suggested YEAR's month step, not the year list.
    await tester.tap(find.text('2019 · mahina chunein'));
    await tester.pumpAndSettle();
    expect(find.text('Mahina chunein · 2019'), findsOneWidget);
    await tester.tap(find.text('Mar'));
    await tester.pumpAndSettle();
    expect(find.text('Mar 2019'), findsOneWidget);

    // The end month is asked for next, on its own suggested year.
    await tester.tap(find.text('2021 · mahina chunein'));
    await tester.pumpAndSettle();
    expect(find.text('Mahina chunein · 2021'), findsOneWidget);
    await tester.tap(find.text('Feb'));
    await tester.pumpAndSettle();
    expect(find.text('Feb 2021'), findsOneWidget);

    host.key.currentState!.save();
    expect(host.saves, hasLength(1));
    final TradeFormEmploymentEntry saved = host.saves.single.single;
    expect(saved.startYm, '2019-03');
    expect(saved.endYm, '2021-02');
  });

  testWidgets('the year step can still be changed from the month step',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        suggestions: const <TradeFormEmploymentSuggestion>[_fromResumeDated],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Jodein'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('2019 · mahina chunein'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Saal badlein'));
    await tester.pumpAndSettle();
    expect(find.text('Saal chunein'), findsOneWidget);
  });

  testWidgets('a dateless suggestion keeps today\'s "Nahi bataya" date state',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        suggestions: const <TradeFormEmploymentSuggestion>[_fromResume],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Jodein'));
    await tester.pumpAndSettle();

    expect(find.text('Nahi bataya'), findsNWidgets(2));
    expect(find.textContaining('mahina chunein'), findsNothing);
  });

  testWidgets('an accepted chat suggestion still needs the company and dates',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(suggestions: const <TradeFormEmploymentSuggestion>[_fromChat]),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Jodein'));
    await tester.pumpAndSettle();

    expect(_fieldText(tester, 0), ''); // chat never carries a company
    expect(_fieldText(tester, 1), 'VMC Setter');
    expect(
      host.key.currentState!.currentPageError(),
      'Company ka naam likhein.',
    );

    await tester.enterText(find.byType(TextField).at(0), 'Acme');
    await tester.pump();
    // No month from either source: the page's own date rule asks for it.
    expect(
      host.key.currentState!.currentPageError(),
      'Kab shuru kiya — saal aur mahina chunein.',
    );
    // A suggestion never claims a current job: the switch starts OFF, so the
    // end month is asked for too.
    expect(find.text('Kab tak'), findsOneWidget);
  });

  testWidgets('the page save sends the accepted job with the stored ones',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        entries: const <TradeFormEmploymentEntry>[_savedJob],
        suggestions: const <TradeFormEmploymentSuggestion>[_fromResume],
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Jodein'));
    await tester.pumpAndSettle();
    host.key.currentState!.save();

    expect(host.saves, hasLength(1));
    expect(host.saves.single, hasLength(2));
    expect(host.saves.single.first, _savedJob);
    expect(host.saves.single.last.employerName, 'Sandhar Technologies');
    expect(host.saves.single.last.roleLabel, 'CNC Operator');
  });

  testWidgets('dismissing hides it for this visit and is not an edit',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(suggestions: const <TradeFormEmploymentSuggestion>[
        _fromResume,
        _fromChat,
      ]),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Ye sujhav hataayein').first);
    await tester.pumpAndSettle();

    expect(find.text('CNC Operator'), findsNothing);
    expect(find.text('VMC Setter'), findsOneWidget);

    // Nothing was added, edited or removed: an untouched, empty page still
    // SKIPS its whole-history replace rather than sending an empty list.
    host.key.currentState!.save();
    expect(host.skips, 1);
    expect(host.saves, isEmpty);
  });

  testWidgets('a suggestion already on a card is never offered again',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        entries: const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Sandhar Technologies',
            roleLabel: 'Cnc Operator',
            startYm: '2019-01',
            endYm: '2020-01',
            stillWorking: false,
            workDone: 'Parts banate the',
          ),
        ],
        suggestions: const <TradeFormEmploymentSuggestion>[
          _fromResume,
          _fromResume, // the server does not dedupe; an exact repeat is one job
          _fromChat,
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Kya ye aapka kaam tha?'), findsOneWidget);
    expect(find.text('VMC Setter'), findsOneWidget);
  });

  testWidgets('an added chat job stays hidden after the worker edits its role',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(suggestions: const <TradeFormEmploymentSuggestion>[_fromChat]),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Jodein'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(1), 'Senior VMC Setter');
    await tester.pumpAndSettle();

    expect(find.text('Kya ye aapka kaam tha?'), findsNothing);
  });

  testWidgets('not offered past the four-employer cap',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        entries: <TradeFormEmploymentEntry>[
          for (int i = 0; i < kTradeFormMaxEmployers; i++)
            _savedJob.copyWith(employerName: 'Co $i'),
        ],
        suggestions: const <TradeFormEmploymentSuggestion>[_fromChat],
      ),
    );
    await tester.pumpAndSettle();
    for (int i = 1; i < kTradeFormMaxEmployers; i++) {
      host.key.currentState!.goToNextPage();
    }
    await tester.pumpAndSettle();

    expect(host.key.currentState!.isLastPage, isTrue);
    expect(find.text('Kya ye aapka kaam tha?'), findsNothing);
  });

  testWidgets('not offered on a tier that does not ask for more jobs',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        entries: const <TradeFormEmploymentEntry>[_savedJob],
        suggestions: const <TradeFormEmploymentSuggestion>[_fromChat],
        tierScope: const TradeFormTierScope(
          hiddenFields: <String>{kTierFieldAdditionalEntries},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Kya ye aapka kaam tha?'), findsNothing);
    expect(find.text('Aur ek jagah jodein'), findsNothing);
  });

  // Regression (#easy-work-history): on Easy the scope hides
  // `additional_entries`, and the page used to gate the WHOLE add control on
  // that — so an Easy worker with no saved jobs got a title-only page and no way
  // to add even their CURRENT job. `additional_entries` hides jobs BEYOND the
  // current one, so the control must still render while the list is empty.
  testWidgets('the CURRENT job is still offered on Easy (empty list + hidden)',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        // No saved jobs, and the Easy scope hides `additional_entries`.
        tierScope: const TradeFormTierScope(
          hiddenFields: <String>{kTierFieldAdditionalEntries},
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Aur ek jagah jodein'), findsOneWidget);
    await tester.tap(find.text('Aur ek jagah jodein'));
    await tester.pumpAndSettle();

    // A card opened to enter the current job…
    expect(find.byType(TextField), findsWidgets);
    // …and Easy still asks for only the one current job, not a second.
    expect(find.text('Aur ek jagah jodein'), findsNothing);
  });

  testWidgets(
      'a second job needs the first one finished first '
      '(one open form at a time)', (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(host.build());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Aur ek jagah jodein'));
    await tester.pumpAndSettle();
    // Past the double-tap guard window, so only the incomplete-form rule can
    // block this.
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('Aur ek jagah jodein'));
    await tester.pumpAndSettle();

    // Second tap blocked: still on the first card, with "fill first".
    expect(
      find.text('Pehle ye form bharein — tabhi nayi jagah jod sakte hain.'),
      findsOneWidget,
    );
    expect(host.key.currentState!.pageCount, 1);
  });

  // ── #2220 — the Work History edit walk re-asks what the tier hides ─────────
  //
  // On Easy the scope hides `work_done` + `additional_entries`, so the plain
  // onboarding page draws neither the description box/mic nor the add control.
  // The edit walk (section walk `section_work_history`) must show BOTH: the
  // worker tapped this section precisely to change the description they cannot
  // see. The override is presentation-only — the tier policy is untouched.
  const TradeFormTierScope easyWorkHistory = TradeFormTierScope(
    hiddenFields: <String>{kTierFieldWorkDone, kTierFieldAdditionalEntries},
  );
  const String workLabel = 'Aap kya kaam karte the?';

  testWidgets(
      'the description box + mic are hidden on Easy without the edit walk',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        entries: const <TradeFormEmploymentEntry>[_savedJob],
        tierScope: easyWorkHistory,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text(workLabel), findsNothing);
    expect(find.byType(TradeFormWorkDictation), findsNothing);
  });

  testWidgets(
      'the Work History edit walk shows the description box + mic on Easy, '
      'prefilled, and offers "Aur ek jagah jodein"', (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        entries: const <TradeFormEmploymentEntry>[_savedJob],
        tierScope: easyWorkHistory,
        sectionKey: kResumeMenuWorkHistoryKey,
      ),
    );
    await tester.pumpAndSettle();

    // The box + the device mic the worker tapped to edit.
    expect(find.text(workLabel), findsOneWidget);
    expect(find.byType(TradeFormWorkDictation), findsOneWidget);
    // Prefilled with the stored description, not blank.
    expect(find.text('Parts banate the'), findsOneWidget);
    // The walk can add a past job (Easy hides it outside the walk).
    expect(find.text('Aur ek jagah jodein'), findsOneWidget);
  });

  testWidgets(
      'the edit walk re-arms the description requirement on a hidden tier',
      (WidgetTester tester) async {
    setKitSurface(tester, const Size(420, 2400));
    final _Host host = _Host();
    await tester.pumpWidget(
      host.build(
        // A used card with no description.
        entries: const <TradeFormEmploymentEntry>[
          TradeFormEmploymentEntry(
            employerName: 'Acme',
            roleLabel: 'Fitter',
            startYm: '2019-01',
            stillWorking: true,
          ),
        ],
        tierScope: easyWorkHistory,
        sectionKey: kResumeMenuWorkHistoryKey,
      ),
    );
    await tester.pumpAndSettle();

    expect(host.key.currentState!.currentPageError(),
        'Aap kya kaam karte the — likhein.');
  });
}
