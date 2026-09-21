import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_document_view.dart';

/// #1578 — portfolio is UNPRINTED on the résumé by ruling: it has no zone on
/// the sheet, no card on the worker preview, and no region an employer copy
/// could leak. A dense document carrying every printable zone must still
/// render zero portfolio surface.
void main() {
  Future<void> pumpDoc(
    WidgetTester tester,
    TradeSheetResumeDocument document,
  ) async {
    GoogleFonts.config.allowRuntimeFetching = false;
    tester.view.physicalSize = const Size(1080, 3600);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: ResumeDocumentView(document: document),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  TradeSheetResumeDocument denseDoc() => const TradeSheetResumeDocument(
        header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
        trade: 'cnc_turner',
        sections: <ResumeDocumentSectionDto>[
          ResumeDocumentSectionDto(
            id: 'machines',
            title: 'Machines',
            chipRows: <ResumeListRowDto>[
              ResumeListRowDto(label: 'Machines', values: <String>['VMC']),
            ],
          ),
          ResumeDocumentSectionDto(
            id: 'skills',
            title: 'Skills',
            chipRows: <ResumeListRowDto>[
              ResumeListRowDto(
                  label: 'Skills', values: <String>['MIG welding']),
            ],
          ),
          ResumeDocumentSectionDto(
            id: 'documents',
            title: 'Documents ready',
            tickRows: <ResumeListRowDto>[
              ResumeListRowDto(label: 'Aadhaar', values: <String>['Yes']),
            ],
          ),
          ResumeDocumentSectionDto(
            id: 'qualifications',
            title: 'Qualifications',
            factRows: <ResumeFactRowDto>[
              ResumeFactRowDto(label: 'ITI', value: 'Machinist · 2018'),
            ],
          ),
          ResumeDocumentSectionDto(
            id: 'terms',
            title: 'Availability & terms',
            factRows: <ResumeFactRowDto>[
              ResumeFactRowDto(label: 'Shift', value: 'Day'),
            ],
          ),
        ],
        employments: <ResumeEmploymentDto>[
          ResumeEmploymentDto(employer: 'Acme', roleInline: 'Fitter'),
        ],
      );

  testWidgets('a dense sheet renders no portfolio region', (tester) async {
    await pumpDoc(tester, denseDoc());

    // Every zone above renders…
    expect(find.text('Machines'), findsWidgets);
    expect(find.text('Availability & terms'), findsOneWidget);
    // …but portfolio — which the server never sends — has no region at all:
    // no heading, no stub, no empty frame that could leak on an employer copy.
    expect(find.text('Portfolio'), findsNothing);
  });
}
