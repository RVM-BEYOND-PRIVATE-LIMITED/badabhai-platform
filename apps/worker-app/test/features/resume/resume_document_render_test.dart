import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chip.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_document_view.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

/// #1343 — the resume tab drawn from `GET /resume/document`.
///
/// Two things need proving, and they need two different rigs:
///  - [ResumeDocumentView] itself, pumped directly, for the `trade_sheet` row
///    styles (chips / ticks / facts) and the empty-zone display rule.
///  - The REAL [ResumePreviewScreen], with the cubit + repo wired through
///    `locator` (mirrors resume_preview_download_test.dart's rig), for the
///    format SWITCH: `document: null` and `format: "generic"` must both still
///    render through the UNCHANGED legacy text parser — [ResumeDocumentView]
///    only exists for `trade_sheet`, so that fallback can only be observed on
///    the real screen, not on the view in isolation.
void main() {
  group('ResumeDocumentView — trade_sheet row styles', () {
    Future<void> pumpView(
      WidgetTester tester,
      TradeSheetResumeDocument document,
    ) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: ResumeDocumentView(document: document),
          ),
        ),
      ));
    }

    testWidgets(
        'chipRows render as pills, tickRows as ✓ items, factRows as label: value',
        (WidgetTester tester) async {
      const TradeSheetResumeDocument document = TradeSheetResumeDocument(
        header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
        trade: 'cnc_turner',
        sections: <ResumeDocumentSectionDto>[
          ResumeDocumentSectionDto(
            id: 'capability',
            title: 'Capability',
            chipRows: <ResumeListRowDto>[
              ResumeListRowDto(
                label: 'Machines',
                values: <String>['CNC lathe', 'VMC'],
              ),
            ],
            tickRows: <ResumeListRowDto>[
              ResumeListRowDto(
                label: 'Setting',
                values: <String>['Tool offset'],
              ),
            ],
            factRows: <ResumeFactRowDto>[
              ResumeFactRowDto(label: 'Tolerance held', value: '±0.02 mm'),
            ],
          ),
        ],
      );
      await pumpView(tester, document);

      expect(find.text('Capability'), findsOneWidget);
      // chipRows -> pills (the shared BbChip, unselected/non-interactive).
      expect(find.widgetWithText(BbChip, 'CNC lathe'), findsOneWidget);
      expect(find.widgetWithText(BbChip, 'VMC'), findsOneWidget);
      // tickRows -> a check icon per value.
      expect(find.text('Tool offset'), findsOneWidget);
      expect(find.byIcon(Icons.check_circle_rounded), findsOneWidget);
      // factRows -> inline "label: value" (RichText — see _FactRow).
      expect(
        find.textContaining('Tolerance held: ±0.02 mm', findRichText: true),
        findsOneWidget,
      );
    });

    testWidgets(
        'an EMPTY section hides its heading; a populated section keeps its own',
        (WidgetTester tester) async {
      const TradeSheetResumeDocument document = TradeSheetResumeDocument(
        header: ResumeDocumentHeaderDto(),
        trade: 'cnc_turner',
        sections: <ResumeDocumentSectionDto>[
          ResumeDocumentSectionDto(
            id: 'capability',
            title: 'Capability',
            chipRows: <ResumeListRowDto>[
              ResumeListRowDto(label: 'Machines', values: <String>['CNC lathe']),
            ],
          ),
          // The server keeps this zone rather than dropping it — zero rows
          // across chipRows/tickRows/factRows.
          ResumeDocumentSectionDto(id: 'terms', title: 'Availability & terms'),
        ],
      );
      await pumpView(tester, document);

      expect(find.text('Capability'), findsOneWidget);
      expect(find.text('Availability & terms'), findsNothing);
    });
  });

  group('ResumePreviewScreen — format switch, never blank on document: null (#1343)', () {
    late MockResumeRepository repo;
    late MockResumeEditRepository editRepo;

    Future<void> pumpScreen(
      WidgetTester tester, {
      required ResumeDocument? document,
    }) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await locator.reset();
      repo = MockResumeRepository();
      editRepo = MockResumeEditRepository();
      when(() => editRepo.load()).thenAnswer(
        (_) async => const ResumeSafeFields(
          displayName: 'Suresh Yadav',
          showPhoto: false,
          nightShiftReady: false,
        ),
      );
      when(() => repo.loadResumeDocument()).thenAnswer((_) async => document);
      locator.registerFactory<ResumeCubit>(() => ResumeCubit(repo, editRepo));
      locator.registerLazySingleton<TabFocus>(() => TabFocus());
      locator.registerFactory<ResumeEditRepository>(() => editRepo);

      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: const ResumePreviewScreen(
          initialResume: 'Role: CNC Operator\nCurrent location: Faridabad',
        ),
      ));
      // showGenerated() emits `ready` with the text immediately, then a second
      // `ready` once the background document/night-shift fetch resolves.
      await tester.pump();
      await tester.pump();
    }

    tearDown(() => locator.reset());

    testWidgets(
        'document: null (the ordinary answer) falls back to the UNCHANGED '
        'legacy text rendering', (WidgetTester tester) async {
      await pumpScreen(tester, document: null);

      expect(find.text('General Info'), findsOneWidget);
      expect(find.byType(ResumeDocumentView), findsNothing);
    });

    testWidgets(
        'format: "generic" ALSO falls back to the UNCHANGED legacy text '
        'rendering — a non-CNC worker\'s tab is unchanged',
        (WidgetTester tester) async {
      await pumpScreen(
        tester,
        document: const GenericResumeDocument(
          header: ResumeDocumentHeaderDto(),
          headline: 'CNC Turner',
        ),
      );

      expect(find.text('General Info'), findsOneWidget);
      expect(find.byType(ResumeDocumentView), findsNothing);
    });

    testWidgets(
        'format: "trade_sheet" renders through ResumeDocumentView instead of '
        'the legacy text parser', (WidgetTester tester) async {
      const TradeSheetResumeDocument document = TradeSheetResumeDocument(
        header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
        trade: 'cnc_turner',
        headline: ResumeSheetHeadlineDto(line1: 'CNC Turner · 8 yrs · Fanuc'),
        sections: <ResumeDocumentSectionDto>[
          ResumeDocumentSectionDto(
            id: 'capability',
            title: 'Capability',
            chipRows: <ResumeListRowDto>[
              ResumeListRowDto(label: 'Machines', values: <String>['CNC lathe']),
            ],
          ),
        ],
      );
      await pumpScreen(tester, document: document);

      expect(find.byType(ResumeDocumentView), findsOneWidget);
      expect(find.text('CNC Turner · 8 yrs · Fanuc'), findsOneWidget);
      // The legacy renderer's own section title is gone — one document, one render.
      expect(find.text('General Info'), findsNothing);
    });
  });
}
