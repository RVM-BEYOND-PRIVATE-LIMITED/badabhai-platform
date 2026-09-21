import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_card_slots.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_profile_card.dart';
import 'package:badabhai_worker_app/features/resume/presentation/widgets/resume_sections.dart';

/// #1577 — a role-less résumé omits the headline strip ENTIRELY: no
/// placeholder, no reserved gap, no client-side fallback text ("Worker",
/// "Profile", "—"). With a role, an unknown tenure prints as "duration not
/// stated" server-composed — the app must not rewrite it.
void main() {
  group('resolveProfileFacts role-less omission', () {
    test('trade sheet with null headline lines resolves to no strip', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          headline: ResumeSheetHeadlineDto(),
          sections: <ResumeDocumentSectionDto>[],
        ),
        parsed: parseResumeText(''),
      );

      expect(facts.subtitle, isNull);
      expect(facts.secondLine, isNull);
    });

    test('trade sheet with blank headline lines resolves to no strip', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: const TradeSheetResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          trade: 'cnc_turner',
          headline: ResumeSheetHeadlineDto(line1: '   ', line2: ''),
          sections: <ResumeDocumentSectionDto>[],
        ),
        parsed: parseResumeText(''),
      );

      expect(facts.subtitle, isNull);
      expect(facts.secondLine, isNull);
    });

    test('generic document with null headline resolves to no strip', () {
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: const GenericResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
        ),
        parsed: parseResumeText(''),
      );

      expect(facts.subtitle, isNull);
    });

    test('"duration not stated" passes through verbatim — never rewritten',
        () {
      const String strip = 'Welder · duration not stated';
      final ResumeProfileFacts facts = resolveProfileFacts(
        document: const GenericResumeDocument(
          header: ResumeDocumentHeaderDto(name: 'Suresh Yadav'),
          headline: strip,
        ),
        parsed: parseResumeText(''),
      );

      expect(facts.subtitle, strip);
    });
  });

  group('role-less profile card renders no strip region', () {
    Future<void> pumpCard(WidgetTester tester) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: const Scaffold(
            body: ResumeProfileCard(
              facts: ResumeProfileFacts(),
              actions: SizedBox.shrink(),
              onEditReturned: _noop,
            ),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('no headline text, no reserved gap, taps reveal nothing',
        (WidgetTester tester) async {
      await pumpCard(tester);

      // The card still renders its chrome (name row, actions slot)…
      expect(find.byType(ResumeProfileCard), findsOneWidget);
      // …but no strip text of any kind.
      expect(find.textContaining('·'), findsNothing);
      expect(find.text('Worker'), findsNothing);
      expect(find.text('Profile'), findsNothing);
      expect(find.text('—'), findsNothing);

      // A tap against the empty region opens no viewer and reveals nothing:
      // the strip is plain text, never a gesture.
      await tester.tap(find.byType(ResumeProfileCard));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.textContaining('·'), findsNothing);
    });
  });
}

void _noop(bool _) {}
