// D13 — the Resume tab, and the safe-field editor behind it, across every
// shape a worker's phone actually is: 320x568 (the floor) up to a tablet and a
// phone on its side, at system font scales 1.0, 1.5 and 2.0.
//
// The app now RESPECTS the phone's font size (ruling R1): chrome clamps itself
// at 1.3, body copy scales the whole way and the page has to SCROLL rather than
// overflow. A worker who set their font to 200% because they cannot read 14pt
// is exactly the worker who most needs their resume.
//
// PASS means: nothing threw (a RenderFlex overflow surfaces as an exception),
// and the primary action is reachable — present, and scrolled to if the screen
// scrolls. A button that exists but sits forever below the fold is not a pass.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_card.dart';
import 'package:badabhai_worker_app/features/resume/domain/photo_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_edit_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_edit_screen.dart';

import '../../support/kit_matrix.dart';
import 'resume_document_fixtures.dart';
import 'resume_tab_harness.dart';

/// A fresher's sheet: TRAINING instead of a work history, and a rewritten
/// sentence with his own words behind the reveal (#1476/#1492).
const TradeSheetResumeDocument _fresherSheet = TradeSheetResumeDocument(
  header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
  trade: 'cnc_turner',
  headline: ResumeSheetHeadlineDto(line1: 'CNC Turner · fresher · ITI'),
  sections: <ResumeDocumentSectionDto>[
    ResumeDocumentSectionDto(
      id: 'capability',
      title: 'Machines, controllers & capability',
      chipRows: <ResumeListRowDto>[
        ResumeListRowDto(
          key: 'turning_machine',
          label: 'Machines',
          values: <String>['Conventional lathe'],
        ),
      ],
    ),
  ],
  experiences: <ResumeExperienceLineDto>[
    ResumeExperienceLineDto(
      role: 'ITI workshop training, Government ITI Faridabad',
      work: 'Completed workshop training with hands-on machine exposure.',
      workOwnWords: 'kuch nhi banaya, bas knowledge he mujhe',
      ownWordsKey: 'iti_project_work',
    ),
  ],
);

/// A `format: "generic"` document — a non-CNC worker, whose tab renders from
/// the flat fields plus the resume text (#1343).
const GenericResumeDocument _genericDoc = GenericResumeDocument(
  header: ResumeDocumentHeaderDto(name: 'Ramesh Kumar'),
  headline: 'Electrician',
  location: 'Faridabad',
  availability: 'Available now',
  experienceYears: 8,
  expectedSalary: 32000,
  skills: <String>['Wiring', 'Panel work'],
  controllers: <String>['Siemens'],
);

void main() {
  final ResumeTabHarness harness = ResumeTabHarness();

  tearDown(ResumeTabHarness.reset);

  /// The CTA a worker must always be able to reach on a ready resume.
  Finder download() => find.text('PDF download karein');

  group('ready — a full trade sheet with long real values', () {
    setUp(() async {
      // The FULL sheet, salary row included. It used to run without one
      // because `KitSalaryBox` overflowed a 412dp phone with a real range;
      // that box now measures its two texts and stacks when they do not both
      // fit, so the matrix covers the money box at every size again.
      await harness.wire(
        document: kTurnerSheet,
        renderStatus: 'rendered',
        profileConfirmed: false,
      );
    });

    kitMatrixTest(
      'the whole card stack',
      () => harness.screen,
      primary: download,
    );
  });

  group('ready — a fresher: training, and his own words behind the reveal', () {
    setUp(() async {
      await harness.wire(
        document: _fresherSheet,
        renderStatus: 'pending',
        profileConfirmed: true,
      );
    });

    kitMatrixTest(
      'the training block',
      () => harness.screen,
      primary: download,
    );

    // The reveal is a LOCAL toggle that has to be tapped, so this state gets
    // its own loop rather than `kitMatrixTest`'s: the tap has to land after
    // the scroll settles, and the assertion is that BOTH lines of the
    // comparison are on screen together at the same time.
    for (final Size size in kKitMatrixSizes) {
      for (final double scale in kKitMatrixTextScales) {
        testWidgets('the own-words comparison — ${size.width.toInt()}x'
            '${size.height.toInt()} @ ${scale}x', (WidgetTester tester) async {
          setKitSurface(tester, size);
          await tester.pumpWidget(kitTestApp(harness.screen, textScale: scale));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));

          // At a large font the training card starts below the fold — which
          // is exactly what the worker sees.
          final Finder link = find.text('Aapke apne shabdon mein dekhein');
          await tester.scrollUntilVisible(
            link,
            100,
            scrollable: find.byType(Scrollable).first,
          );
          // Let the ensureVisible animation land before tapping, or the tap
          // hits where the link WAS.
          await tester.pump(const Duration(milliseconds: 500));
          await tester.tap(link);
          await tester.pump(const Duration(milliseconds: 300));

          expect(
            find.text('kuch nhi banaya, bas knowledge he mujhe'),
            findsOneWidget,
            reason: 'his own sentence must be on screen once revealed',
          );
          expect(
            find.text(
              'Completed workshop training with hands-on machine exposure.',
            ),
            findsOneWidget,
            reason: 'both lines together ARE the comparison',
          );
          expect(tester.takeException(), isNull);

          await tester.pumpWidget(const SizedBox.shrink());
        });
      }
    }
  });

  group('ready — a generic document', () {
    setUp(() async {
      await harness.wire(
        document: _genericDoc,
        renderStatus: 'rendered',
        profileConfirmed: true,
      );
    });

    kitMatrixTest(
      'the flat-field path',
      () => harness.screen,
      primary: download,
    );
  });

  group('ready — the legacy text path (no structured document)', () {
    setUp(() async {
      await harness.wire(renderStatus: 'rendered', profileConfirmed: true);
    });

    kitMatrixTest(
      'the parsed section cards',
      () => harness.screen,
      primary: download,
    );
  });

  group('the loader states', () {
    group('generating', () {
      setUp(() async {
        await harness.wire(resumeText: null, generateNeverResolves: true);
      });

      kitMatrixTest(
        'a loading tab keeps the header and says what is happening',
        () => harness.screen,
        primary: () => find.text('Your resume'),
      );
    });

    group('awaiting the structured document', () {
      setUp(() async {
        await harness.wire(
          documentNeverResolves: true,
          renderStatus: 'pending',
        );
      });

      kitMatrixTest(
        'the form-first worker\'s wait',
        () => harness.screen,
        primary: () => find.text('Resume taiyaar ho raha hai…'),
      );
    });
  });

  group('the dead ends a worker can act on', () {
    group('noProfile', () {
      setUp(() async {
        await harness.wire(
          resumeText: null,
          generateThrows: const ProfileIncompleteFailure(),
        );
      });

      kitMatrixTest(
        'the profile nudge stays reachable',
        () => harness.screen,
        primary: () => find.text('Profile poora karein'),
      );
    });

    group('failed', () {
      setUp(() async {
        await harness.wire(
          resumeText: null,
          generateThrows: const ServerFailure(500),
        );
      });

      kitMatrixTest(
        'Try again stays reachable',
        () => harness.screen,
        primary: () => find.text('Try again'),
      );
    });
  });

  group('the tablet cap and the touch floor', () {
    setUp(() async {
      await harness.wire(
        document: kTurnerSheet,
        renderStatus: 'rendered',
        profileConfirmed: false,
      );
    });

    testWidgets('on a tablet the cards STOP at 600 instead of stretching '
        'across the glass', (WidgetTester tester) async {
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(kitTestApp(harness.screen));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      final Finder cards = find.byType(KitCard);
      expect(cards, findsWidgets);
      for (final Element card in cards.evaluate()) {
        expect(
          tester.getSize(find.byWidget(card.widget)).width,
          lessThanOrEqualTo(OnboardingLayout.maxTabContentWidth),
          reason: 'a card stretched past the content cap on a tablet',
        );
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('every control on a ready resume clears the 48dp worker touch '
        'floor', (WidgetTester tester) async {
      setKitSurface(tester, const Size(360, 640));
      await tester.pumpWidget(kitTestApp(harness.screen));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      await expectKitTapTargets(tester);
    });
  });

  // The editor behind the profile card's 'Edit' — the one screen in this
  // package with a text field, so the one that has to survive a keyboard.
  group('the safe-field editor', () {
    late MockResumeEditRepository editRepo;

    Future<void> wireEditor({bool loadThrows = false}) async {
      await locator.reset();
      editRepo = MockResumeEditRepository();
      final MockPhotoRepository photos = MockPhotoRepository();
      if (loadThrows) {
        when(() => editRepo.load()).thenThrow(const NetworkFailure());
      } else {
        when(() => editRepo.load()).thenAnswer(
          (_) async => const ResumeSafeFields(
            displayName: 'Suresh Yadav',
            showPhoto: true,
            hasPhoto: false,
            nightShiftReady: true,
          ),
        );
      }
      when(() => photos.photoUrl()).thenAnswer((_) async => null);
      locator.registerFactory<ResumeEditCubit>(
        () => ResumeEditCubit(editRepo, photos),
      );
      locator.registerFactory<ResumeEditRepository>(() => editRepo);
      locator.registerFactory<PhotoRepository>(() => photos);
    }

    group('ready', () {
      setUp(() => wireEditor());

      kitMatrixTest(
        'the docked Save stays reachable at every size',
        () => const ResumeEditScreen(),
        primary: () => find.text('Save karein'),
      );
    });

    group('failed', () {
      setUp(() => wireEditor(loadThrows: true));

      kitMatrixTest(
        'a load failure says the real reason and offers a retry',
        () => const ResumeEditScreen(),
        primary: () => find.text('Try again'),
      );
    });

    testWidgets('on a tablet the FORM caps at 440 — a 1000px-wide text row is '
        'not a form', (WidgetTester tester) async {
      await wireEditor();
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(kitTestApp(const ResumeEditScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      final Finder card = find.byType(KitCard).first;
      expect(
        tester.getSize(card).width,
        lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('every control in the editor clears the 48dp touch floor', (
      WidgetTester tester,
    ) async {
      await wireEditor();
      setKitSurface(tester, const Size(360, 640));
      await tester.pumpWidget(kitTestApp(const ResumeEditScreen()));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      await expectKitTapTargets(tester);
    });

    testWidgets('the name dialog survives a KEYBOARD on the smallest screen '
        'at 200% font', (WidgetTester tester) async {
      await wireEditor();
      // The keyboard is set on the VIEW: a Scaffold strips viewInsets.bottom
      // from its body, so a MediaQuery-only keyboard is a state that never
      // occurs on a device.
      setKitSurface(tester, const Size(320, 568), keyboard: 320);
      await tester.pumpWidget(
        kitTestApp(const ResumeEditScreen(), textScale: 2.0),
      );
      await tester.pump();
      await tester.pump();

      // At 200% with the keyboard up there are barely 200dp of list left, so
      // the name row starts below the fold — exactly what the worker sees.
      await tester.scrollUntilVisible(
        find.text('Naam ki spelling'),
        100,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pump(const Duration(milliseconds: 500));
      await tester.tap(find.byIcon(Icons.edit_outlined));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      // The field is up, the actions are still on screen, nothing overflowed.
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('OK'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Cancel'));
      await tester.pump(const Duration(milliseconds: 400));
      expect(tester.takeException(), isNull);
    });
  });

  // ── Regression: the kit money box on the commonest Android width ──────────
  //
  // `KitSalaryBox` used to put its figure in the inflexible slot of a Row and
  // stack only below 300dp. A 412dp phone gives the box ~320dp, and a real
  // range ('₹24,000 – ₹28,000 / month') beside 'Expected Salary' overflowed it
  // by 65px in this test's font (~5px with the shipped faces). The box now
  // measures both texts and stacks when they do not both fit on one line.
  testWidgets('the money box survives a real salary RANGE on a 412dp phone', (
    WidgetTester tester,
  ) async {
    await harness.wire(
      document: kTurnerSheet,
      renderStatus: 'rendered',
      profileConfirmed: true,
    );
    setKitSurface(tester, const Size(412, 915));
    await tester.pumpWidget(kitTestApp(harness.screen));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('₹24,000 – ₹28,000 / month'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
