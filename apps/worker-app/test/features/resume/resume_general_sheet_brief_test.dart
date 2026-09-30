import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_card_slots.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_profile_card.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_sections.dart';

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

  group('the facts carry it, on the road only', () {
    ResumeProfileFacts facts({String? brief, String? layout = 'bb_general'}) =>
        resolveProfileFacts(
          document: TradeSheetResumeDocument(
            header: const ResumeDocumentHeaderDto(name: 'Ramesh'),
            trade: 'trade',
            layout: layout,
            brief: brief,
            headline: const ResumeSheetHeadlineDto(
              line1: 'Lab Chemist',
              line2: 'Pune · Available now',
            ),
          ),
          parsed: const ParsedResume(isDraft: false, entries: <ResumeEntry>[]),
        );

    test('a general sheet carries the brief', () {
      expect(facts(brief: 'Lab chemist, 4 saal.').brief, 'Lab chemist, 4 saal.');
    });

    test('a TRADE sheet never does, even if the server sent one', () {
      // The guard is explicit rather than relying on the field being absent, so
      // a server that ever sent a brief on `bb_trade` could not put it on a
      // trade worker's card.
      expect(facts(brief: 'should not appear', layout: 'bb_trade').brief, isNull);
    });

    test('no brief is null, not an empty line', () {
      expect(facts().brief, isNull);
      expect(facts(brief: '   ').brief, isNull);
    });

    test('the general sheet still drops its subhead, and keeps the headline',
        () {
      final ResumeProfileFacts f = facts(brief: 'Lab chemist.');
      expect(f.subtitle, 'Lab Chemist');
      expect(f.secondLine, isNull, reason: '#1736 — no subhead on the road');
    });
  });

  group('the profile card draws it under the headline', () {
    Future<void> pumpCard(WidgetTester tester, ResumeProfileFacts f) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await tester.pumpWidget(MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: ResumeProfileCard(
              facts: f,
              actions: const SizedBox.shrink(),
              onEditReturned: (_) {},
            ),
          ),
        ),
      ));
      await tester.pump();
    }

    testWidgets('the brief renders', (WidgetTester t) async {
      await pumpCard(
        t,
        const ResumeProfileFacts(
          subtitle: 'Lab Chemist',
          brief: 'Lab chemist, 4 saal ka tajurba.',
        ),
      );
      expect(find.text('Lab chemist, 4 saal ka tajurba.'), findsOneWidget);
    });

    testWidgets('it sits UNDER the headline, as the PDF does',
        (WidgetTester t) async {
      await pumpCard(
        t,
        const ResumeProfileFacts(
          subtitle: 'Lab Chemist',
          brief: 'Lab chemist, 4 saal.',
        ),
      );
      final double headline = t.getTopLeft(find.text('Lab Chemist')).dy;
      final double brief = t.getTopLeft(find.text('Lab chemist, 4 saal.')).dy;
      expect(brief, greaterThan(headline));
    });

    testWidgets('no brief draws nothing at all', (WidgetTester t) async {
      await pumpCard(t, const ResumeProfileFacts(subtitle: 'CNC Turner'));
      expect(find.text(''), findsNothing);
    });

    testWidgets('a 160-code-point brief wraps rather than overflowing',
        (WidgetTester t) async {
      final String long = 'A' * 160;
      t.view.physicalSize = const Size(320 * 3, 568 * 3);
      t.view.devicePixelRatio = 3;
      addTearDown(t.view.resetPhysicalSize);
      addTearDown(t.view.resetDevicePixelRatio);
      await pumpCard(t, ResumeProfileFacts(subtitle: 'Lab Chemist', brief: long));
      expect(find.text(long), findsOneWidget);
      expect(t.takeException(), isNull);
    });
  });
}
