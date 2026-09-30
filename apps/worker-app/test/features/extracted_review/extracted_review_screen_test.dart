import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_select_chip.dart';
import 'package:badabhai_worker_app/features/extracted_review/domain/extracted_review.dart';
import 'package:badabhai_worker_app/features/extracted_review/domain/extracted_review_repository.dart';
import 'package:badabhai_worker_app/features/extracted_review/presentation/cubit/extracted_review_cubit.dart';
import 'package:badabhai_worker_app/features/extracted_review/presentation/extracted_review_screen.dart';

class MockExtractedReviewRepository extends Mock
    implements ExtractedReviewRepository {}

const ExtractedReview _review = ExtractedReview(
  skills: <String>['MIG Welding'],
  machines: <String>['Lathe'],
  experienceYears: 8,
  educations: <EducationEntryDto>[
    EducationEntryDto(credential: 'iti', field: 'Machinist', year: 2018),
  ],
  certificates: <CertificateEntryDto>[
    CertificateEntryDto(name: 'Safety', issuer: 'ITI', year: 2019),
  ],
  profileId: 'profile-1',
  sessionId: 'session-1',
);

const List<CatalogueOptionDto> _skillOptions = <CatalogueOptionDto>[
  CatalogueOptionDto(id: 'skill_fanuc', label: 'Fanuc control operation'),
  CatalogueOptionDto(id: 'skill_siemens', label: 'Siemens control operation'),
];

const List<CatalogueOptionDto> _machineOptions = <CatalogueOptionDto>[
  CatalogueOptionDto(id: 'mach_vmc', label: 'Vertical Machining Center (VMC)'),
];

Future<void> _pump(
  WidgetTester tester,
  MockExtractedReviewRepository repo, {
  ExtractedReview review = _review,
  Failure? skillFailure,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  when(() => repo.load()).thenAnswer((_) async => review);
  when(() => repo.loadQualificationOptions()).thenAnswer(
    (_) async => const QualificationOptionsDto(
      educationCredential: <String, String>{'iti': 'ITI'},
      educationCouncil: <String, String>{'ncvt': 'NCVT'},
    ),
  );
  if (skillFailure != null) {
    when(() => repo.loadSkillOptions()).thenThrow(skillFailure);
  } else {
    when(() => repo.loadSkillOptions()).thenAnswer((_) async => _skillOptions);
  }
  when(() => repo.loadMachineOptions())
      .thenAnswer((_) async => _machineOptions);
  locator.registerFactory<ExtractedReviewCubit>(
    () => ExtractedReviewCubit(repo),
  );
  // Tall frame: the review is a long ListView and lazy building would leave
  // the lower cards out of the tree entirely.
  tester.view.physicalSize = const Size(900, 6000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light(),
      home: const ExtractedReviewScreen(),
    ),
  );
  await tester.pump();
  await tester.pump();
  await tester.pump();
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets('renders every extracted section with its values (#1595)',
      (WidgetTester tester) async {
    final MockExtractedReviewRepository repo =
        MockExtractedReviewRepository();
    when(() => repo.submit(any())).thenAnswer(
      (_) async => (applied: 1, correctionCount: 1),
    );
    await _pump(tester, repo);

    expect(find.text('Hunar (skills)'), findsOneWidget);
    expect(find.text('MIG Welding'), findsOneWidget);
    expect(find.text('Machinein'), findsOneWidget);
    expect(find.text('Lathe'), findsOneWidget);
    expect(find.textContaining('8 saal'), findsOneWidget);
    // Lower cards build offstage in the ListView — still present, not visible.
    expect(find.textContaining('Machinist', skipOffstage: false),
        findsOneWidget);
    expect(
        find.textContaining('Safety', skipOffstage: false), findsOneWidget);
    // Correction affordances on the writable fields…
    expect(find.text('Anubhav sudhaarein'), findsOneWidget);
    expect(find.text('Taleem sudhaarein', skipOffstage: false),
        findsOneWidget);
    expect(find.text('Certificate sudhaarein', skipOffstage: false),
        findsOneWidget);
    expect(
        find.text('Profile pakki karein', skipOffstage: false),
        findsOneWidget);
  });

  testWidgets('editing experience sends one correction and confirms it',
      (WidgetTester tester) async {
    final MockExtractedReviewRepository repo =
        MockExtractedReviewRepository();
    when(() => repo.submit(any())).thenAnswer(
      (_) async => (applied: 1, correctionCount: 1),
    );
    await _pump(tester, repo);

    await tester.enterText(find.byType(TextField).first, '9');
    await tester.pump();
    await tester.ensureVisible(find.text('Anubhav sudhaarein'));
    await tester.pump();
    await tester.tap(find.text('Anubhav sudhaarein'));
    await tester.pump();
    await tester.pump();
    await tester.pump();

    final List<ExtractedCorrection> sent =
        verify(() => repo.submit(captureAny())).captured.single
            as List<ExtractedCorrection>;
    expect(sent.single, const ExperienceCorrection(9));
    expect(find.textContaining('sudhaar liya gaya'), findsOneWidget);
  });

  testWidgets('at the lifetime cap every affordance locks with the cap copy',
      (WidgetTester tester) async {
    final MockExtractedReviewRepository repo =
        MockExtractedReviewRepository();
    await _pump(
      tester,
      repo,
      review: _review.copyWith(correctionCount: 20),
    );

    expect(find.textContaining('seema poori'), findsWidgets);
    // Saves are disabled: tapping changes nothing, POSTs nothing.
    await tester.tap(find.text('Anubhav sudhaarein'));
    await tester.pump();
    verifyNever(() => repo.submit(any()));
  });

  testWidgets('unpinned 409 renders the deferral, never a spinner',
      (WidgetTester tester) async {
    final MockExtractedReviewRepository repo =
        MockExtractedReviewRepository();
    when(() => repo.submit(any())).thenThrow(ApiException(
      409,
      'no pin',
      body: <String, dynamic>{'message': '(unpinned_road_deferred)'},
    ));
    await _pump(tester, repo);

    await tester.enterText(find.byType(TextField).first, '9');
    await tester.pump();
    await tester.ensureVisible(find.text('Anubhav sudhaarein'));
    await tester.pump();
    await tester.tap(find.text('Anubhav sudhaarein'));
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('poora nahi hua'), findsOneWidget);
    verify(() => repo.submit(any())).called(1);
  });

  group('skills / machines pickers (#1596)', () {
    const ExtractedReview catalogueReview = ExtractedReview(
      skills: <String>['Fanuc control operation', 'MIG Welding'],
      machines: <String>['Vertical Machining Center (VMC)'],
      profileId: 'profile-1',
      sessionId: 'session-1',
    );

    bool selected(WidgetTester tester, String label) => tester
        .widget<KitSelectChip>(find.widgetWithText(KitSelectChip, label))
        .selected;

    testWidgets(
        'catalogue labels render as chips, current ones pre-ticked, '
        'unmatched ones warned; a tick saves catalogue ids',
        (WidgetTester tester) async {
      final MockExtractedReviewRepository repo =
          MockExtractedReviewRepository();
      when(() => repo.submit(any())).thenAnswer(
        (_) async => (applied: 1, correctionCount: 1),
      );
      await _pump(tester, repo, review: catalogueReview);

      expect(selected(tester, 'Fanuc control operation'), isTrue);
      expect(selected(tester, 'Siemens control operation'), isFalse);
      expect(selected(tester, 'Vertical Machining Center (VMC)'), isTrue);
      // The extracted label with no catalogue match is shown, and the worker
      // is told a save drops it — never silently, never guessed into an id.
      expect(find.text('MIG Welding'), findsOneWidget);
      expect(find.textContaining('hat jayenge'), findsOneWidget);
      // Ids never reach the screen.
      expect(find.textContaining('skill_'), findsNothing);
      expect(find.textContaining('mach_'), findsNothing);

      await tester.tap(find.text('Siemens control operation'));
      await tester.pump();
      expect(selected(tester, 'Siemens control operation'), isTrue);

      await tester.tap(find.text('Hunar sudhaarein'));
      await tester.pump();
      await tester.pump();
      await tester.pump();

      final List<ExtractedCorrection> sent =
          verify(() => repo.submit(captureAny())).captured.single
              as List<ExtractedCorrection>;
      expect(
        sent.single,
        const SkillsCorrection(<String>['skill_fanuc', 'skill_siemens']),
      );
      expect(find.textContaining('Hunar sudhaar liya gaya'), findsOneWidget);
    });

    testWidgets('an untouched, fully matched list has nothing to save',
        (WidgetTester tester) async {
      final MockExtractedReviewRepository repo =
          MockExtractedReviewRepository();
      await _pump(tester, repo, review: catalogueReview);

      await tester.tap(find.text('Machine sudhaarein'));
      await tester.pump();
      verifyNever(() => repo.submit(any()));
    });

    testWidgets(
        'an untouched list with unmatched labels offers no save — a no-edit '
        'tap can never drop them', (WidgetTester tester) async {
      final MockExtractedReviewRepository repo =
          MockExtractedReviewRepository();
      await _pump(tester, repo, review: catalogueReview);

      // 'MIG Welding' is unmatched and 'Fanuc…' pre-ticked: still no edit.
      expect(find.text('MIG Welding'), findsOneWidget);
      expect(
        tester
            .widget<BbButton>(find.widgetWithText(BbButton, 'Hunar sudhaarein'))
            .onPressed,
        isNull,
      );
      await tester.tap(find.text('Hunar sudhaarein'));
      await tester.pump();
      verifyNever(() => repo.submit(any()));

      // A real tick is what enables it.
      await tester.tap(find.text('Siemens control operation'));
      await tester.pump();
      expect(
        tester
            .widget<BbButton>(find.widgetWithText(BbButton, 'Hunar sudhaarein'))
            .onPressed,
        isNotNull,
      );
    });

    testWidgets(
        'a catalogue miss shows the real reason + retry, then the picker',
        (WidgetTester tester) async {
      final MockExtractedReviewRepository repo =
          MockExtractedReviewRepository();
      await _pump(
        tester,
        repo,
        review: catalogueReview,
        skillFailure: const ConsentRequiredFailure(),
      );

      expect(find.textContaining('Hunar ki list load nahi hui.'),
          findsOneWidget);
      expect(find.textContaining('consent dena hoga'), findsOneWidget);
      // Current labels stay visible — never a blank card.
      expect(find.text('Fanuc control operation'), findsOneWidget);
      expect(find.widgetWithText(KitSelectChip, 'Fanuc control operation'),
          findsNothing);
      // The rest of the review is unaffected.
      expect(find.text('Anubhav sudhaarein'), findsOneWidget);

      when(() => repo.loadSkillOptions())
          .thenAnswer((_) async => _skillOptions);
      await tester.tap(find.text('Dobara try karein'));
      await tester.pump();
      await tester.pump();

      expect(find.textContaining('Hunar ki list load nahi hui.'),
          findsNothing);
      expect(selected(tester, 'Fanuc control operation'), isTrue);
    });

    testWidgets('at the cap the pickers lock to read-only labels',
        (WidgetTester tester) async {
      final MockExtractedReviewRepository repo =
          MockExtractedReviewRepository();
      await _pump(
        tester,
        repo,
        review: catalogueReview.copyWith(correctionCount: 20),
      );

      expect(find.byType(KitSelectChip), findsNothing);
      expect(find.text('Fanuc control operation'), findsOneWidget);
      expect(find.text('Hunar sudhaarein'), findsNothing);
      verifyNever(() => repo.loadSkillOptions());
    });
  });
}
