import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_general_sheet_view.dart';

/// #1796 — THE BRIEF ON THE GENERAL SHEET (ADR-0045 R6 §4.3).
///
/// The brief is the worker's own line, or a fixed line the server composed from
/// their role and years. It prints on both the worker and employer copies, so
/// the tab has to show it: this screen is the worker's only way to check what an
/// employer reads about them.
///
/// The model landed without any of this — `brief` was parsed and then never
/// drawn anywhere, and a whitespace-only value parsed to "" instead of null.
TradeSheetResumeDocument sheet({String? brief}) => TradeSheetResumeDocument(
      header: const ResumeDocumentHeaderDto(name: 'Ramesh'),
      trade: 'trade',
      layout: 'bb_general',
      brief: brief,
    );

Future<void> pump(WidgetTester tester, TradeSheetResumeDocument doc) =>
    tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: SingleChildScrollView(child: ResumeGeneralSheetView(document: doc)),
      ),
    ));

void main() {
  group('the parse treats absent, null and blank alike', () {
    TradeSheetResumeDocument parsed(Map<String, dynamic> extra) {
      final ResumeDocument d = ResumeDocument.fromJson(<String, dynamic>{
        'format': 'trade_sheet',
        'trade': 'trade',
        'layout': 'bb_general',
        'header': <String, dynamic>{'name': 'Ramesh'},
        ...extra,
      });
      return d as TradeSheetResumeDocument;
    }

    test('a real line is kept, trimmed', () {
      expect(parsed(<String, dynamic>{'brief': '  Cook with 4 years.  '}).brief,
          'Cook with 4 years.');
    });

    test('absent → null', () {
      expect(parsed(<String, dynamic>{}).brief, isNull);
    });

    test('null → null', () {
      expect(parsed(<String, dynamic>{'brief': null}).brief, isNull);
    });

    test('WHITESPACE-ONLY → null, not the empty string', () {
      // The acceptance box this closes. `isNotEmpty` before trimming let "  "
      // through as "", a third state the drawing code would have to know about.
      for (final String blank in <String>['  ', '\t', '\n', '']) {
        expect(parsed(<String, dynamic>{'brief': blank}).brief, isNull,
            reason: 'blank ${blank.codeUnits}');
      }
    });

    test('a non-string is ignored rather than thrown on', () {
      expect(parsed(<String, dynamic>{'brief': 42}).brief, isNull);
    });
  });

  group('the sheet draws it', () {
    testWidgets('a brief renders on the general sheet', (WidgetTester t) async {
      await pump(t, sheet(brief: 'Cook with 4 saal ka tajurba.'));
      expect(find.text('Cook with 4 saal ka tajurba.'), findsOneWidget);
    });

    testWidgets('no brief draws NOTHING — never a blank line or a stray gap',
        (WidgetTester t) async {
      await pump(t, sheet());
      // Nothing from the brief slot: the only Text widgets are the sheet's own,
      // and an empty string is never rendered.
      expect(find.text(''), findsNothing);
    });

    testWidgets('a 160-code-point brief does not overflow',
        (WidgetTester t) async {
      // The contract's ceiling. The sheet is a narrow column, so this is the
      // case that would clip or overflow if the line were unwrapped.
      final String long = 'A' * 160;
      t.view.physicalSize = const Size(320 * 3, 568 * 3);
      t.view.devicePixelRatio = 3;
      addTearDown(t.view.resetPhysicalSize);
      addTearDown(t.view.resetDevicePixelRatio);
      await pump(t, sheet(brief: long));
      expect(find.text(long), findsOneWidget);
      expect(t.takeException(), isNull);
    });
  });
}
