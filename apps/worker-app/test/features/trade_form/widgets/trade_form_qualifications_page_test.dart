import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_qualifications_page.dart';

/// #1465 — the last screen of the form ("Qualification, documents & languages")
/// could render a completely blank body under a full progress bar.
///
/// Certificates + education share ONE screen (each with its own heading, cards
/// and add button), so there is no empty screen to walk into at the very end
/// of the form.
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

  testWidgets('the single screen holds both sections — never a blank',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(tester);

    expect(key.currentState!.pageCount, 1);
    expect(key.currentState!.isLastPage, isTrue);
    expect(visibleThings(tester), greaterThan(0));

    // Both sections offer their own way in, on the same screen.
    expect(find.text('Koi certificate ya licence hai?'), findsOneWidget);
    expect(find.text('Aur ek certificate jodein'), findsOneWidget);
    expect(find.text('Padhai ya ITI ki jaankari'), findsOneWidget);
    expect(find.text('Aur ek entry jodein'), findsOneWidget);
  });

  // #1474 — the reported screenshot: TWO identical cards. The add button
  // appends a card BELOW the fold, so nothing appears to happen and a worker
  // on a cheap handset taps again — and both taps were honoured.
  testWidgets('a DOUBLE-TAP on "add another" adds ONE education, not two',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(tester);

    await tester.tap(find.text('Aur ek entry jodein'));
    await tester.tap(find.text('Aur ek entry jodein'));
    await tester.pump();

    // Still the single screen.
    expect(key.currentState!.pageCount, 1);
    // One card only — the credential prompt renders once per entry.
    expect(find.text('ITI ya Diploma?'), findsOneWidget,
        reason: 'a double-tap must not create a second education card');
  });

  testWidgets(
      'a second education needs the first one finished first '
      '(one open form at a time)', (WidgetTester tester) async {
    // The TapGuard must never block a worker who genuinely wants two entries —
    // but an unfinished first entry does: "fill this form first".
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(tester);

    await tester.tap(find.text('Aur ek entry jodein'));
    await tester.pump(const Duration(seconds: 1)); // past the guard window
    await tester.tap(find.text('Aur ek entry jodein'));
    await tester.pump();

    // Second tap blocked: still one card, with the "fill first" message.
    expect(find.text('ITI ya Diploma?'), findsOneWidget);
    expect(
      find.text('Pehle ye form bharein — tabhi nayi entry jod sakte hain.'),
      findsOneWidget,
    );

    // Finish the first entry (credential + subject + board + year + institute)
    // — then the same tap opens the second.
    await tester.tap(find.text('ITI'));
    await tester.pump();
    await tester.enterText(find.byType(TextField).first, 'Machinist');
    await tester.pump();
    await tester.tap(find.text('NIOS'));
    await tester.pump();
    // Year then institute.
    await tester.enterText(find.byType(TextField).at(1), '2018');
    await tester.enterText(find.byType(TextField).at(2), 'Govt ITI');
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('Aur ek entry jodein'));
    await tester.pump();

    expect(find.text('ITI ya Diploma?'), findsNWidgets(2));
  });

  testWidgets('adding an education keeps the single screen',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(tester);

    await tester.tap(find.text('Aur ek entry jodein'));
    await tester.pump();

    // Certificates + education share the one screen — no extra page comes back.
    expect(key.currentState!.pageCount, 1);
    expect(reported.last, <int>[0, 1]);
    expect(key.currentState!.isLastPage, isTrue);
  });

  testWidgets(
      'a second certificate needs the first one finished first '
      '(one open form at a time)', (WidgetTester tester) async {
    await pump(tester); // page 0 — certificates
    await tester.tap(find.text('Aur ek certificate jodein'));
    await tester.pump(const Duration(seconds: 1)); // past the guard window
    await tester.tap(find.text('Aur ek certificate jodein'));
    await tester.pump();

    // Second tap blocked: still one card, with the "fill first" message.
    expect(find.text('Certificate ka naam'), findsOneWidget);
    expect(
      find.text('Pehle ye form bharein — tabhi naya certificate jod sakte hain.'),
      findsOneWidget,
    );

    // Finish the first certificate — then the same tap opens the second.
    await tester.enterText(find.byType(TextField).at(0), 'ITI Certificate');
    await tester.enterText(find.byType(TextField).at(1), 'Govt ITI');
    await tester.enterText(find.byType(TextField).at(2), '2019');
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('Aur ek certificate jodein'));
    await tester.pump();

    expect(find.text('Certificate ka naam'), findsNWidgets(2));
  });

  testWidgets('both sections have content, with or without education',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
      ),
    );

    expect(key.currentState!.pageCount, 1);
    expect(visibleThings(tester), greaterThan(0));
    expect(find.text('Koi certificate ya licence hai?'), findsOneWidget);
    expect(find.text('Padhai ya ITI ki jaankari'), findsOneWidget);
  });

  // Regression for the ordering hazard the fix above removes: the controller
  // lists used to be `late final`, seeded from `_educations` whenever they
  // were first touched. `_removeEducation` replaces `_educations` FIRST, so a
  // list that no rendered sub-page had touched yet seeded itself from the
  // already-shortened list and the next `removeAt` threw a RangeError.
  testWidgets('removing an education is safe', (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
      ),
    );

    await tester.tap(find.byIcon(Icons.close).last);
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(key.currentState!.pageCount, 1);
    expect(reported.last, <int>[0, 1]);
  });

  // #1469 — found by an adversarial verification pass. The screen carried no
  // heading once, so while the options fetch was in flight its WHOLE body was
  // a bare spinner: no text, no field, no control, under a full progress bar.
  // That happens on every remount — walking BACK into an already-saved marker
  // refetches — and on 2G it is the reported blank screen.
  testWidgets('the screen is never blank while options are loading',
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
    expect(key.currentState, isNotNull);

    // Both headings ride the screen even while the options load, so no state
    // is a contextless body.
    expect(find.text('Koi certificate ya licence hai?'), findsOneWidget);
    expect(find.text('Padhai ya ITI ki jaankari'), findsOneWidget);
    expect(find.byType(Text), findsWidgets);
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

  testWidgets('removing the last education keeps the worker on a live page',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
      ),
    );
    expect(key.currentState!.isLastPage, isTrue);

    // Drop the only education while standing on the single screen.
    await tester.tap(find.byIcon(Icons.close).last);
    await tester.pump();

    expect(key.currentState!.pageCount, 1);
    expect(reported.last, <int>[0, 1]);
    expect(visibleThings(tester), greaterThan(0));
    expect(tester.takeException(), isNull);
  });

  // Two stacked unified cards still need to say which entry each belongs to:
  // each card names its entry ("Entry 1 — ITI, Machinist").
  testWidgets('two educations name their entry on the single screen',
      (WidgetTester tester) async {
    final GlobalKey<TradeFormQualificationsPageState> key = await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[
          TradeFormEducationEntry(credential: 'iti', field: 'Machinist'),
          TradeFormEducationEntry(credential: 'diploma', field: 'Electrician'),
        ],
      ),
    );
    expect(key.currentState!.pageCount, 1);

    expect(find.text('Entry 1 — ITI, Machinist'), findsOneWidget);
    expect(find.text('Entry 2 — Diploma, Electrician'), findsOneWidget);
    // Each repeated question renders once per entry, on the same screen.
    expect(find.text('Council / board'), findsNWidgets(2));
    expect(find.text('Kis saal poora hua'), findsNWidgets(2));
    expect(find.text('Kis subject me kiya'), findsNWidgets(2));
  });

  testWidgets('two certificates name their entry', (WidgetTester tester) async {
    await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[
          TradeFormCertificateEntry(name: 'FIRST'),
          TradeFormCertificateEntry(name: 'SECOND'),
        ],
        educations: <TradeFormEducationEntry>[],
      ),
    );
    expect(find.text('Certificate 1 — FIRST'), findsOneWidget);
    expect(find.text('Certificate 2 — SECOND'), findsOneWidget);
  });

  testWidgets('a lone blank entry gains no header noise',
      (WidgetTester tester) async {
    await pump(
      tester,
      initial: const TradeFormQualifications(
        certificates: <TradeFormCertificateEntry>[],
        educations: <TradeFormEducationEntry>[TradeFormEducationEntry()],
      ),
    );
    expect(find.textContaining('Entry'), findsNothing);
  });

  // ── A USED ROW MUST BE COMPLETE ───────────────────────────────────────────
  //
  // Only state/city may be left empty anywhere in the form. A certificate the
  // worker started needs all three of its fields, and an education needs every
  // field on its single page (the subject only when the credential names
  // one). A wholly-blank row is still skippable — it is dropped before the
  // write, so a worker with none is never forced to invent one.
  group('a used row must be complete', () {
    testWidgets('a used certificate needs a name, an issuer and a valid year',
        (WidgetTester tester) async {
      const String blocked = 'Sahi saal daalein — tabhi aage badh sakte hain.';

      // Blank row → skippable.
      GlobalKey<TradeFormQualificationsPageState> key = await pump(
        tester,
        initial: const TradeFormQualifications(
          certificates: <TradeFormCertificateEntry>[TradeFormCertificateEntry(name: '')],
        ),
      );
      expect(key.currentState!.currentPageError(), isNull);

      // Name only → issuer required.
      key = await pump(
        tester,
        initial: const TradeFormQualifications(
          certificates: <TradeFormCertificateEntry>[
            TradeFormCertificateEntry(name: 'ITI Certificate'),
          ],
        ),
      );
      expect(key.currentState!.currentPageError(), 'Kisne diya — likhein.');

      // Name + issuer → year required.
      key = await pump(
        tester,
        initial: const TradeFormQualifications(
          certificates: <TradeFormCertificateEntry>[
            TradeFormCertificateEntry(name: 'ITI Certificate', issuer: 'Govt ITI'),
          ],
        ),
      );
      expect(key.currentState!.currentPageError(), 'Kis saal mila — saal likhein.');

      // A year loaded from saved data that is out of range is refused too — the
      // inline field callback never fired for it.
      key = await pump(
        tester,
        initial: TradeFormQualifications(
          certificates: <TradeFormCertificateEntry>[
            TradeFormCertificateEntry(
              name: 'ITI Certificate',
              issuer: 'Govt ITI',
              year: DateTime.now().year + 1,
            ),
          ],
        ),
      );
      expect(key.currentState!.currentPageError(), blocked);

      // Complete → passes.
      key = await pump(
        tester,
        initial: const TradeFormQualifications(
          certificates: <TradeFormCertificateEntry>[
            TradeFormCertificateEntry(
              name: 'ITI Certificate',
              issuer: 'Govt ITI',
              year: 2019,
            ),
          ],
        ),
      );
      expect(key.currentState!.currentPageError(), isNull);
    });

    testWidgets('a used education needs every field on its single page',
        (WidgetTester tester) async {
      Future<GlobalKey<TradeFormQualificationsPageState>> pumpEdu(
        TradeFormEducationEntry entry,
      ) async {
        final GlobalKey<TradeFormQualificationsPageState> k = await pump(
          tester,
          initial: TradeFormQualifications(
            certificates: const <TradeFormCertificateEntry>[],
            educations: <TradeFormEducationEntry>[entry],
          ),
        );
        return k;
      }

      // Subject typed first, credential still unset → credential required.
      GlobalKey<TradeFormQualificationsPageState> key = await pumpEdu(
        const TradeFormEducationEntry(field: 'Machinist'),
      );
      expect(key.currentState!.currentPageError(), 'ITI ya Diploma — chunein.');

      // ITI names a subject, so it is required next.
      key = await pumpEdu(const TradeFormEducationEntry(credential: 'iti'));
      expect(
        key.currentState!.currentPageError(),
        'Kis subject me kiya — likhein.',
      );

      // Credential + subject → board required (same page, no extra screen).
      key = await pumpEdu(
        const TradeFormEducationEntry(credential: 'iti', field: 'Machinist'),
      );
      expect(key.currentState!.currentPageError(), 'Council ya board chunein.');

      // Council set → year required.
      key = await pumpEdu(const TradeFormEducationEntry(
        credential: 'iti',
        field: 'Machinist',
        council: 'nios',
      ));
      expect(
        key.currentState!.currentPageError(),
        'Kis saal poora hua — saal likhein.',
      );

      // Year only → institute required.
      key = await pumpEdu(const TradeFormEducationEntry(
        credential: 'iti',
        field: 'Machinist',
        council: 'nios',
        year: 2018,
      ));
      expect(
        key.currentState!.currentPageError(),
        'Institute ka naam likhein.',
      );

      // Fully complete → passes.
      key = await pumpEdu(const TradeFormEducationEntry(
        credential: 'iti',
        field: 'Machinist',
        council: 'nios',
        year: 2018,
        institute: 'Govt ITI',
      ));
      expect(key.currentState!.currentPageError(), isNull);
    });
  });
}
