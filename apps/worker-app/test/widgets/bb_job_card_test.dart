import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_spacing.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_job_card.dart';

Widget _host(Widget child) => MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('BbJobCard', () {
    const BbJobCardData data = BbJobCardData(
      title: 'CNC Operator',
      company: 'Sharma Works',
      payBand: '22-28k',
      place: 'Pimpri',
      shift: 'Day',
      tags: <String>['Fanuc'],
      spotsLeft: 4,
    );

    testWidgets('renders title, company, pay, tag and the spots line',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.text('Sharma Works'), findsOneWidget);
      expect(find.text('22-28k'), findsOneWidget);
      expect(find.text('Fanuc'), findsOneWidget);
      expect(find.textContaining('spots'), findsOneWidget);
    });

    // `verified` now defaults to FALSE: the seal must be an explicit opt-in for
    // a REAL employer. It previously defaulted to true, so the card stamped a
    // green "verified" seal next to an employer name invented from
    // `jobId.hashCode`.
    testWidgets('shows the verified seal only when verified is explicitly true',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(data: data)));
      expect(find.byIcon(Icons.verified), findsNothing);

      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'CNC Operator',
          company: 'Sharma Works',
          verified: true,
          place: 'Pimpri',
        ),
      )));
      expect(find.byIcon(Icons.verified), findsOneWidget);
    });

    // The real feed carries no employer/pay/shift/tags — the card must simply
    // omit them rather than render an invented value.
    testWidgets('omits employer, pay, shift and tags when the feed has none',
        (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(title: 'CNC Operator', place: 'Pimpri, Pune'),
      )));

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(find.text('Pimpri, Pune'), findsOneWidget);
      expect(find.byIcon(Icons.currency_rupee), findsNothing);
      expect(find.byIcon(Icons.schedule), findsNothing);
      expect(find.byIcon(Icons.verified), findsNothing);
      expect(find.textContaining('spots'), findsNothing);
    });

    testWidgets('fires onTitleTap when the title is tapped', (tester) async {
      int taps = 0;
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () => taps++),
      ));

      await tester.tap(find.text('CNC Operator'));
      expect(taps, 1);
    });

    // #362 — in the deck this title is the ONLY route to the job detail (the pan
    // recognizer claims the rest of the card). It was a bare GestureDetector
    // around a ~26px text line, under the design system's 48px worker
    // touch-target floor, so a gloved tap landing just below the glyphs fell
    // through to the drag and merely wiggled the card.
    testWidgets('the title button meets the 48px worker touch-target floor',
        (tester) async {
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () {}),
      ));

      final Size size =
          tester.getSize(find.byKey(const Key('jobCardTitleButton')));
      expect(size.height, greaterThanOrEqualTo(AppSpacing.tap));
    });

    // #362 — a ripple needs a Material ANCESTOR to splash on; BbFestiveCard is a
    // plain DecoratedBox with an opaque fill, so the card carries its own
    // transparent Material or the ink paints underneath and is never seen.
    testWidgets('the title is an InkWell with a Material to ripple on',
        (tester) async {
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () {}),
      ));

      final Finder inkWell = find.byKey(const Key('jobCardTitleButton'));
      expect(inkWell, findsOneWidget);
      expect(tester.widget(inkWell), isA<InkWell>());
      expect(
        find.ancestor(of: inkWell, matching: find.byType(Material)),
        findsWidgets,
      );
      // A visible "this opens something" cue for a low-literacy worker.
      expect(find.byIcon(Icons.chevron_right), findsOneWidget);
    });

    // #362 — TalkBack heard the title as plain text: no button role, no hint
    // that it activates anything. It must now be ONE focusable button node
    // carrying both the job title and the Hinglish hint.
    testWidgets('the title exposes a button role and a spoken label',
        (tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(
        BbJobCard(data: data, onTitleTap: () {}),
      ));

      final SemanticsNode node =
          tester.getSemantics(find.byKey(const Key('jobCardTitleButton')));
      expect(node.label, contains(kJobCardTitleSemanticLabel));
      expect(node.label, contains('CNC Operator'));
      expect(node.getSemanticsData().flagsCollection.isButton, isTrue);
      expect(node.getSemanticsData().hasAction(SemanticsAction.tap), isTrue);
      handle.dispose();
    });

    // A static card (no callback) must stay inert — no button role, no chevron
    // promising a route that isn't wired.
    testWidgets('a card without onTitleTap renders a plain, inert title',
        (tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(const BbJobCard(data: data)));

      expect(find.byKey(const Key('jobCardTitleButton')), findsNothing);
      expect(find.byIcon(Icons.chevron_right), findsNothing);
      expect(find.bySemanticsLabel(kJobCardTitleSemanticLabel), findsNothing);
      handle.dispose();
    });

    testWidgets('omits the quota line when spotsLeft is null', (tester) async {
      await tester.pumpWidget(_host(const BbJobCard(
        data: BbJobCardData(
          title: 'Welder',
          company: 'Patel Fab',
          payBand: '18-24k',
          place: 'Bhosari',
          shift: 'Night',
        ),
      )));

      expect(find.textContaining('spots'), findsNothing);
    });
  });
}
