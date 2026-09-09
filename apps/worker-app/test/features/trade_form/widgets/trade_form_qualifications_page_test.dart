import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_qualifications_page.dart';

/// #1465 — the last screen of the form ("Qualification, documents & languages")
/// could render a completely blank body under a full progress bar.
///
/// `pageCount` was a `static const 4`, so the wizard always walked four
/// sub-pages. But pages 2 (council) and 3 (year+institute) render one row PER
/// education entry and carry no heading and no "add" affordance of their own —
/// those live on page 1. A worker who added no education therefore walked into
/// two empty screens at the very end of the form.
void main() {
  const QualificationOptionsDto kOptions = QualificationOptionsDto(
    educationCredential: <String, String>{'iti': 'ITI', 'diploma': 'Diploma'},
    educationCouncil: <String, String>{'nios': 'NIOS'},
  );

  late List<List<int>> reported;

  Future<GlobalKey<TradeFormQualificationsPageState>> pump(
    WidgetTester tester, {
    TradeFormQualifications? initial,
  }) async {
    reported = <List<int>>[];
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final GlobalKey<TradeFormQualificationsPageState> key =
        GlobalKey<TradeFormQualificationsPageState>();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: TradeFormQualificationsPage(
            key: key,
            suggestedCertificates: const <String>[],
            enabled: true,
            loadOptions: () async => kOptions,
            onSave: (_) {},
            initialQualifications: initial,
            onPageChanged: (int p, int c) => reported.add(<int>[p, c]),
          ),
        ),
      ),
    ));
    await tester.pump(); // loadOptions resolves
    return key;
  }

  /// Anything a worker can actually read or touch on the current sub-page.
  int visibleThings(WidgetTester tester) =>
      find.byType(Text).evaluate().length +
      find.byType(TextField).evaluate().length;

  testWidgets('with NO education, the form ends after page 1 — never on a blank',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(tester);

    expect(key.currentState!.pageCount, 2);

    // Walk every page the wizard will actually show and prove each has content.
    for (int p = 0; p < key.currentState!.pageCount; p++) {
      expect(visibleThings(tester), greaterThan(0),
          reason: 'sub-page $p rendered nothing at all');
      if (p < key.currentState!.pageCount - 1) {
        key.currentState!.goToNextPage();
        await tester.pump();
      }
    }

    // Page 1 is the last one, and it still offers the way IN to education.
    expect(key.currentState!.isLastPage, isTrue);
    expect(find.text('Aur ek entry jodein'), findsOneWidget);
  });

  testWidgets('adding an education brings the two education pages back',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(tester);
    key.currentState!.goToNextPage(); // page 1 — where "add" lives
    await tester.pump();

    await tester.tap(find.text('Aur ek entry jodein'));
    await tester.pump();

    expect(key.currentState!.pageCount, 4);
    // The wizard footer must hear about it, or it keeps offering "Submit
    // karein" on what is no longer the last page.
    expect(reported.last, <int>[1, 4]);
    expect(key.currentState!.isLastPage, isFalse);
  });

  testWidgets('the pages that come back are not blank either',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
      ),
    );

    expect(key.currentState!.pageCount, 4);
    for (int p = 0; p < 4; p++) {
      expect(visibleThings(tester), greaterThan(0),
          reason: 'sub-page $p rendered nothing at all');
      if (p < 3) {
        key.currentState!.goToNextPage();
        await tester.pump();
      }
    }
  });

  // Regression for the ordering hazard the fix above removes: the controller
  // lists used to be `late final`, seeded from `_educations` whenever they
  // were first touched. `_removeEducation` replaces `_educations` FIRST, so a
  // list that no rendered sub-page had touched yet seeded itself from the
  // already-shortened list and the next `removeAt` threw a RangeError. Jumping
  // straight to the last sub-page without building the ones in between is the
  // cheapest way to reproduce that ordering.
  testWidgets('removing an education is safe even from a page that never '
      'rendered the other rows', (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
      ),
    );
    // No pump between the hops — pages 1 and 2 are never built.
    key.currentState!.goToNextPage();
    key.currentState!.goToNextPage();
    key.currentState!.goToNextPage();
    await tester.pump();

    await tester.tap(find.byIcon(Icons.close).last);
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(key.currentState!.pageCount, 2);
    expect(reported.last, <int>[1, 2]);
  });

  // #1469 — found by an adversarial verification pass. Pages 2 and 3 carried no
  // heading, so while the options fetch was in flight their WHOLE body was a
  // bare spinner: no text, no field, no control, under a full progress bar.
  // That happens on every remount — walking BACK into an already-saved marker
  // refetches — and on 2G it is the reported blank screen.
  testWidgets('education sub-pages are never blank while options are loading',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final GlobalKey<TradeFormQualificationsPageState> key =
        GlobalKey<TradeFormQualificationsPageState>();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(
          child: TradeFormQualificationsPage(
            key: key,
            suggestedCertificates: const <String>[],
            enabled: true,
            // Never resolves inside the test: the worker is on a slow network.
            loadOptions: () => Future<QualificationOptionsDto>.delayed(
                const Duration(seconds: 30), () => kOptions),
            onSave: (_) {},
            initialQualifications: const TradeFormQualifications(
              certificates: <TradeFormCertificateEntry>[],
              educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
            ),
          ),
        ),
      ),
    ));
    await tester.pump();

    for (int p = 0; p < 4; p++) {
      expect(find.byType(Text), findsWidgets,
          reason: 'sub-page $p is a contextless body while options load');
      if (p < 3) {
        key.currentState!.goToNextPage();
        await tester.pump();
      }
    }
    await tester.pump(const Duration(seconds: 31)); // let the fetch settle
  });

  // #1469 — certificate cards were keyed by POSITION, so removing card 0 of two
  // shifted the survivor onto key 0 and Flutter reused the DELETED card's
  // element: the worker deleted "FIRST" and watched it stay while "SECOND"
  // vanished, then saved the survivor under the wrong text.
  testWidgets('deleting a certificate keeps the RIGHT card, with its own text',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[
          TradeFormCertificateEntry(name: 'FIRST'),
          TradeFormCertificateEntry(name: 'SECOND'),
        ],
        educations: <TradeFormEducationEntry>[],
      ),
    );
    expect(key.currentState, isNotNull);

    List<String> fieldTexts() => tester
        .widgetList<TextField>(find.byType(TextField))
        .map((TextField f) => f.controller?.text ?? '')
        .toList();

    expect(fieldTexts(), contains('FIRST'));
    expect(fieldTexts(), contains('SECOND'));

    await tester.tap(find.byIcon(Icons.close).first); // delete FIRST
    await tester.pump();

    expect(fieldTexts(), contains('SECOND'));
    expect(fieldTexts(), isNot(contains('FIRST')));
  });

  testWidgets('removing the last education never strands the worker on a page '
      'that no longer exists', (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
      ),
    );
    // Pumped between each step — this is the walk a worker actually makes.
    for (int i = 0; i < 3; i++) {
      key.currentState!.goToNextPage();
      await tester.pump();
    }
    expect(key.currentState!.isLastPage, isTrue); // page 3 of 4

    // Drop the only education while standing on page 3.
    await tester.tap(find.byIcon(Icons.close).last);
    await tester.pump();

    expect(key.currentState!.pageCount, 2);
    expect(reported.last, <int>[1, 2]);
    expect(visibleThings(tester), greaterThan(0));
    expect(tester.takeException(), isNull);
  });
}
