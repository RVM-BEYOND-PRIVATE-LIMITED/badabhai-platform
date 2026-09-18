import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/nav/tab_focus.dart';
import 'package:badabhai_worker_app/core/theme/app_spacing.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_check_row.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_info_chip.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/resume/presentation/resume_preview_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_card_slots.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_document_view.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';

class MockResumeRepository extends Mock implements ResumeRepository {}

class MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class MockProfileRepository extends Mock implements ProfileRepository {}

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
  // #1475 — two employments were separated by roughly THREE gaps instead of
  // one: `_employmentsSection` spread its own SizedBox into the children list,
  // and `_SheetSectionShell` treats every child as a visual row and pads both
  // sides of it. Visible on the owner's sheet as a blank band between two
  // employers.
  // #1476 — a fresher has TRAINING instead of a work history, and the sheet did
  // not carry it at all: `experiences` was a field of the generic document
  // only. So his `iti_project_work` sentence printed on the PDF an employer
  // reads while his own tab showed nothing of it — the one person who can say
  // whether a sentence about his training is true never saw it.
  group('the fresher training zone, and his own words (#1476)', () {
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

    const String own =
        'Conventional lathe · Trade test passed · '
        'kuch nhi banaya, bas knowledge he mujhe';
    const String printed =
        'Conventional lathe · Trade test passed · '
        'Completed workshop training with hands-on machine exposure.';

    TradeSheetResumeDocument docWith(ResumeExperienceLineDto line) =>
        TradeSheetResumeDocument(
          header: const ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          experiences: <ResumeExperienceLineDto>[line],
        );

    testWidgets('the training block now RENDERS on the sheet', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        docWith(
          const ResumeExperienceLineDto(
            role: 'ITI workshop training',
            work: own,
          ),
        ),
      );

      expect(find.text('Training'), findsOneWidget);
      expect(find.text('ITI workshop training'), findsOneWidget);
      expect(find.text(own), findsOneWidget);
    });

    testWidgets('no rewrite ⇒ no reveal, no greyed placeholder', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        docWith(
          const ResumeExperienceLineDto(
            role: 'ITI workshop training',
            work: own,
          ),
        ),
      );

      expect(find.text('Aapke apne shabdon mein dekhein'), findsNothing);
    });

    testWidgets('a rewrite offers the reveal, and it shows his OWN line', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        docWith(
          const ResumeExperienceLineDto(
            role: 'ITI workshop training',
            work: printed,
            workOwnWords: own,
            ownWordsKey: 'iti_project_work',
          ),
        ),
      );

      // What the employer reads is on the page.
      expect(find.text(printed), findsOneWidget);
      // His own words are behind a deliberate tap, not shouted.
      expect(find.text(own), findsNothing);

      await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
      await tester.pump();

      expect(find.text('Aapke shabdon mein'), findsOneWidget);
      expect(find.text(own), findsOneWidget);
      // Both lines are visible together — that IS the comparison.
      expect(find.text(printed), findsOneWidget);
    });

    testWidgets('the reveal collapses again', (WidgetTester tester) async {
      await pumpDoc(
        tester,
        docWith(
          const ResumeExperienceLineDto(
            role: 'ITI workshop training',
            work: printed,
            workOwnWords: own,
            ownWordsKey: 'iti_project_work',
          ),
        ),
      );
      await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
      await tester.pump();
      await tester.tap(find.text('Likha hua version chhupayein'));
      await tester.pump();

      expect(find.text(own), findsNothing);
    });

    // #1492 — the refusal. #1476 shipped the reveal alone because there was no
    // route to call; migration 0103 and the answers text-source route landed,
    // so he can now act on the comparison instead of only looking at it.
    testWidgets('with a key, he can REFUSE the rewrite', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        docWith(
          const ResumeExperienceLineDto(
            role: 'ITI workshop training',
            work: printed,
            workOwnWords: own,
            ownWordsKey: 'iti_project_work',
          ),
        ),
      );
      await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
      await tester.pump();

      expect(find.text('Apne shabd rakhein'), findsOneWidget);
    });

    // The words and the address arrive together or not at all. A comparison
    // with no key is an impossible state — and if it ever happened, offering a
    // button with nowhere to send the refusal would be worse than offering
    // none, so the reveal stays and the button does not appear.
    testWidgets('a comparison with NO key reveals but offers no button', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        docWith(
          const ResumeExperienceLineDto(
            role: 'ITI workshop training',
            work: printed,
            workOwnWords: own,
          ),
        ),
      );

      expect(
        find.text('Aapke apne shabdon mein dekhein'),
        findsNothing,
        reason: 'no key means nothing to act on, so nothing is offered',
      );
    });

    testWidgets('a worker WITH employments gets no training zone', (
      WidgetTester tester,
    ) async {
      // The two are alternatives, never both.
      await pumpDoc(
        tester,
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          employments: <ResumeEmploymentDto>[
            ResumeEmploymentDto(
              id: 'emp-1',
              employer: 'RVM Cad',
              when: 'Jan 2023 – Present',
              work: 'Operates CNC lathe.',
            ),
          ],
        ),
      );

      expect(find.text('Work History'), findsOneWidget);
      expect(find.text('Training'), findsNothing);
    });

    testWidgets('the employment reveal still offers its keep button', (
      WidgetTester tester,
    ) async {
      // The shared panel went optional-button; the path that CAN persist must
      // not have lost it.
      await pumpDoc(
        tester,
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          employments: <ResumeEmploymentDto>[
            ResumeEmploymentDto(
              id: 'emp-1',
              employer: 'RVM Cad',
              when: 'Jan 2023 – Present',
              work: 'Operated CNC lathe delivering precision components.',
              workOwnWords: 'CNC lathe chalata tha',
            ),
          ],
        ),
      );
      await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
      await tester.pump();

      expect(find.text('Apne shabd rakhein'), findsOneWidget);
    });
  });

  group('the work-history zone spaces its entries ONCE (#1475)', () {
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

    const ResumeEmploymentDto first = ResumeEmploymentDto(
      id: 'emp-1',
      employer: 'RVM Cad',
      when: 'Jan 2023 – Present',
      work: 'Operates CNC lathe for precision turned parts.',
    );
    const ResumeEmploymentDto second = ResumeEmploymentDto(
      id: 'emp-2',
      employer: 'Sanaya Technology',
      when: 'Jan 2021 – Dec 2022',
      work: 'Ran milling machines on production batches.',
    );

    /// The blank band between the bottom of one employer block and the top of
    /// the next — measured, not counted.
    double gapBetweenEmployers(WidgetTester tester) {
      final Rect a = tester.getRect(find.text('RVM Cad'));
      final Rect b = tester.getRect(find.text('Sanaya Technology'));
      // The first entry's own rows sit under its employer line; measure from
      // the LAST thing in that entry to the next employer line.
      final Rect aWork = tester.getRect(
        find.text('Operates CNC lathe for precision turned parts.'),
      );
      expect(a.top, lessThan(b.top));
      return b.top - aWork.bottom;
    }

    testWidgets('two employments are ONE gap apart, not three', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          employments: <ResumeEmploymentDto>[first, second],
        ),
      );

      // One shell gap is AppSpacing.s3 (12). The bug rendered ~3x that plus
      // the entry's own internal padding, so a generous ceiling still fails
      // loudly on a regression while tolerating the entry's own trailing box.
      final double gap = gapBetweenEmployers(tester);
      expect(
        gap,
        lessThan(AppSpacing.s3 * 2.5),
        reason: 'work-history entries must not be triple-spaced',
      );
    });

    testWidgets('the section still hands the shell one child per visual row', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          employments: <ResumeEmploymentDto>[first, second],
          employmentsMore: '+2 aur',
        ),
      );

      // Everything still renders — the fix removed spacers, not content.
      expect(find.text('RVM Cad'), findsOneWidget);
      expect(find.text('Sanaya Technology'), findsOneWidget);
      expect(find.text('+2 aur'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a single employment renders with no trailing gap', (
      WidgetTester tester,
    ) async {
      await pumpDoc(
        tester,
        const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          employments: <ResumeEmploymentDto>[first],
        ),
      );

      expect(find.text('RVM Cad'), findsOneWidget);
      expect(find.text('Sanaya Technology'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('ResumeDocumentView — trade_sheet row styles', () {
    Future<void> pumpView(
      WidgetTester tester,
      TradeSheetResumeDocument document,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: ResumeDocumentView(document: document),
            ),
          ),
        ),
      );
    }

    testWidgets(
      'SHORT values pack into pills whatever the sheet said — chipRows AND '
      'tickRows — and factRows stay label: value',
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

        // These rows carry NO `key`, which is the pre-key document shape — so
        // none of them matches a v3 card slot and they all land in the
        // catch-all card, which takes the zone's own server title. Nothing is
        // dropped: that is the rule (see resume_card_slots.dart).
        expect(find.text('Capability'), findsOneWidget);
        // chipRows -> v3 fact chips.
        expect(find.widgetWithText(KitInfoChip, 'CNC lathe'), findsOneWidget);
        expect(find.widgetWithText(KitInfoChip, 'VMC'), findsOneWidget);
        // tickRows -> ALSO chips now. The sheet's tick styling is the PDF's
        // ink; 'Tool offset' is three words and does not need a row of its
        // own (see kChipValueMaxChars).
        expect(find.widgetWithText(KitInfoChip, 'Tool offset'), findsOneWidget);
        expect(find.byType(KitCheckRow), findsNothing);
        // …so no value on this card carries a ✓ nobody verified.
        expect(find.byIcon(Icons.check_rounded), findsNothing);
        // factRows -> inline "label: value" (RichText — see _FactRow).
        expect(
          find.textContaining('Tolerance held: ±0.02 mm', findRichText: true),
          findsOneWidget,
        );
      },
    );

    // ── The owner's complaint, and the two cases that keep rows ─────────────
    //
    // Every card used to draw a `tickRows` group as one full-width row per
    // value, so 'Measuring instruments: Micrometer, Vernier caliper' and
    // 'Documents ready: Aadhaar, PAN, UAN' each ate a stack of rows to print a
    // handful of words. The matrix is the default now; rows survive only where
    // a value genuinely cannot read as a chip.

    testWidgets(
      'a TICK-flagged group of short values renders the chip matrix — on the '
      'instrument card and on the qualification card alike',
      (WidgetTester tester) async {
        const TradeSheetResumeDocument document = TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'capability',
              title: 'Machines, controllers & capability',
              tickRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  key: 'measuring_tools',
                  label: 'Measuring instruments',
                  values: <String>['Micrometer', 'Vernier caliper', 'Gauge'],
                ),
                ResumeListRowDto(
                  key: 'setting_operation',
                  label: 'Setting',
                  values: <String>['Tool offset setting', 'Job centering'],
                ),
              ],
            ),
            ResumeDocumentSectionDto(
              id: 'qualifications',
              title: 'Qualification, documents & languages',
              tickRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  label: 'Documents ready',
                  values: <String>['Aadhaar', 'PAN', 'UAN'],
                ),
              ],
            ),
          ],
        );
        await pumpView(tester, document);

        for (final String value in <String>[
          'Micrometer',
          'Vernier caliper',
          'Gauge',
          'Tool offset setting',
          'Job centering',
          'Aadhaar',
          'PAN',
          'UAN',
        ]) {
          expect(
            find.widgetWithText(KitInfoChip, value),
            findsOneWidget,
            reason: '"$value" should pack into the chip matrix',
          );
        }
        // Not one of them kept a full-width row — and not one of them grew a
        // ✓ nobody verified.
        expect(find.byType(KitCheckRow), findsNothing);
        expect(find.byIcon(Icons.check_rounded), findsNothing);
      },
    );

    testWidgets(
      'a group whose values are long SENTENCES keeps full-width rows, because '
      'a chip would truncate them',
      (WidgetTester tester) async {
        // 33 and 60 characters: both past kChipValueMaxChars, so the whole
        // group falls back rather than half of it.
        const String long =
            'Reads 2D drawings and GD&T symbols on turned components';
        const TradeSheetResumeDocument document = TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'capability',
              title: 'Capability',
              chipRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  key: 'quality_work',
                  label: 'Inspection work',
                  values: <String>[long, 'Micrometer'],
                ),
              ],
            ),
          ],
        );
        await pumpView(tester, document);

        expect(long.length, greaterThan(kChipValueMaxChars));
        expect(find.widgetWithText(KitCheckRow, long), findsOneWidget);
        // The short value in the SAME group comes with it: half a group in
        // chips and half in rows would read as two kinds of data.
        expect(find.widgetWithText(KitCheckRow, 'Micrometer'), findsOneWidget);
        expect(find.byType(KitInfoChip), findsNothing);
      },
    );

    testWidgets(
      'CONTROLLERS KNOWN packs into the chip matrix like every other group '
      '(owner ruling 2026-09-16, over spec §4 rows)',
      (WidgetTester tester) async {
        const TradeSheetResumeDocument document = TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'capability',
              title: 'Machines, controllers & capability',
              chipRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  key: 'turning_machine',
                  label: 'Machines',
                  values: <String>['CNC lathe / turning centre'],
                ),
                ResumeListRowDto(
                  key: kControllerRowKey,
                  label: 'Controllers',
                  values: <String>['Fanuc Oi-TF', 'Siemens 828D'],
                ),
              ],
            ),
          ],
        );
        await pumpView(tester, document);

        // Short designations, so they pack several to a row exactly like the
        // machines above them and like OPERATIONS — no per-group exception.
        expect('Fanuc Oi-TF'.length, lessThan(kChipValueMaxChars));
        expect(find.text('CONTROLLERS KNOWN'), findsOneWidget);
        expect(find.widgetWithText(KitInfoChip, 'Fanuc Oi-TF'), findsOneWidget);
        expect(
          find.widgetWithText(KitInfoChip, 'Siemens 828D'),
          findsOneWidget,
        );
        expect(find.byType(KitCheckRow), findsNothing);
        // The machines above them still pack as the matrix.
        expect(
          find.widgetWithText(KitInfoChip, 'CNC lathe / turning centre'),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a controller designation too long for a chip still gets rows, so no '
      'value the worker gave us is ever truncated',
      (WidgetTester tester) async {
        const String long = 'Fanuc Series 0i-TF Plus with Manual Guide i';
        const TradeSheetResumeDocument document = TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'capability',
              title: 'Machines, controllers & capability',
              chipRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  key: kControllerRowKey,
                  label: 'Controllers',
                  values: <String>[long, 'Siemens 828D'],
                ),
              ],
            ),
          ],
        );
        await pumpView(tester, document);

        expect(long.length, greaterThan(kChipValueMaxChars));
        expect(find.widgetWithText(KitCheckRow, long), findsOneWidget);
        // The short one comes with it: half a group in chips and half in rows
        // would read as two kinds of data.
        expect(
          find.widgetWithText(KitCheckRow, 'Siemens 828D'),
          findsOneWidget,
        );
        expect(find.byType(KitInfoChip), findsNothing);
      },
    );

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
                ResumeListRowDto(
                  label: 'Machines',
                  values: <String>['CNC lathe'],
                ),
              ],
            ),
            // The server keeps this zone rather than dropping it — zero rows
            // across chipRows/tickRows/factRows.
            ResumeDocumentSectionDto(
              id: 'terms',
              title: 'Availability & terms',
            ),
          ],
        );
        await pumpView(tester, document);

        expect(find.text('Capability'), findsOneWidget);
        expect(find.text('Availability & terms'), findsNothing);
      },
    );

    testWidgets(
      'populated terms + qualifications zones draw with server titles and '
      'rows (#1587)',
      (WidgetTester tester) async {
        const TradeSheetResumeDocument document = TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(),
          trade: 'cnc_turner',
          sections: <ResumeDocumentSectionDto>[
            ResumeDocumentSectionDto(
              id: 'terms',
              title: 'Availability & terms',
              factRows: <ResumeFactRowDto>[
                ResumeFactRowDto(
                    label: 'Availability', value: 'Available now'),
                ResumeFactRowDto(label: 'Notice period', value: '15 days'),
              ],
            ),
            ResumeDocumentSectionDto(
              id: 'qualifications',
              title: 'Qualification, documents & languages',
              tickRows: <ResumeListRowDto>[
                ResumeListRowDto(
                  label: 'Documents ready',
                  values: <String>['Aadhaar', 'PAN'],
                ),
              ],
              factRows: <ResumeFactRowDto>[
                ResumeFactRowDto(
                    label: 'Education', value: 'ITI · Machinist · 2018'),
              ],
            ),
          ],
        );
        await pumpView(tester, document);

        expect(find.text('Availability & terms'), findsOneWidget);
        expect(
          find.textContaining('Availability: Available now',
              findRichText: true),
          findsOneWidget,
        );
        expect(
          find.textContaining('Notice period: 15 days', findRichText: true),
          findsOneWidget,
        );
        expect(
          find.text('Qualification, documents & languages'),
          findsOneWidget,
        );
        expect(find.widgetWithText(KitInfoChip, 'Aadhaar'), findsOneWidget);
        expect(find.widgetWithText(KitInfoChip, 'PAN'), findsOneWidget);
        expect(
          find.textContaining('Education: ITI · Machinist · 2018',
              findRichText: true),
          findsOneWidget,
        );
      },
    );
  });

  group(
    'ResumePreviewScreen — format switch, never blank on document: null (#1343)',
    () {
      // `document: null` is exercised deliberately below. Collapsed to a
      // single attempt (matches the pre-retry behaviour exactly) — a real
      // retry would leave a pending Timer past this file's fixed pump counts
      // and trip the widget-test binding's `!timersPending` assertion.
      setUpAll(() {
        ResumeCubit.documentPollMaxAttempts = 1;
        ResumeCubit.documentPollInterval = Duration.zero;
      });
      tearDownAll(() {
        ResumeCubit.documentPollMaxAttempts = 6;
        ResumeCubit.documentPollInterval = const Duration(seconds: 2);
      });

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
            home: const ResumePreviewScreen(
              initialResume: 'Role: CNC Operator\nCurrent location: Faridabad',
            ),
          ),
        );
        // showGenerated() emits `ready` with the text immediately, then a second
        // `ready` once the background document/night-shift fetch resolves.
        await tester.pump();
        await tester.pump();
      }

      tearDown(() => locator.reset());

      testWidgets(
        'document: null (the ordinary answer) falls back to the UNCHANGED '
        'legacy text rendering',
        (WidgetTester tester) async {
          await pumpScreen(tester, document: null);

          expect(find.text('General Info'), findsOneWidget);
          expect(find.byType(ResumeDocumentView), findsNothing);
        },
      );

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
        },
      );

      testWidgets(
        'format: "trade_sheet" renders through ResumeDocumentView instead of '
        'the legacy text parser',
        (WidgetTester tester) async {
          const TradeSheetResumeDocument document = TradeSheetResumeDocument(
            header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
            trade: 'cnc_turner',
            headline: ResumeSheetHeadlineDto(
              line1: 'CNC Turner · 8 yrs · Fanuc',
            ),
            sections: <ResumeDocumentSectionDto>[
              ResumeDocumentSectionDto(
                id: 'capability',
                title: 'Capability',
                chipRows: <ResumeListRowDto>[
                  ResumeListRowDto(
                    label: 'Machines',
                    values: <String>['CNC lathe'],
                  ),
                ],
              ),
            ],
          );
          await pumpScreen(tester, document: document);

          expect(find.byType(ResumeDocumentView), findsOneWidget);
          expect(find.text('CNC Turner · 8 yrs · Fanuc'), findsOneWidget);
          // The legacy renderer's own section title is gone — one document, one render.
          expect(find.text('General Info'), findsNothing);
        },
      );
    },
  );

  // #1353/#1354 — the reveal-then-choose affordance on ONE work-history entry
  // whose printed line was rewritten. `_EmploymentEntry` reads a real
  // `ResumeCubit` off `context.read` (for the write), so this rig mirrors the
  // PRODUCTION wiring in `resume_preview_screen.dart`: a real cubit over
  // mocked repos, with a `BlocBuilder` selecting `state.document` — a plain
  // `document:` prop (as group 1 above uses) cannot observe "the affordance
  // goes away after the choice", because that only happens once the cubit
  // re-fetches and the document actually changes.
  group('ResumeDocumentView — reveal-own-words affordance (#1353/#1354)', () {
    late MockResumeRepository repo;
    late MockResumeEditRepository editRepo;
    late ResumeCubit cubit;

    const ResumeEmploymentDto sameWords = ResumeEmploymentDto(
      id: 'emp-1',
      employer: 'Bharat Forge',
      when: 'Jan 2023 – Present',
      work: 'Operates CNC lathe for precision turned parts.',
      workOwnWords: 'Operates CNC lathe for precision turned parts.',
    );

    const ResumeEmploymentDto noOwnWords = ResumeEmploymentDto(
      id: 'emp-1',
      employer: 'Bharat Forge',
      when: 'Jan 2023 – Present',
      work: 'Operates CNC lathe for precision turned parts.',
    );

    const ResumeEmploymentDto rewritten = ResumeEmploymentDto(
      id: 'emp-1',
      employer: 'Bharat Forge',
      when: 'Jan 2023 – Present',
      work:
          'Operated CNC lathe delivering high-precision turned components '
          'across multiple product lines.',
      workOwnWords: 'CNC lathe chalata tha, thoda fitting bhi karta tha.',
    );

    TradeSheetResumeDocument documentWith(ResumeEmploymentDto employment) =>
        TradeSheetResumeDocument(
          header: const ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          employments: <ResumeEmploymentDto>[employment],
        );

    setUp(() {
      GoogleFonts.config.allowRuntimeFetching = false;
      repo = MockResumeRepository();
      editRepo = MockResumeEditRepository();
      when(() => editRepo.load()).thenAnswer(
        (_) async => const ResumeSafeFields(
          displayName: 'Suresh Yadav',
          showPhoto: false,
          nightShiftReady: false,
        ),
      );
    });

    /// Pumps the affordance through the SAME `BlocBuilder`-over-`ResumeCubit`
    /// wiring the real screen uses — the caller stubs `repo.loadResumeDocument`
    /// before calling this.
    Future<void> pumpDocument(WidgetTester tester) async {
      cubit = ResumeCubit(repo, editRepo, MockProfileRepository());
      addTearDown(cubit.close);
      await tester.pumpWidget(
        MaterialApp(
          home: BlocProvider<ResumeCubit>.value(
            value: cubit,
            child: Scaffold(
              body: BlocBuilder<ResumeCubit, ResumeState>(
                builder: (BuildContext context, ResumeState state) {
                  final ResumeDocument? document = state.document;
                  if (document is! TradeSheetResumeDocument) {
                    return const SizedBox.shrink();
                  }
                  return SingleChildScrollView(
                    child: ResumeDocumentView(document: document),
                  );
                },
              ),
            ),
          ),
        ),
      );
      await cubit.showGenerated('resume text');
      await tester.pump();
    }

    testWidgets('work_own_words EQUAL to work shows NO affordance at all', (
      WidgetTester tester,
    ) async {
      when(() => repo.loadResumeDocument()).thenAnswer(
        (_) async => ResumeDocumentSnapshot(document: documentWith(sameWords)),
      );
      await pumpDocument(tester);

      expect(find.text('Aapke apne shabdon mein dekhein'), findsNothing);
      expect(find.byType(BbButton), findsNothing);
    });

    testWidgets('work_own_words NULL shows NO affordance at all', (
      WidgetTester tester,
    ) async {
      when(() => repo.loadResumeDocument()).thenAnswer(
        (_) async => ResumeDocumentSnapshot(document: documentWith(noOwnWords)),
      );
      await pumpDocument(tester);

      expect(find.text('Aapke apne shabdon mein dekhein'), findsNothing);
      expect(find.byType(BbButton), findsNothing);
    });

    testWidgets(
      'a GENUINE rewrite shows the reveal link, and tapping it reveals the '
      'own-words text',
      (WidgetTester tester) async {
        when(() => repo.loadResumeDocument()).thenAnswer(
          (_) async =>
              ResumeDocumentSnapshot(document: documentWith(rewritten)),
        );
        await pumpDocument(tester);

        expect(find.text('Aapke apne shabdon mein dekhein'), findsOneWidget);
        expect(find.text(rewritten.workOwnWords!), findsNothing);

        await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
        await tester.pump();

        expect(find.text(rewritten.workOwnWords!), findsOneWidget);
        expect(find.text('Likha hua version chhupayein'), findsOneWidget);
        expect(
          find.widgetWithText(BbButton, 'Apne shabd rakhein'),
          findsOneWidget,
        );
      },
    );

    testWidgets('choosing "keep my own words" calls '
        'ResumeCubit.setEmploymentDescriptionSource(id, ownWords: true), and '
        'the reveal affordance goes away (nothing left to compare)', (
      WidgetTester tester,
    ) async {
      int loadCalls = 0;
      when(() => repo.loadResumeDocument()).thenAnswer((_) async {
        loadCalls++;
        // First load (showGenerated) serves the rewrite; the RELOAD after the
        // choice serves the server's post-choice document, where the printed
        // line now equals the worker's own words.
        return ResumeDocumentSnapshot(
          document: loadCalls == 1
              ? documentWith(rewritten)
              : documentWith(sameWords),
        );
      });
      when(
        () => repo.setEmploymentDescriptionSource(
          any(),
          ownWords: any(named: 'ownWords'),
        ),
      ).thenAnswer((_) async {});
      await pumpDocument(tester);

      await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
      await tester.pump();
      await tester.tap(find.widgetWithText(BbButton, 'Apne shabd rakhein'));
      await tester.pumpAndSettle();

      verify(
        () => repo.setEmploymentDescriptionSource('emp-1', ownWords: true),
      ).called(1);
      expect(find.text('Aapke apne shabdon mein dekhein'), findsNothing);
      expect(find.text('Likha hua version chhupayein'), findsNothing);
      expect(find.text(rewritten.workOwnWords!), findsNothing);
    });

    // #1492 — the FRESHER's refusal, tapped through the real screen so the
    // route is actually called. The reveal alone shipped in #1476; the button
    // had nowhere to send a refusal until migration 0103 and the answers
    // text-source route landed.
    testWidgets(
      'the fresher refusing his rewrite calls setAnswerTextSource with the '
      'key from the DOCUMENT, and the affordance then goes away',
      (WidgetTester tester) async {
        const ResumeExperienceLineDto
        rewrittenTraining = ResumeExperienceLineDto(
          role: 'ITI workshop training',
          work:
              'Conventional lathe · Completed workshop training with '
              'hands-on machine exposure.',
          workOwnWords:
              'Conventional lathe · kuch nhi banaya, bas knowledge he mujhe',
          ownWordsKey: 'iti_project_work',
        );
        // After the refusal the server has nothing left to compare, so BOTH
        // work_own_words and own_words_key drop out — symmetric with #1354.
        const ResumeExperienceLineDto refusedTraining = ResumeExperienceLineDto(
          role: 'ITI workshop training',
          work: 'Conventional lathe · kuch nhi banaya, bas knowledge he mujhe',
        );

        TradeSheetResumeDocument trainingDoc(ResumeExperienceLineDto line) =>
            TradeSheetResumeDocument(
              header: const ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
              trade: 'cnc_turner',
              experiences: <ResumeExperienceLineDto>[line],
            );

        int loadCalls = 0;
        when(() => repo.loadResumeDocument()).thenAnswer((_) async {
          loadCalls++;
          return ResumeDocumentSnapshot(
            document: loadCalls == 1
                ? trainingDoc(rewrittenTraining)
                : trainingDoc(refusedTraining),
          );
        });
        when(
          () =>
              repo.setAnswerTextSource(any(), ownWords: any(named: 'ownWords')),
        ).thenAnswer((_) async {});
        await pumpDocument(tester);

        await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
        await tester.pump();
        await tester.tap(find.widgetWithText(BbButton, 'Apne shabd rakhein'));
        await tester.pumpAndSettle();

        // The key comes from the DOCUMENT, never hardcoded — the server
        // allow-lists which answers may be re-sourced, and a rejected key is 400.
        verify(
          () => repo.setAnswerTextSource('iti_project_work', ownWords: true),
        ).called(1);
        // Nothing left to compare, so nothing left to offer.
        expect(find.text('Aapke apne shabdon mein dekhein'), findsNothing);
        expect(find.text('Apne shabd rakhein'), findsNothing);
      },
    );

    testWidgets('a failed refusal SURFACES, never looks like it worked', (
      WidgetTester tester,
    ) async {
      const ResumeExperienceLineDto rewrittenTraining = ResumeExperienceLineDto(
        role: 'ITI workshop training',
        work: 'Rewritten sentence for the employer.',
        workOwnWords: 'kuch nhi banaya, bas knowledge he mujhe',
        ownWordsKey: 'iti_project_work',
      );
      when(() => repo.loadResumeDocument()).thenAnswer(
        (_) async => const ResumeDocumentSnapshot(
          document: TradeSheetResumeDocument(
            header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
            trade: 'cnc_turner',
            experiences: <ResumeExperienceLineDto>[rewrittenTraining],
          ),
        ),
      );
      when(
        () => repo.setAnswerTextSource(any(), ownWords: any(named: 'ownWords')),
      ).thenThrow(const NetworkFailure());
      await pumpDocument(tester);

      await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
      await tester.pump();
      await tester.tap(find.widgetWithText(BbButton, 'Apne shabd rakhein'));
      await tester.pump();
      await tester.pump();

      expect(find.byType(SnackBar), findsOneWidget);
      // And the choice is still there to retry.
      expect(find.text('Apne shabd rakhein'), findsOneWidget);
    });

    testWidgets('the keep-own-words choice is EQUALLY WEIGHTED — .tonal, never '
        '.danger or any warning styling', (WidgetTester tester) async {
      when(() => repo.loadResumeDocument()).thenAnswer(
        (_) async => ResumeDocumentSnapshot(document: documentWith(rewritten)),
      );
      await pumpDocument(tester);

      await tester.tap(find.text('Aapke apne shabdon mein dekhein'));
      await tester.pump();

      final BbButton button = tester.widget<BbButton>(
        find.widgetWithText(BbButton, 'Apne shabd rakhein'),
      );
      expect(button.variant, BbButtonVariant.tonal);
      expect(button.variant, isNot(BbButtonVariant.danger));
    });
  });
}
