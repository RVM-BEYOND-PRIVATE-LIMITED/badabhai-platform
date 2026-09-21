// #1525 — the resume screen's PROFILE-ROAD switch.
//
// The wire's `source` is the profiling road (`form` | `chat` | null), distinct
// from `format` (`trade_sheet` | `generic`). Before this the screen switched on
// the FORMAT alone, which is keyed on "does this trade have an authored sheet"
// and not on the road — so a chat-road worker whose trade happened to have a
// sheet was shown the form road's trade-sheet cards.
//
// What must hold:
//   * chat source → the CHAT variant, even when `format == 'trade_sheet'`;
//   * form source → today's layout-by-format behaviour, unchanged;
//   * null source → today's layout-by-format behaviour, byte for byte (the
//     old-server fallback, which also keeps the `resume_text` parse working);
//   * no regression for form-road trade sheets or generic resumes.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_document_view.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_sections.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class MockProfileRepository extends Mock implements ProfileRepository {}

void main() {
  // The legacy `Label: value` template — what an old server hands off, and the
  // body the flat/generic path (and so the chat variant) renders from.
  const String legacyText = 'Role: CNC Operator\nCurrent location: Faridabad';

  // A trade sheet the way the server sends one: zoned rows, a trade-specific
  // card title.
  const TradeSheetResumeDocument turnerSheet = TradeSheetResumeDocument(
    header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
    trade: 'cnc_turner',
    headline: ResumeSheetHeadlineDto(line1: 'CNC Turner · 8 yrs · Fanuc'),
    sections: <ResumeDocumentSectionDto>[
      ResumeDocumentSectionDto(
        id: 'capability',
        title: 'Machines, controllers & capability',
        chipRows: <ResumeListRowDto>[
          ResumeListRowDto(label: 'Machines', values: <String>['CNC lathe']),
        ],
      ),
    ],
  );

  const GenericResumeDocument electricianDoc = GenericResumeDocument(
    header: ResumeDocumentHeaderDto(name: 'Ramesh Kumar'),
    headline: 'Electrician',
  );

  setUpAll(() {
    // Collapsed to a single attempt (matches the pre-retry behaviour exactly):
    // a real retry would leave a pending Timer past these fixed pump counts.
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;
  });
  tearDownAll(() {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
  });

  group('resumeRoadOf — the pure classifier', () {
    test('maps the two known roads and treats anything else as unknown', () {
      expect(resumeRoadOf(null), ResumeRoad.unknown);
      expect(
        resumeRoadOf(
          const GenericResumeDocument(header: ResumeDocumentHeaderDto()),
        ),
        ResumeRoad.unknown,
      );
      expect(
        resumeRoadOf(
          const GenericResumeDocument(
            header: ResumeDocumentHeaderDto(),
            source: 'chat',
          ),
        ),
        ResumeRoad.chat,
      );
      expect(
        resumeRoadOf(
          const GenericResumeDocument(
            header: ResumeDocumentHeaderDto(),
            source: 'form',
          ),
        ),
        ResumeRoad.form,
      );
    });
  });

  group('ResumePreviewScreen — the profile-road switch (#1525)', () {
    setUp(() {
      GoogleFonts.config.allowRuntimeFetching = false;
    });
    tearDown(() => locator.reset());

    Future<void> pumpScreen(
      WidgetTester tester, {
      required ResumeDocument? document,
    }) async {
      await locator.reset();
      final MockResumeRepository repo = MockResumeRepository();
      final MockResumeEditRepository editRepo = MockResumeEditRepository();
      when(() => editRepo.load()).thenAnswer(
        (_) async => const ResumeSafeFields(
          displayName: 'Suresh Yadav',
          showPhoto: false,
          nightShiftReady: false,
        ),
      );
      when(
        () => repo.loadResumeDocument(),
      ).thenAnswer((_) async => ResumeDocumentSnapshot(document: document));
      locator.registerFactory<ResumeCubit>(
        () => ResumeCubit(repo, editRepo, MockProfileRepository()),
      );
      locator.registerLazySingleton<TabFocus>(() => TabFocus());
      locator.registerFactory<ResumeEditRepository>(() => editRepo);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: const ResumePreviewScreen(initialResume: legacyText),
        ),
      );
      // showGenerated() emits `ready` immediately, then again once the
      // background document fetch resolves.
      await tester.pump();
      await tester.pump();
    }

    testWidgets(
      'chat source renders the CHAT variant — even when the format is '
      'trade_sheet — and never the trade sheet cards',
      (WidgetTester tester) async {
        await pumpScreen(
          tester,
          document: const TradeSheetResumeDocument(
            header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
            source: 'chat',
            trade: 'cnc_turner',
            headline: ResumeSheetHeadlineDto(line1: 'CNC Turner · 8 yrs'),
            sections: <ResumeDocumentSectionDto>[
              ResumeDocumentSectionDto(
                id: 'capability',
                title: 'Machines, controllers & capability',
                chipRows: <ResumeListRowDto>[
                  ResumeListRowDto(
                    label: 'Machines',
                    values: <String>['CNC lathe'],
                  ),
                ],
              ),
            ],
          ),
        );

        expect(find.byType(ChatResumeView), findsOneWidget);
        expect(find.text(kChatResumeHeading), findsOneWidget);
        // THE POINT OF THE ISSUE: the authored sheet is NOT drawn for the chat
        // road, even though the wire said `format: "trade_sheet"`.
        expect(find.byType(ResumeDocumentView), findsNothing);
        expect(find.text('Machines, controllers & capability'), findsNothing);
        // The flat body is still the worker's real content.
        expect(find.text('General Info'), findsOneWidget);
      },
    );

    testWidgets(
      'chat source on a generic document also gets the chat variant',
      (WidgetTester tester) async {
        await pumpScreen(
          tester,
          document: const GenericResumeDocument(
            header: ResumeDocumentHeaderDto(),
            source: 'chat',
            headline: 'Electrician',
          ),
        );

        expect(find.byType(ChatResumeView), findsOneWidget);
        expect(find.text(kChatResumeHeading), findsOneWidget);
        expect(find.byType(ResumeDocumentView), findsNothing);
        expect(find.text('General Info'), findsOneWidget);
      },
    );

    testWidgets(
      'null source (old server) keeps today\'s layout-by-format: a trade '
      'sheet still renders through ResumeDocumentView',
      (WidgetTester tester) async {
        await pumpScreen(tester, document: turnerSheet);

        expect(find.byType(ResumeDocumentView), findsOneWidget);
        expect(find.byType(ChatResumeView), findsNothing);
        expect(find.text('Machines, controllers & capability'), findsOneWidget);
      },
    );

    testWidgets(
      'null source with a generic document keeps the UNCHANGED legacy text '
      'rendering',
      (WidgetTester tester) async {
        await pumpScreen(tester, document: electricianDoc);

        expect(find.byType(ResumeSectionsView), findsOneWidget);
        expect(find.byType(ResumeDocumentView), findsNothing);
        expect(find.byType(ChatResumeView), findsNothing);
        expect(find.text('General Info'), findsOneWidget);
      },
    );

    testWidgets(
      'null document (no structured projection) still falls back to the '
      'legacy resume_text parse',
      (WidgetTester tester) async {
        await pumpScreen(tester, document: null);

        expect(find.byType(ResumeSectionsView), findsOneWidget);
        expect(find.byType(ResumeDocumentView), findsNothing);
        expect(find.byType(ChatResumeView), findsNothing);
        expect(find.text('General Info'), findsOneWidget);
      },
    );

    testWidgets('form source with a trade sheet is unchanged', (
      WidgetTester tester,
    ) async {
      await pumpScreen(
        tester,
        document: const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          source: 'form',
          trade: 'cnc_turner',
          headline: ResumeSheetHeadlineDto(line1: 'CNC Turner · 8 yrs'),
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'capability',
              title: 'Machines, controllers & capability',
              chipRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  label: 'Machines',
                  values: <String>['CNC lathe'],
                ),
              ],
            ),
          ],
        ),
      );

      expect(find.byType(ResumeDocumentView), findsOneWidget);
      expect(find.byType(ChatResumeView), findsNothing);
      expect(find.text('Machines, controllers & capability'), findsOneWidget);
    });

    testWidgets('form source with a generic document is unchanged', (
      WidgetTester tester,
    ) async {
      await pumpScreen(
        tester,
        document: const GenericResumeDocument(
          header: ResumeDocumentHeaderDto(),
          source: 'form',
          headline: 'Electrician',
        ),
      );

      expect(find.byType(ResumeSectionsView), findsOneWidget);
      expect(find.byType(ResumeDocumentView), findsNothing);
      expect(find.byType(ChatResumeView), findsNothing);
      expect(find.text('General Info'), findsOneWidget);
    });
  });
}
